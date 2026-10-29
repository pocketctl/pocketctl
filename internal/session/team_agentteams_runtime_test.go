package session

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/teamdelivery"
)

func agentTeamsRuntimeFixture(t *testing.T, remote *externalStub, authority func(context.Context, teamdelivery.ExternalAuthorizationRequest) error) (*SessionManager, *ExternalJournal) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_TURN_ENRICHMENT", "enforce")
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 256))
	policy, err := NewCwdPolicy([]string{t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	sm.SetCwdPolicy(policy)
	journal, err := OpenExternalJournal(t.TempDir(), "installation-scope")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { journal.Close() })
	if err = sm.ConfigureAgentTeams(AgentTeamsRuntimeConfig{Journal: journal, Executor: remote, Authorize: authority, OwnerUserID: 7, DaemonID: "daemon"}); err != nil {
		t.Fatal(err)
	}
	return sm, journal
}

func TestAgentTeamsRuntimeRegistersBeforeAcceptedAndSubmitsOriginalOnce(t *testing.T) {
	ctx := context.Background()
	remote := &externalStub{}
	accepted := false
	sm, _ := agentTeamsRuntimeFixture(t, remote, func(_ context.Context, r teamdelivery.ExternalAuthorizationRequest) error {
		if r.RequestID != "team-call" || r.Authorization.CallID != "call" {
			t.Fatal("original identity lost")
		}
		if r.Phase == "execute" && !accepted {
			return &teamdelivery.HTTPError{Status: 503, Code: "external_call_not_ready"}
		}
		return nil
	})
	registered := false
	native, err := sm.CreateCollaborationSessionRegistered(ctx, collaborationAuth("create", "call"), nil, "agentteams", "bounded request", func(_ context.Context, id string) error {
		select {
		case event := <-sm.outputCh:
			if event.Type != "session_created" || event.SessionID != id {
				t.Fatal("registration has no prior session event")
			}
		default:
			t.Fatal("registration event missing")
		}
		registered = true
		return nil
	})
	if err != nil || !registered || native == "" {
		t.Fatalf("prepare: %s %v", native, err)
	}
	if submits, _, _ := remote.counts(); submits != 0 {
		t.Fatal("remote started before acceptance")
	}
	if err = sm.agentTeams.advance(ctx, "call", false); err == nil {
		t.Fatal("unaccepted dispatch executed")
	}
	if submits, _, _ := remote.counts(); submits != 0 {
		t.Fatal("pending acceptance submitted")
	}
	accepted = true
	if err = sm.agentTeams.advance(ctx, "call", false); err != nil {
		t.Fatal(err)
	}
	if err = sm.agentTeams.advance(ctx, "call", false); err != nil {
		t.Fatal(err)
	}
	if submits, lookups, _ := remote.counts(); submits != 1 || lookups != 1 {
		t.Fatalf("duplicate: %d/%d", submits, lookups)
	}
	if err = sm.sessions[native].Backend.Send(ctx, native, "unbound message"); err == nil {
		t.Fatal("personal send bypassed Team authority")
	}
}

func TestAgentTeamsRuntimeRevocationDuringSubmitCancelsOriginalAndNeverCompletes(t *testing.T) {
	ctx := context.Background()
	remote := &externalStub{}
	revoked := false
	sm, j := agentTeamsRuntimeFixture(t, remote, func(_ context.Context, r teamdelivery.ExternalAuthorizationRequest) error {
		remote.mu.Lock()
		started := remote.submits > 0
		remote.mu.Unlock()
		if revoked && started {
			return &teamdelivery.HTTPError{Status: 403, Code: "team_access_denied"}
		}
		return nil
	})
	native, err := sm.CreateCollaborationSessionRegistered(ctx, collaborationAuth("create", "call"), nil, "agentteams", "bounded request", func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	revoked = true
	if err = sm.agentTeams.advance(ctx, "call", false); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal(err)
	}
	if submits, _, cancels := remote.counts(); submits != 1 || cancels < 1 {
		t.Fatalf("revoke missing %d/%d", submits, cancels)
	}
	if denied, err := j.revoked(ctx, "call"); err != nil || !denied {
		t.Fatal("revocation was not durable")
	}
	for len(sm.outputCh) > 0 {
		ev := <-sm.outputCh
		if ev.SessionID == native && ev.TurnStatus == protocol.TurnStateCompleted {
			t.Fatal("revoked task completed")
		}
	}
}

func TestAgentTeamsRuntimeReopenedJournalOnlyLooksUpOriginalAndReplaysTerminal(t *testing.T) {
	ctx := context.Background()
	remote := &externalStub{loseResponse: true}
	authority := func(context.Context, teamdelivery.ExternalAuthorizationRequest) error { return nil }
	sm, j := agentTeamsRuntimeFixture(t, remote, authority)
	native, err := sm.CreateCollaborationSessionRegistered(ctx, collaborationAuth("create", "call"), nil, "agentteams", "original", func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err = sm.agentTeams.advance(ctx, "call", false); !errors.Is(err, ErrExternalUnknown) {
		t.Fatal(err)
	}
	remote.mu.Lock()
	remote.receipt.State = ExternalSucceeded
	remote.receipt.Sequence++
	remote.mu.Unlock()
	var sequence int
	var database, path string
	if err = j.db.QueryRow("PRAGMA database_list").Scan(&sequence, &database, &path); err != nil {
		t.Fatal(err)
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	j, err = OpenExternalJournal(filepath.Dir(filepath.Dir(path)), "installation-scope")
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	reloaded := NewSessionManager(make(chan protocol.DaemonEvent, 256))
	reloaded.SetCwdPolicy(sm.cwdPolicy)
	if err = reloaded.ConfigureAgentTeams(AgentTeamsRuntimeConfig{Journal: j, Executor: remote, OwnerUserID: 7, DaemonID: "daemon", Authorize: authority}); err != nil {
		t.Fatal(err)
	}
	if err = reloaded.agentTeams.advance(ctx, "call", true); err != nil {
		t.Fatal(err)
	}
	completed := 0
	for len(reloaded.outputCh) > 0 {
		event := <-reloaded.outputCh
		if event.SessionID == native && event.TurnStatus == protocol.TurnStateCompleted {
			completed++
		}
	}
	if completed != 1 {
		t.Fatal("terminal missing")
	}
	// The transport may have lost the terminal event. Until Relay settles the
	// original Call, repeat the same terminal identity without a new submit.
	if err = reloaded.agentTeams.advance(ctx, "call", true); err != nil {
		t.Fatal(err)
	}
	completed = 0
	for len(reloaded.outputCh) > 0 {
		event := <-reloaded.outputCh
		if event.TurnStatus == protocol.TurnStateCompleted {
			completed++
		}
	}
	if completed != 1 {
		t.Fatal("unacknowledged terminal was not replayed")
	}
	if submits, _, _ := remote.counts(); submits != 1 {
		t.Fatal("recovery resubmitted")
	}
}

func TestAgentTeamsScopeSeparatesRelayAccountDaemonAndInstallation(t *testing.T) {
	a, err := AgentTeamsExecutionScope("ws://localhost:19020/ws", "daemon", 7, "installation")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := AgentTeamsExecutionScope("http://localhost:19020", "daemon", 7, "installation")
	if a != b {
		t.Fatal("same Relay has different transport scope")
	}
	for _, args := range []struct {
		url, daemon  string
		owner        int
		installation string
	}{{"ws://localhost:19021/ws", "daemon", 7, "installation"}, {"ws://localhost:19020/ws", "other", 7, "installation"}, {"ws://localhost:19020/ws", "daemon", 8, "installation"}, {"ws://localhost:19020/ws", "daemon", 7, "other"}} {
		value, err := AgentTeamsExecutionScope(args.url, args.daemon, args.owner, args.installation)
		if err != nil || value == a {
			t.Fatal("scope substitution accepted")
		}
	}
}

func TestAgentTeamsRuntimeUnsupportedInputsHaveNoSideEffects(t *testing.T) {
	for _, name := range []string{"selected-memory", "runtime-config", "config-hash"} {
		t.Run(name, func(t *testing.T) {
			remote := &externalStub{}
			authorizations := 0
			sm, journal := agentTeamsRuntimeFixture(t, remote, func(context.Context, teamdelivery.ExternalAuthorizationRequest) error {
				authorizations++
				return nil
			})
			auth := collaborationAuth("create", "call")
			var value *protocol.CollaborationContext
			switch name {
			case "selected-memory":
				value = collaborationSelectedContext()
			case "runtime-config":
				auth.RequestedConfig = &protocol.TeamRuntimeConfig{}
			case "config-hash":
				auth.ConfigHash = "unsupported-frozen-config"
			}
			registered := false
			native, err := sm.prepareAgentTeamsCall(context.Background(), auth, value, "", "bounded request", func(context.Context, string) error {
				registered = true
				return nil
			})
			if !errors.Is(err, ErrExternalCapability) || native != "" {
				t.Fatalf("unsupported input was not explicitly refused: %q %v", native, err)
			}
			if registered || authorizations != 0 {
				t.Fatal("unsupported input reached registration or execution authorization")
			}
			if submits, lookups, cancels := remote.counts(); submits != 0 || lookups != 0 || cancels != 0 {
				t.Fatalf("unsupported input reached remote: %d/%d/%d", submits, lookups, cancels)
			}
			if _, _, err := journal.Load(context.Background(), auth.CallID); !errors.Is(err, ErrExternalMissing) {
				t.Fatalf("unsupported input created an execution intent: %v", err)
			}
			if len(sm.sessions) != 0 || len(sm.outputCh) != 0 {
				t.Fatal("unsupported input created a native session or event")
			}
		})
	}
}

func TestAgentTeamsRevocationStopRequiresRemoteConfirmationAndRelayACK(t *testing.T) {
	ctx := context.Background()
	remote := &externalStub{}
	sm, j := agentTeamsRuntimeFixture(t, remote, func(context.Context, teamdelivery.ExternalAuthorizationRequest) error { return nil })
	native, err := sm.CreateCollaborationSessionRegistered(ctx, collaborationAuth("create", "call"), nil, "agentteams", "bounded", func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err = sm.agentTeams.advance(ctx, "call", false); err != nil {
		t.Fatal(err)
	}
	reports := 0
	ack := false
	sm.agentTeams.config.RecordStop = func(_ context.Context, r teamdelivery.ExternalStopReport) error {
		reports++
		if r.Authorization.CallID != "call" || r.RequestID != "team-call" || r.NativeSessionID != native || r.State != "cancelled" {
			t.Fatal("stop identity lost")
		}
		if !ack {
			return errors.New("lost ACK")
		}
		return nil
	}
	coordinator, _ := NewExternalCoordinator(j, remote, func(context.Context, ExternalExecutionRequest) error { return ErrExternalRevoked })
	remote.cancelErr = errors.New("stop not confirmed")
	if err = sm.agentTeams.stopAfterRevocation(ctx, "call", coordinator); err == nil || reports != 0 {
		t.Fatal("unconfirmed stop reported")
	}
	remote.cancelErr = nil
	if err = sm.agentTeams.stopAfterRevocation(ctx, "call", coordinator); err == nil {
		t.Fatal("missing ACK treated as settled")
	}
	var finished int
	j.db.QueryRow("SELECT finished FROM agentteams_daemon_calls WHERE call_id='call'").Scan(&finished)
	if finished == 2 {
		t.Fatal("intent lost before ACK")
	}
	ack = true
	if err = sm.agentTeams.stopAfterRevocation(ctx, "call", coordinator); err != nil {
		t.Fatal(err)
	}
	j.db.QueryRow("SELECT finished FROM agentteams_daemon_calls WHERE call_id='call'").Scan(&finished)
	if finished != 2 || reports != 2 {
		t.Fatalf("stop not settled: %d/%d", finished, reports)
	}
	if submits, _, _ := remote.counts(); submits != 1 {
		t.Fatal("stop retried execution")
	}
}
