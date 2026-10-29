package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/teamdelivery"
	"github.com/pocketctl/pocketctl/internal/ws"
)

type teamAgentTeamsConfig struct {
	Installation    string
	OwnerUserID     int
	BridgeEndpoint  string
	BridgeTokenFile string
}

func teamAgentTeamsPrivateFile(path string, limit int64) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("agentteams_private_file_invalid")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > limit {
		return nil, errors.New("agentteams_private_file_invalid")
	}
	data, err := os.ReadFile(path)
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("agentteams_private_file_unavailable")
	}
	return data, nil
}

func startAgentTeams(ctx context.Context, relayURL, daemonID string, client *ws.Client, sm *session.SessionManager, grants *memorycontext.GrantClient, logger *slog.Logger) (func(), error) {
	path := strings.TrimSpace(os.Getenv("POCKETCTL_AGENTTEAMS_CONFIG"))
	if path == "" {
		return func() {}, nil
	}
	data, err := teamAgentTeamsPrivateFile(path, 16384)
	if err != nil {
		return nil, err
	}
	var cfg teamAgentTeamsConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&cfg) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("agentteams_configuration_invalid")
	}
	scope, err := session.AgentTeamsExecutionScope(relayURL, daemonID, cfg.OwnerUserID, cfg.Installation)
	if err != nil {
		return nil, err
	}
	home, err := config.HomeDir()
	if err != nil {
		return nil, err
	}
	// Both journals require explicit offline initialization. Missing daemon
	// storage must not silently create an empty log and replay old dispatches.
	journal, err := session.OpenAgentTeamsJournal(filepath.Join(home, ".pocketctl", "team-agentteams"), scope, cfg.Installation)
	if err != nil {
		return nil, err
	}
	ctx, stop := context.WithCancel(ctx)
	ready := false
	defer func() {
		if !ready {
			stop()
			journal.Close()
		}
	}()
	credential := func(ctx context.Context) (string, error) {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		token, err := teamAgentTeamsPrivateFile(cfg.BridgeTokenFile, 8192)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(token)), nil
	}
	bridge, err := session.NewAgentTeamsBridgeClient(cfg.BridgeEndpoint, cfg.Installation, credential, nil)
	if err != nil {
		return nil, err
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	caps, err := bridge.Capabilities(probe)
	cancel()
	if err != nil {
		return nil, err
	}
	if !caps.IdempotentSubmit || !caps.LookupByRequest || !caps.Cancellation || !caps.ArtifactExport || caps.AutomaticRetry {
		return nil, session.ErrExternalCapability
	}
	api, err := teamdelivery.NewClient(relayURL, client.AccessToken, client.RelayHTTPClient())
	if err != nil {
		return nil, err
	}
	var prepareInputs func(context.Context, *protocol.CollaborationAuthorization, *protocol.CollaborationContext, string) ([]session.AgentTeamsInputFile, error)
	steps, err := teamStepsOptIn(os.Getenv("POCKETCTL_TEAM_STEPS_V1"))
	if err != nil {
		return nil, err
	}
	if steps && sm.TeamStepInputsReady() && caps.FrozenInputs {
		prepareInputs = func(ctx context.Context, auth *protocol.CollaborationAuthorization, value *protocol.CollaborationContext, workspace string) ([]session.AgentTeamsInputFile, error) {
			files, err := teamdelivery.FreezeStepInputBundle(ctx, api, auth, value.StepInputHash, workspace)
			if err != nil {
				return nil, err
			}
			result := make([]session.AgentTeamsInputFile, len(files))
			for i, file := range files {
				result[i] = session.AgentTeamsInputFile{Path: file.Path, SHA256: file.SHA256, Data: file.Data}
			}
			return result, nil
		}
	}
	var recordUsage func(context.Context, teamdelivery.ExternalUsageRequest) error
	if caps.UsageReporting {
		recordUsage = api.RecordExternalUsage
	}
	err = sm.ConfigureAgentTeams(session.AgentTeamsRuntimeConfig{Context: ctx, Journal: journal, Executor: bridge, OwnerUserID: cfg.OwnerUserID, DaemonID: daemonID, Authorize: api.AuthorizeExternalExecution, PrepareInputs: prepareInputs, RecordUsage: recordUsage, FetchRecovery: api.PendingExternalRecovery, RecordRecovery: api.RecordExternalRecovery,
		RecordStop: api.RecordExternalStop,
		ImportResult: func(ctx context.Context, receipt session.ExternalExecutionReceipt, workspace string) (string, error) {
			prefix, err := session.AgentTeamsDeliveryPath(receipt)
			if err != nil {
				return "", err
			}
			return teamdelivery.ImportExternalDelivery(ctx, workspace, receipt.Identity.CallID, func(ctx context.Context, path string, limit int64) ([]byte, error) {
				artifact, err := bridge.ExportArtifact(ctx, receipt.Identity, prefix+path, limit)
				if err != nil {
					return nil, err
				}
				if artifact.SubmissionID != receipt.RemoteSubmissionID {
					return nil, session.ErrExternalIdentity
				}
				return artifact.Data, nil
			})
		},
	})
	if err != nil {
		return nil, err
	}
	ready = true
	client.SetAgentTeamsEnabled(true)
	client.SetAgentTeamsStepsEnabled(prepareInputs != nil)
	daemon.RunLoop(ctx, "team-agentteams-recovery", logger, func() {
		for {
			_ = sm.ResumeAgentTeamsCalls(ctx, func(ctx context.Context, event protocol.DaemonEvent, teamContext *protocol.CollaborationContext) error {
				return registerAgentTeamsRecovery(ctx, event, teamContext, func(v protocol.DaemonEvent) { client.SendMsg(v) }, func(ctx context.Context, requestID, sessionID string) error {
					return registerCollaborationSession(ctx, grants, requestID, sessionID)
				})
			})
			_ = sm.ProcessAgentTeamsRecovery(ctx)
			_ = sm.MeterAgentTeamsCalls(ctx)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
		}
	})
	return func() { stop(); sm.ShutdownAgentTeams(); journal.Close() }, nil
}

// Re-register the original native identity before replaying durable acceptance.
func registerAgentTeamsRecovery(ctx context.Context, event protocol.DaemonEvent, teamContext *protocol.CollaborationContext, send func(protocol.DaemonEvent), register func(context.Context, string, string) error) error {
	if event.Collaboration == nil || (event.Collaboration.Operation != "create" && event.Collaboration.Operation != "message") {
		return session.ErrCollaborationAuthorization
	}
	// A message Call reuses an existing native session. Replaying session_created
	// with its message reservation violates the original quota binding and can
	// disconnect transport before the accepted receipt reaches Relay.
	if event.Collaboration.Operation == "create" {
		send(event)
	}
	if err := register(ctx, event.RequestID, event.SessionID); err != nil {
		return err
	}
	if teamContext != nil {
		send(protocol.DaemonEvent{Type: "collaboration_context_receipt", SessionID: event.SessionID, RequestID: event.RequestID, MsgID: event.Collaboration.CallID, Status: "accepted", Collaboration: event.Collaboration, TeamContext: teamContext})
	}
	send(protocol.DaemonEvent{Type: "collaboration_dispatch_receipt", SessionID: event.SessionID, RequestID: event.RequestID, MsgID: event.Collaboration.CallID, Status: "accepted", Collaboration: event.Collaboration})
	return nil
}
