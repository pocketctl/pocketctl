package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/pocketctl/pocketctl/internal/agentteams"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
	"github.com/pocketctl/pocketctl/internal/teamdelivery"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// AgentTeamsRuntimeConfig is installation-owned. Task text cannot select the
// transport, identity scope, credential, workspace root or authorization API.
type AgentTeamsRuntimeConfig struct {
	Context     context.Context
	Journal     *ExternalJournal
	Executor    ExternalExecutor
	OwnerUserID int
	DaemonID    string
	Authorize   func(context.Context, teamdelivery.ExternalAuthorizationRequest) error
	// PrepareInputs must materialize the exact frozen P1 inputs in the remote
	// task, not merely refer to daemon-local paths. Absent support rejects steps.
	PrepareInputs  func(context.Context, *protocol.CollaborationAuthorization, *protocol.CollaborationContext, string) ([]AgentTeamsInputFile, error)
	ImportResult   func(context.Context, ExternalExecutionReceipt, string) (string, error)
	RecordUsage    func(context.Context, teamdelivery.ExternalUsageRequest) error
	FetchRecovery  func(context.Context, string) ([]teamdelivery.ExternalRecoveryCommand, error)
	RecordRecovery func(context.Context, teamdelivery.ExternalRecoveryReport) error
	RecordStop     func(context.Context, teamdelivery.ExternalStopReport) error
}

// Files are digest-bound in the original request. The bridge validates and
// materializes them before delegation; no source URL or mutable path is used.
type AgentTeamsInputFile = agentteams.InputFile
type agentTeamsDispatchInput struct {
	AgentTeamsTaskInput
	Authorization   protocol.CollaborationAuthorization `json:"authorization"`
	Context         *protocol.CollaborationContext      `json:"context,omitempty"`
	NativeSessionID string                              `json:"native_session_id"`
	Workspace       string                              `json:"workspace"`
	Inputs          []AgentTeamsInputFile               `json:"inputs,omitempty"`
}
type agentTeamsRuntime struct {
	manager *SessionManager
	config  AgentTeamsRuntimeConfig
	mu      sync.Mutex
	// One local observer per original Call; this is not a retry scheduler.
	observers  map[string]bool
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	stopped    bool
	metering   bool
	recovering bool
}

func AgentTeamsExecutionScope(relayURL, daemonID string, owner int, installation string) (string, error) {
	u, err := url.Parse(relayURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || owner <= 0 || !externalIdentifier(daemonID) || !externalIdentifier(installation) {
		return "", ErrExternalIdentity
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
	default:
		return "", ErrExternalIdentity
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/ws")
	u.RawPath = ""
	return "agentteams-" + externalPayloadDigest([]byte(fmt.Sprintf("%s\x00%s\x00%d\x00%s", u.String(), daemonID, owner, installation))), nil
}

func AgentTeamsDeliveryPath(receipt ExternalExecutionReceipt) (string, error) {
	if !receipt.Identity.valid() || receipt.State != ExternalSucceeded || !externalIdentifier(receipt.RemoteSubmissionID) {
		return "", ErrExternalReceipt
	}
	data, _ := json.Marshal(receipt.Identity)
	project := "pctl-" + externalPayloadDigest(data)[:32]
	task := project + "-01"
	if receipt.RemoteTaskID != project+"/"+task {
		return "", ErrExternalIdentity
	}
	return "shared/tasks/" + task + "/pocketctl-delivery/", nil
}

// ResumeAgentTeamsCalls restores only durable original intents with a current
// accepted/uncertain grant. The callback registers this daemon generation and
// queues the original accepted receipt before read-only remote recovery.
func (sm *SessionManager) ResumeAgentTeamsCalls(ctx context.Context, register func(context.Context, protocol.DaemonEvent, *protocol.CollaborationContext) error) error {
	sm.mu.RLock()
	runtime := sm.agentTeams
	sm.mu.RUnlock()
	if runtime == nil {
		return nil
	}
	runtime.mu.Lock()
	if runtime.stopped {
		runtime.mu.Unlock()
		return nil
	}
	runtime.wg.Add(1)
	runtime.mu.Unlock()
	defer runtime.wg.Done()
	rows, err := runtime.config.Journal.db.QueryContext(ctx, `SELECT call_id FROM agentteams_daemon_calls WHERE finished<2 ORDER BY call_id`)
	if err != nil {
		return err
	}
	var calls []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		calls = append(calls, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range calls {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		runtime.mu.Lock()
		running := runtime.observers[id]
		runtime.mu.Unlock()
		if running {
			continue
		}
		_, input, err := runtime.load(ctx, id)
		if err != nil {
			return err
		}
		if err = runtime.authorize(ctx, input.Authorization, input.NativeSessionID, "observe"); err != nil {
			if errors.Is(err, ErrExternalRevoked) {
				coordinator, _ := NewExternalCoordinator(runtime.config.Journal, runtime.config.Executor, func(context.Context, ExternalExecutionRequest) error { return ErrExternalRevoked })
				_ = runtime.stopAfterRevocation(ctx, id, coordinator)
			}
			if agentTeamsCallSettled(err) {
				_, _ = runtime.config.Journal.db.ExecContext(ctx, `UPDATE agentteams_daemon_calls SET finished=2 WHERE call_id=?`, id)
			}
			continue
		}
		a := input.Authorization
		binding := collaborationNativeBinding{NativeSessionID: input.NativeSessionID, TeamSessionID: a.TeamSessionID, BindingID: a.BindingID, BindingRevision: a.BindingRevision, OfferID: a.OfferID, OfferRevision: a.OfferRevision, OwnerUserID: a.OwnerUserID, DaemonID: a.DaemonID, Agent: "agentteams"}
		runtime.installSession(binding, input.Workspace)
		event := protocol.DaemonEvent{Type: "session_created", SessionID: input.NativeSessionID, Agent: "agentteams", Cwd: input.Workspace, Collaboration: &a, RequestID: "team-" + id}
		if register == nil {
			return ErrCollaborationAuthorization
		}
		if err = register(ctx, event, input.Context); err != nil {
			continue
		}
		sm.beginAgentTeamsCall(ctx, id, true)
	}
	return nil
}

func (sm *SessionManager) ConfigureAgentTeams(config AgentTeamsRuntimeConfig) error {
	if config.Journal == nil || config.Executor == nil || config.Authorize == nil || config.OwnerUserID <= 0 || !externalIdentifier(config.DaemonID) || !sm.turnEnabled() {
		return ErrExternalCapability
	}
	_, err := config.Journal.db.Exec(`CREATE TABLE IF NOT EXISTS agentteams_daemon_calls(call_id TEXT PRIMARY KEY,native_session_id TEXT NOT NULL,binding_id TEXT NOT NULL,finished INTEGER NOT NULL DEFAULT 0);
 CREATE UNIQUE INDEX IF NOT EXISTS agentteams_daemon_active_binding ON agentteams_daemon_calls(binding_id) WHERE finished=0;
 CREATE TABLE IF NOT EXISTS agentteams_metered_calls(call_id TEXT PRIMARY KEY);`)
	if err != nil {
		return err
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.agentTeams != nil {
		return ErrExternalConflict
	}
	parent := config.Context
	if parent == nil {
		parent = context.Background()
	}
	lifetime, cancel := context.WithCancel(parent)
	sm.agentTeams = &agentTeamsRuntime{manager: sm, config: config, observers: map[string]bool{}, ctx: lifetime, cancel: cancel}
	return nil
}

func (sm *SessionManager) prepareAgentTeamsCall(ctx context.Context, auth *protocol.CollaborationAuthorization, value *protocol.CollaborationContext, native, content string, register func(context.Context, string) error) (string, error) {
	sm.mu.RLock()
	runtime, policy := sm.agentTeams, sm.cwdPolicy
	sm.mu.RUnlock()
	if runtime == nil {
		return "", ErrExternalCapability
	}
	// Serialize local preparation with other Calls on the same managed binding.
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if auth == nil || ValidateCollaborationAuthorization(auth, auth.Operation) != nil || (auth.Operation != "create" && auth.Operation != "message") || auth.OwnerUserID != runtime.config.OwnerUserID || auth.DaemonID != runtime.config.DaemonID {
		return "", ErrCollaborationAuthorization
	}
	if auth.RequestedConfig != nil || auth.ConfigHash != "" || collaborationHasSelectedMemory(value) {
		return "", ErrExternalCapability
	}
	if _, err := teamStepInputBinding(auth, value); err != nil {
		return "", err
	}
	prompt, err := collaborationInitialPrompt(content, value)
	if err != nil {
		return "", err
	}
	if auth.Delivery != nil && runtime.config.ImportResult == nil {
		return "", ErrExternalCapability
	}
	if auth.Delivery != nil && auth.Delivery.AttemptID != "" && runtime.config.PrepareInputs == nil {
		return "", ErrExternalCapability
	}
	expected := "agentteams-" + externalPayloadDigest([]byte(fmt.Sprintf("%s\x00%s\x00%d\x00%d", runtime.config.Journal.scope, auth.BindingID, auth.BindingRevision, auth.OfferRevision)))[:32]
	if native != "" && native != expected {
		return "", ErrCollaborationBinding
	}
	if auth.Operation == "create" && register == nil {
		return "", ErrCollaborationAuthorization
	}
	if auth.Operation == "message" && native == "" {
		return "", ErrCollaborationBinding
	}
	if _, _, err = runtime.config.Journal.Load(ctx, auth.CallID); err == nil {
		return "", ErrCollaborationDuplicateCall
	} else if !errors.Is(err, ErrExternalMissing) {
		return "", err
	}
	if err = runtime.authorize(ctx, *auth, "", "prepare"); err != nil {
		return "", err
	}
	roots := policy.Roots()
	if len(roots) == 0 {
		return "", ErrCwdNotAuthorized
	}
	workspace, err := policy.AuthorizeProposed(collaborationWorkspace(roots[0], auth.BindingID))
	if err != nil {
		return "", err
	}
	if workspace != collaborationWorkspace(roots[0], auth.BindingID) {
		return "", ErrCwdNotAuthorized
	}
	if err = os.MkdirAll(workspace, 0700); err != nil {
		return "", err
	}
	if err = policy.Allows(workspace); err != nil {
		return "", err
	}
	binding := collaborationNativeBinding{NativeSessionID: expected, TeamSessionID: auth.TeamSessionID, BindingID: auth.BindingID, BindingRevision: auth.BindingRevision, OfferID: auth.OfferID, OfferRevision: auth.OfferRevision, OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID, Agent: "agentteams"}
	// Existing ownership must match exactly. Never replace an unrelated private
	// record merely because a session ID or workspace happens to exist.
	recordPath, err := collaborationRecordPath("agentteams", expected)
	if err != nil {
		return "", err
	}
	existing, readErr := sessiondocument.ReadExplicitArtifact(filepath.Dir(recordPath), filepath.Base(recordPath), 16384)
	if readErr == nil {
		var record collaborationNativeRecord
		if json.Unmarshal(existing, &record) != nil || record.Version != 1 || record.Cwd != workspace || record.Binding != binding {
			return "", ErrCollaborationBinding
		}
	} else {
		if auth.Operation != "create" {
			return "", ErrCollaborationBinding
		}
		if err = persistCollaborationNative(binding, workspace); err != nil {
			return "", err
		}
	}
	frozen := agentTeamsDispatchInput{AgentTeamsTaskInput: AgentTeamsTaskInput{Spec: prompt, Delivery: runtime.config.ImportResult != nil}, Authorization: *auth, Context: value, NativeSessionID: expected, Workspace: workspace}
	// Registration remains ahead of input downloads and all remote mutations.
	runtime.installSession(binding, workspace)
	if register != nil {
		sm.outputCh <- protocol.DaemonEvent{Type: "session_created", SessionID: expected, Agent: "agentteams", Cwd: workspace, Collaboration: auth, RequestID: "team-" + auth.CallID}
		if err = register(ctx, expected); err != nil {
			return "", err
		}
	}
	if auth.Delivery != nil && auth.Delivery.AttemptID != "" {
		frozen.Inputs, err = runtime.config.PrepareInputs(ctx, auth, value, workspace)
		if err != nil {
			return "", err
		}
		if err = agentteams.ValidateInputFiles(frozen.Inputs); err != nil {
			return "", err
		}
	}
	data, err := json.Marshal(frozen)
	if err != nil {
		return "", err
	}
	if len(data) > agentteams.MaxFrozenRequestBytes {
		return "", ErrExternalCapability
	}
	// Freeze after all preparation, then check authority again before admitting.
	if err = runtime.authorize(ctx, *auth, "", "prepare"); err != nil {
		return "", err
	}
	attempt := ""
	if auth.Delivery != nil {
		attempt = auth.Delivery.AttemptID
	}
	request := ExternalExecutionRequest{Identity: ExternalExecutionIdentity{Scope: runtime.config.Journal.scope, CallID: auth.CallID, OfferID: auth.OfferID, AttemptID: attempt, RequestID: "team-" + auth.CallID}, InputDigest: externalPayloadDigest(data), Input: data}
	if err = runtime.config.Journal.SaveIntent(ctx, request); err != nil {
		return "", err
	}
	if _, err = runtime.config.Journal.db.ExecContext(ctx, `INSERT INTO agentteams_daemon_calls(call_id,native_session_id,binding_id) VALUES(?,?,?)`, auth.CallID, expected, auth.BindingID); err != nil {
		return "", ErrCollaborationSessionBusy
	}
	return expected, nil
}

func (r *agentTeamsRuntime) installSession(binding collaborationNativeBinding, workspace string) {
	sm := r.manager
	sm.mu.Lock()
	if sm.sessions[binding.NativeSessionID] == nil {
		sm.sessions[binding.NativeSessionID] = &ProcessState{SessionID: binding.NativeSessionID, Agent: "agentteams", Source: "daemon", Cwd: workspace, Status: protocol.StatusIdle, StartedAt: time.Now(), LastActivityAt: time.Now(), Backend: &agentTeamsSessionBackend{runtime: r, native: binding.NativeSessionID}}
	}
	sm.mu.Unlock()
	sm.registerCwd(binding.NativeSessionID, workspace)
	sm.collaborationMu.Lock()
	if sm.collaborationBindings == nil {
		sm.collaborationBindings = map[string]collaborationNativeBinding{}
	}
	sm.collaborationBindings[binding.BindingID] = binding
	sm.collaborationMu.Unlock()
}

func (r *agentTeamsRuntime) authorize(ctx context.Context, auth protocol.CollaborationAuthorization, native, phase string) error {
	err := r.config.Authorize(ctx, teamdelivery.ExternalAuthorizationRequest{Authorization: auth, RequestID: "team-" + auth.CallID, NativeSessionID: native, Phase: phase})
	var failure *teamdelivery.HTTPError
	if errors.As(err, &failure) && failure.Status == 403 {
		// Only an authoritative current denial is revocation. A timeout, expired
		// bearer, ordinary 404 or acceptance delay must remain unknown.
		if _, saveErr := r.config.Journal.db.ExecContext(ctx, `INSERT INTO external_revocations(call_id) VALUES(?) ON CONFLICT DO NOTHING`, auth.CallID); saveErr != nil {
			return saveErr
		}
		return ErrExternalRevoked
	}
	return err
}

func (r *agentTeamsRuntime) load(ctx context.Context, callID string) (ExternalExecutionRequest, agentTeamsDispatchInput, error) {
	request, _, err := r.config.Journal.Load(ctx, callID)
	var input agentTeamsDispatchInput
	if err != nil {
		return request, input, err
	}
	if json.Unmarshal(request.Input, &input) != nil || input.Authorization.CallID != callID || request.Identity.RequestID != "team-"+callID || input.Authorization.OwnerUserID != r.config.OwnerUserID || input.Authorization.DaemonID != r.config.DaemonID || input.Authorization.OfferID != request.Identity.OfferID {
		return request, input, ErrExternalCorrupt
	}
	r.manager.mu.RLock()
	policy := r.manager.cwdPolicy
	r.manager.mu.RUnlock()
	if policy.Allows(input.Workspace) != nil {
		return request, input, ErrCwdNotAuthorized
	}
	p, err := collaborationRecordPath("agentteams", input.NativeSessionID)
	if err != nil {
		return request, input, err
	}
	data, err := sessiondocument.ReadExplicitArtifact(filepath.Dir(p), filepath.Base(p), 16384)
	if err != nil {
		return request, input, ErrCollaborationBinding
	}
	var record collaborationNativeRecord
	a := input.Authorization
	if json.Unmarshal(data, &record) != nil || record.Version != 1 || record.Cwd != input.Workspace || record.Binding.NativeSessionID != input.NativeSessionID || record.Binding.Agent != "agentteams" || record.Binding.TeamSessionID != a.TeamSessionID || record.Binding.BindingID != a.BindingID || record.Binding.BindingRevision != a.BindingRevision || record.Binding.OfferID != a.OfferID || record.Binding.OfferRevision != a.OfferRevision || record.Binding.OwnerUserID != a.OwnerUserID || record.Binding.DaemonID != a.DaemonID {
		return request, input, ErrCollaborationBinding
	}
	return request, input, nil
}

func (r *agentTeamsRuntime) advance(ctx context.Context, callID string, recovery bool) error {
	var finished int
	if err := r.config.Journal.db.QueryRowContext(ctx, `SELECT finished FROM agentteams_daemon_calls WHERE call_id=?`, callID).Scan(&finished); err != nil {
		return err
	}
	if finished == 2 {
		return nil
	}
	request, input, err := r.load(ctx, callID)
	if err != nil {
		return err
	}
	phase := "execute"
	if recovery || finished == 1 {
		phase = "observe"
	}
	// A locally revoked execution may still deliver its durable stop receipt.
	// This is a current-authorized terminal notification, never result import.
	if finished == 1 {
		_, saved, loadErr := r.config.Journal.Load(ctx, callID)
		if loadErr != nil {
			return loadErr
		}
		if saved != nil && saved.State == ExternalCancelled {
			if authErr := r.authorize(ctx, input.Authorization, input.NativeSessionID, "observe"); authErr != nil {
				if agentTeamsCallSettled(authErr) {
					_, err = r.config.Journal.db.ExecContext(ctx, `UPDATE agentteams_daemon_calls SET finished=2 WHERE call_id=?`, callID)
					return err
				}
				return authErr
			}
			last, ok := r.manager.turns.Last(turn.ActorKey{SessionID: input.NativeSessionID})
			if !ok || last.RequestIDHash != turn.HashRequestID(request.Identity.RequestID) || last.State != protocol.TurnStateInterrupted {
				return ErrExternalCorrupt
			}
			r.manager.emitTurnStatus(last, last.State, last.LastReason)
			return nil
		}
	}
	coordinator, err := NewExternalCoordinator(r.config.Journal, r.config.Executor, func(ctx context.Context, _ ExternalExecutionRequest) error {
		return r.authorize(ctx, input.Authorization, input.NativeSessionID, phase)
	})
	if err != nil {
		return err
	}
	// Require acceptance before creating the canonical local turn, too.
	if err = coordinator.allowed(ctx, request); err != nil {
		if agentTeamsCallSettled(err) {
			_, err = r.config.Journal.db.ExecContext(ctx, `UPDATE agentteams_daemon_calls SET finished=2 WHERE call_id=?`, callID)
			return err
		}
		if errors.Is(err, ErrExternalRevoked) {
			_ = r.stopAfterRevocation(ctx, callID, coordinator)
		}
		return err
	}
	key := turn.ActorKey{SessionID: input.NativeSessionID}
	if last, ok := r.manager.turns.Last(key); ok && last.RequestIDHash == turn.HashRequestID(request.Identity.RequestID) && (last.State == protocol.TurnStateCompleted || last.State == protocol.TurnStateFailed) {
		_, saved, err := r.config.Journal.Load(ctx, callID)
		if err != nil {
			return err
		}
		if saved == nil || !((saved.State == ExternalSucceeded && last.State == protocol.TurnStateCompleted) || (saved.State == ExternalFailed && last.State == protocol.TurnStateFailed)) {
			return ErrExternalCorrupt
		}
		r.manager.emitTurnStatus(last, last.State, last.LastReason)
		_, err = r.config.Journal.db.ExecContext(ctx, `UPDATE agentteams_daemon_calls SET finished=1 WHERE call_id=?`, callID)
		return err
	}
	rec, ok := r.manager.turns.Active(key)
	if !ok {
		rec, err = r.manager.turns.Start(turn.StartInput{Actor: key, Identity: turn.Identity{Agent: "agentteams", RequestID: request.Identity.RequestID}})
		if err != nil {
			return err
		}
		r.manager.emitTurnStatus(rec, protocol.TurnStateRunning, "")
	} else if rec.RequestIDHash != turn.HashRequestID(request.Identity.RequestID) {
		return ErrCollaborationSessionBusy
	}
	r.manager.mu.Lock()
	if ps := r.manager.sessions[input.NativeSessionID]; ps != nil {
		ps.Status = protocol.StatusRunning
		ps.LastActivityAt = time.Now()
		ps.TurnStartedAt = rec.StartedAt
	}
	r.manager.mu.Unlock()
	var receipt ExternalExecutionReceipt
	if recovery {
		receipt, err = coordinator.Recover(ctx, callID)
	} else {
		receipt, err = coordinator.Start(ctx, request)
	}
	if err != nil {
		if errors.Is(err, ErrExternalRevoked) {
			_ = r.stopAfterRevocation(ctx, callID, coordinator)
		}
		return err
	}
	rec, err = r.manager.turns.BindSource(key, rec.TurnID, receipt.RemoteTaskID)
	if err != nil {
		return err
	}
	if receipt.State == ExternalSucceeded {
		summary := ""
		if r.config.ImportResult != nil {
			summary, err = r.config.ImportResult(ctx, receipt, input.Workspace)
			if err != nil {
				return err
			}
		}
		if err = coordinator.allowed(ctx, request); err != nil {
			if errors.Is(err, ErrExternalRevoked) {
				_ = r.stopAfterRevocation(ctx, callID, coordinator)
			}
			return err
		}
		if summary != "" {
			r.manager.outputCh <- protocol.DaemonEvent{Type: "agent_text", SessionID: input.NativeSessionID, Text: summary}
		}
		r.manager.terminalizeTurn(key, rec, protocol.TurnStateCompleted, "agentteams_execution_completed", protocol.TurnConfidenceNative)
	} else if receipt.State == ExternalFailed {
		r.manager.terminalizeTurn(key, rec, protocol.TurnStateFailed, "agentteams_execution_failed", protocol.TurnConfidenceNative)
	} else {
		return nil
	} // Logical task cancellation does not prove model stop.
	_, err = r.config.Journal.db.ExecContext(ctx, `UPDATE agentteams_daemon_calls SET finished=1 WHERE call_id=?`, callID)
	return err
}

// BeginAgentTeamsCall is called only after the accepted receipt was queued.
// The Relay current-authority API remains the actual remote execution gate.
func (sm *SessionManager) BeginAgentTeamsCall(ctx context.Context, callID string) {
	sm.beginAgentTeamsCall(ctx, callID, false)
}

func (sm *SessionManager) beginAgentTeamsCall(ctx context.Context, callID string, recovery bool) {
	sm.mu.RLock()
	runtime := sm.agentTeams
	sm.mu.RUnlock()
	if runtime == nil {
		return
	}
	runtime.mu.Lock()
	if runtime.stopped || runtime.observers[callID] {
		runtime.mu.Unlock()
		return
	}
	runtime.observers[callID] = true
	runtime.wg.Add(1)
	runtime.mu.Unlock()
	go func() {
		defer runtime.wg.Done()
		ctx, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(runtime.ctx, cancel)
		defer func() { stop(); cancel() }()
		defer func() { runtime.mu.Lock(); delete(runtime.observers, callID); runtime.mu.Unlock() }()
		for {
			err := runtime.advance(ctx, callID, recovery)
			if ctx.Err() != nil || errors.Is(err, ErrExternalRevoked) {
				return
			}
			var finished int
			if runtime.config.Journal.db.QueryRowContext(ctx, `SELECT finished FROM agentteams_daemon_calls WHERE call_id=?`, callID).Scan(&finished) != nil || finished == 2 {
				return
			}
			timer := time.NewTimer(3 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
}

func agentTeamsCallSettled(err error) bool {
	var failure *teamdelivery.HTTPError
	return errors.As(err, &failure) && failure.Status == 409 && failure.Code == "external_call_settled"
}

func (sm *SessionManager) ShutdownAgentTeams() {
	sm.mu.RLock()
	runtime := sm.agentTeams
	sm.mu.RUnlock()
	if runtime == nil {
		return
	}
	runtime.mu.Lock()
	runtime.stopped = true
	runtime.cancel()
	runtime.mu.Unlock()
	runtime.wg.Wait()
}

type agentTeamsSessionBackend struct {
	runtime *agentTeamsRuntime
	native  string
}

func (b *agentTeamsSessionBackend) Start(context.Context, protocol.SessionConfig) (string, error) {
	return "", ErrCollaborationAuthorization
}
func (b *agentTeamsSessionBackend) Send(context.Context, string, string) error {
	return ErrCollaborationAuthorization
}
func (b *agentTeamsSessionBackend) Interrupt(id string) error {
	if id != b.native {
		return ErrCollaborationBinding
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var callID string
	if err := b.runtime.config.Journal.db.QueryRowContext(ctx, `SELECT call_id FROM agentteams_daemon_calls WHERE native_session_id=? AND finished=0`, id).Scan(&callID); err != nil {
		return err
	}
	coordinator, _ := NewExternalCoordinator(b.runtime.config.Journal, b.runtime.config.Executor, func(context.Context, ExternalExecutionRequest) error { return ErrExternalRevoked })
	if err := coordinator.Revoke(ctx, callID); err != nil {
		return err
	}
	caps, err := b.runtime.config.Executor.Capabilities(ctx)
	if err != nil || !caps.ModelStop {
		return errors.Join(ErrExternalUnknown, err)
	}
	request, current, err := b.runtime.config.Journal.Load(ctx, callID)
	if err != nil {
		return err
	}
	if current == nil {
		return ErrExternalUnknown
	}
	if current.State != ExternalCancelled {
		next := *current
		next.Sequence++
		next.State = ExternalCancelled
		if _, err = b.runtime.config.Journal.RecordReceipt(ctx, next); err != nil {
			return err
		}
	}
	key := turn.ActorKey{SessionID: b.native}
	if active, ok := b.runtime.manager.turns.Active(key); ok {
		if active.RequestIDHash != turn.HashRequestID(request.Identity.RequestID) {
			return ErrExternalIdentity
		}
		b.runtime.manager.terminalizeTurn(key, active, protocol.TurnStateInterrupted, "agentteams_worker_stop_confirmed", protocol.TurnConfidenceNative)
	}
	_, err = b.runtime.config.Journal.db.ExecContext(ctx, `UPDATE agentteams_daemon_calls SET finished=1 WHERE call_id=?`, callID)
	return err
}
func (b *agentTeamsSessionBackend) Close(id string) error {
	if id != b.native {
		return ErrCollaborationBinding
	}
	err := b.Interrupt(id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	return err
}

var _ SessionBackend = (*agentTeamsSessionBackend)(nil)

// A confirmed stop is an accounting fact, not permission to observe or publish.
// Retain the original intent until Relay acknowledges this exact stop receipt.
func (r *agentTeamsRuntime) stopAfterRevocation(ctx context.Context, callID string, coordinator *ExternalCoordinator) error {
	if err := coordinator.Revoke(ctx, callID); err != nil {
		return err
	}
	if r.config.RecordStop == nil {
		return nil
	}
	request, input, err := r.load(ctx, callID)
	if err != nil {
		return err
	}
	if err = r.config.RecordStop(ctx, teamdelivery.ExternalStopReport{Authorization: input.Authorization, RequestID: request.Identity.RequestID, NativeSessionID: input.NativeSessionID, State: "cancelled"}); err != nil {
		return err
	}
	key := turn.ActorKey{SessionID: input.NativeSessionID}
	if active, ok := r.manager.turns.Active(key); ok && active.RequestIDHash == turn.HashRequestID(request.Identity.RequestID) {
		r.manager.terminalizeTurn(key, active, protocol.TurnStateInterrupted, "agentteams_revocation_stop_confirmed", protocol.TurnConfidenceNative)
	}
	_, err = r.config.Journal.db.ExecContext(ctx, `UPDATE agentteams_daemon_calls SET finished=2 WHERE call_id=?`, callID)
	return err
}
