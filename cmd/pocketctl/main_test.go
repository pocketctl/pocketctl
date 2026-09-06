package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
	"github.com/pocketctl/pocketctl/internal/ws"
)

type promptReceiptSessionStub struct {
	agent       string
	controlMode string
	sendErr     error
	onSend      func()
	mode        func() string
	exists      *bool
}

type recordingDaemonMessageSender struct {
	messages []any
}

func (s *recordingDaemonMessageSender) SendMsg(message any) {
	s.messages = append(s.messages, message)
}

func (*recordingDaemonMessageSender) SetAgentVersions(map[string]string) {}
func (*recordingDaemonMessageSender) SetAgentLatests(map[string]string)  {}
func (*recordingDaemonMessageSender) SetAgentManageable(map[string]bool) {}
func (*recordingDaemonMessageSender) ResendRegister()                    {}

func (s promptReceiptSessionStub) SendMessage(context.Context, string, string) error {
	return s.sendErr
}

func (s promptReceiptSessionStub) SendMessageWithInput(_ context.Context, in session.UserMessageInput) error {
	if s.onSend != nil {
		s.onSend()
	}
	return s.sendErr
}

func (s promptReceiptSessionStub) GetSessionAgent(string) (string, bool) {
	if s.exists != nil {
		return s.agent, *s.exists
	}
	return s.agent, true
}

func (s promptReceiptSessionStub) SessionControlMode(string) string {
	if s.mode != nil {
		return s.mode()
	}
	return s.controlMode
}

func TestDeliverUserMessageFreezesReceiptContractBeforeDispatch(t *testing.T) {
	controlMode := protocol.ControlManaged
	sm := promptReceiptSessionStub{
		agent: adapter.AgentCodex,
		mode:  func() string { return controlMode },
		onSend: func() {
			controlMode = protocol.ControlUnmanagedActive
		},
	}
	var events []protocol.DaemonEvent
	err := deliverUserMessage(
		context.Background(),
		sm,
		protocol.ClientMessage{
			Type: "user_message", SessionID: "thr_contract", Content: "continue",
			MsgID: "message-contract", RequestID: "request-contract",
		},
		func(event protocol.DaemonEvent) { events = append(events, event) },
	)
	if err != nil {
		t.Fatalf("deliverUserMessage() error=%v", err)
	}
	if len(events) != 1 || events[0].Type != "user_message_receipt" ||
		events[0].MsgID != "message-contract" || events[0].Status != "accepted" {
		t.Fatalf("events=%+v, want the dispatch-time managed Codex receipt contract", events)
	}
}

func TestDeliverUserMessageScopesAcceptanceReceiptToManagedCodex(t *testing.T) {
	rejected := errors.New("Codex turn/start: disconnected")
	tests := []struct {
		name        string
		session     promptReceiptSessionStub
		wantReceipt bool
		wantStatus  string
		wantReason  string
	}{
		{
			name: "managed Codex accepted",
			session: promptReceiptSessionStub{
				agent: adapter.AgentCodex, controlMode: protocol.ControlManaged,
			},
			wantReceipt: true,
			wantStatus:  "accepted",
		},
		{
			name: "managed Codex rejected",
			session: promptReceiptSessionStub{
				agent: adapter.AgentCodex, controlMode: protocol.ControlManaged, sendErr: rejected,
			},
			wantReceipt: true,
			wantStatus:  "rejected",
			wantReason:  "dispatch_failed",
		},
		{
			name: "managed OpenCode accepted",
			session: promptReceiptSessionStub{
				agent: adapter.AgentOpencode, controlMode: protocol.ControlManaged,
			},
			wantReceipt: true,
			wantStatus:  "accepted",
		},
		{
			name: "Claude accepted",
			session: promptReceiptSessionStub{
				agent: adapter.AgentClaude, controlMode: protocol.ControlManaged,
			},
			wantReceipt: true,
			wantStatus:  "accepted",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var events []protocol.DaemonEvent
			err := deliverUserMessage(
				context.Background(),
				tt.session,
				protocol.ClientMessage{
					Type: "user_message", SessionID: "thr_1", Content: "continue",
					MsgID: "message-1", RequestID: "request-1",
				},
				func(event protocol.DaemonEvent) { events = append(events, event) },
			)
			if !errors.Is(err, tt.session.sendErr) {
				t.Fatalf("error=%v, want %v", err, tt.session.sendErr)
			}
			if !tt.wantReceipt {
				if len(events) != 0 {
					t.Fatalf("unexpected receipt=%+v", events)
				}
				return
			}
			if len(events) != 1 {
				t.Fatalf("events=%+v, want one receipt", events)
			}
			got := events[0]
			if got.Type != "user_message_receipt" || got.SessionID != "thr_1" ||
				got.MsgID != "message-1" || got.RequestID != "request-1" ||
				got.Status != tt.wantStatus || got.Reason != tt.wantReason ||
				got.Retryable == nil || *got.Retryable {
				t.Fatalf("receipt=%+v", got)
			}
		})
	}
}

func TestDeliverUserMessageRejectsUnknownIdentityWithStableCorrelation(t *testing.T) {
	sessionExists := false
	sm := promptReceiptSessionStub{
		sendErr: fmt.Errorf("%w: session missing", session.ErrSessionExecutionIdentityUnavailable),
		exists:  &sessionExists,
	}
	var events []protocol.DaemonEvent
	err := deliverUserMessage(context.Background(), sm, protocol.ClientMessage{
		Type: "user_message", SessionID: "missing", Content: "hidden", RequestID: "req-missing", MsgID: "msg-missing",
	}, func(event protocol.DaemonEvent) { events = append(events, event) })
	if err == nil {
		t.Fatal("deliverUserMessage returned nil")
	}
	if len(events) != 1 || events[0].Type != "user_message_receipt" || events[0].Status != "rejected" ||
		events[0].RequestID != "req-missing" || events[0].MsgID != "msg-missing" || events[0].Reason != "session_identity_unavailable" {
		t.Fatalf("events=%+v, want stable correlated identity rejection", events)
	}
}

func TestHandleUserMessageRejectsUnknownIdentityBeforeResumeGrantConsumption(t *testing.T) {
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 8))
	grants := session.NewQuotaGrantValidator()
	grant := &protocol.QuotaGrant{ReservationID: "identity-reservation", Operation: "resume", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	cmd := protocol.ClientMessage{Type: "user_message", SessionID: "missing-session", RequestID: "req-identity", MsgID: "msg-identity", QuotaGrant: grant}
	var dirty atomic.Bool
	var events []protocol.DaemonEvent
	handleUserMessageCommand(context.Background(), sm, cmd, grants, &dirty,
		slog.New(slog.NewTextHandler(io.Discard, nil)), func(event protocol.DaemonEvent) { events = append(events, event) })
	if dirty.Load() {
		t.Fatal("identity rejection dirtied session state")
	}
	if len(events) != 1 || events[0].Type != "user_message_receipt" || events[0].Reason != "session_identity_unavailable" {
		t.Fatalf("events=%+v", events)
	}
	duplicate, err := grants.Validate(cmd.RequestID, grant, "resume", time.Now())
	if err != nil || duplicate {
		t.Fatalf("grant was consumed before identity validation: duplicate=%v err=%v", duplicate, err)
	}
}

func TestCodexDesktopObserverRejectsUserMessageWithSingleTypedNack(t *testing.T) {
	observerErr := &session.ObserverReadOnlyError{SessionID: "desktop-observer"}
	sm := promptReceiptSessionStub{
		agent: adapter.AgentCodexDesktop, controlMode: protocol.ControlLegacyReadOnly, sendErr: observerErr,
	}
	var events []protocol.DaemonEvent
	err := deliverUserMessage(
		context.Background(),
		sm,
		protocol.ClientMessage{
			Type: "user_message", SessionID: "desktop-observer", Content: "forbidden",
			MsgID: "message-observer", RequestID: "request-observer",
		},
		func(event protocol.DaemonEvent) { events = append(events, event) },
	)
	if !errors.Is(err, adapter.ErrObserverReadOnly) {
		t.Fatalf("deliverUserMessage error=%v, want ErrObserverReadOnly", err)
	}
	if len(events) != 1 {
		t.Fatalf("events=%+v, want exactly one observer nack", events)
	}
	got := events[0]
	if got.Type != "user_message_receipt" || got.SessionID != "desktop-observer" ||
		got.MsgID != "message-observer" || got.RequestID != "request-observer" ||
		got.Status != "rejected" || got.Reason != session.ObserverReadOnlyCode ||
		got.Retryable == nil || *got.Retryable || got.Error != "" {
		t.Fatalf("observer nack=%+v", got)
	}
}

func TestCodexDesktopObserverCommandRejectionCoversCreateMessageAndControl(t *testing.T) {
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 8))
	if result := sm.RegisterObservedSession("desktop-observer", "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop); result != session.ObservedSessionNew {
		t.Fatalf("observer registration=%v", result)
	}
	tests := []struct {
		name       string
		command    protocol.ClientMessage
		wantReject bool
		wantType   string
	}{
		{
			name: "create", command: protocol.ClientMessage{
				Type: "session_create", Agent: adapter.AgentCodexDesktop, RequestID: "create-1",
			}, wantReject: true, wantType: "session_create_failed",
		},
		{
			name: "message", command: protocol.ClientMessage{
				Type: "user_message", SessionID: "desktop-observer", RequestID: "message-1", MsgID: "msg-1",
			}, wantReject: true, wantType: "user_message_receipt",
		},
		{
			name: "control", command: protocol.ClientMessage{
				Type: "session_kill", SessionID: "desktop-observer", RequestID: "kill-1",
			}, wantReject: true, wantType: "error",
		},
		{
			name: "abort create", command: protocol.ClientMessage{
				Type: "abort_create", SessionID: "desktop-observer", RequestID: "abort-1",
			}, wantReject: true, wantType: "error",
		},
		{
			name: "desktop upgrade", command: protocol.ClientMessage{
				Type: "upgrade_agent", Agent: adapter.AgentCodexDesktop, RequestID: "upgrade-desktop-1",
			}, wantReject: true, wantType: "upgrade_result",
		},
		{
			name: "zcode upgrade", command: protocol.ClientMessage{
				Type: "upgrade_agent", Agent: adapter.AgentZcode, RequestID: "upgrade-zcode-1",
			}, wantReject: true, wantType: "upgrade_result",
		},
		{
			name: "read only", command: protocol.ClientMessage{
				Type: "list_commands", SessionID: "desktop-observer", RequestID: "list-1",
			}, wantReject: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			event, rejected := observerCommandRejection(sm, tt.command)
			if rejected != tt.wantReject {
				t.Fatalf("rejected=%v, want %v; event=%+v", rejected, tt.wantReject, event)
			}
			if !rejected {
				return
			}
			if event.Type != tt.wantType || event.Reason != session.ObserverReadOnlyCode {
				t.Fatalf("rejection event=%+v", event)
			}
			if tt.command.Type != "session_create" && event.SessionID != tt.command.SessionID {
				t.Fatalf("rejection lost session correlation: %+v", event)
			}
		})
	}
}

func TestObserverUserMessageClassificationBetweenPreflightAndHandlerConsumesNothingAndSendsOneNack(t *testing.T) {
	const sessionID = "observer-main-race"
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 16))
	if started := sm.RegisterTerminalSession(
		sessionID, "/work/terminal", 0, "", protocol.StatusExited, adapter.AgentCodex,
	); !started {
		t.Fatal("generic Codex session was not registered")
	}
	quota := session.NewQuotaGrantValidator()
	grant := &protocol.QuotaGrant{
		ReservationID: "reservation-race", Operation: "resume", ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	}
	cmd := protocol.ClientMessage{
		Type: "user_message", SessionID: sessionID, RequestID: "request-race", MsgID: "message-race",
		Content: "must not resume", QuotaGrant: grant,
	}
	var dirty atomic.Bool
	var events []protocol.DaemonEvent
	preflight := make(chan bool, 1)
	continueHandler := make(chan struct{})
	done := make(chan struct{})
	go func() {
		_, rejected := observerCommandRejection(sm, cmd)
		preflight <- rejected
		<-continueHandler
		handleUserMessageCommand(
			context.Background(), sm, cmd, quota, &dirty,
			slog.New(slog.NewTextHandler(io.Discard, nil)),
			func(event protocol.DaemonEvent) { events = append(events, event) },
		)
		close(done)
	}()
	if rejected := <-preflight; rejected {
		t.Fatal("generic Codex preflight unexpectedly rejected before Desktop classification")
	}
	if result := sm.RegisterObservedSession(
		sessionID, "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop,
	); result != session.ObservedSessionReclassified {
		t.Fatalf("Desktop classification result=%v", result)
	}
	close(continueHandler)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("user-message handler deadlocked after classification")
	}

	if dirty.Load() {
		t.Fatal("observer race marked daemon state dirty")
	}
	duplicate, err := quota.Validate(cmd.RequestID, grant, "resume", time.Now())
	if err != nil || duplicate {
		t.Fatalf("observer race consumed quota grant: duplicate=%v err=%v", duplicate, err)
	}
	if len(events) != 1 {
		t.Fatalf("observer race events=%+v, want one nack", events)
	}
	event := events[0]
	if event.Type != "user_message_receipt" || event.Status != "rejected" ||
		event.Reason != session.ObserverReadOnlyCode || event.SessionID != sessionID ||
		event.RequestID != cmd.RequestID || event.MsgID != cmd.MsgID || event.Error != "" {
		t.Fatalf("observer race nack=%+v", event)
	}
}

func TestObserverCommandRejectionLoadsHistoricalDesktopForEverySessionControl(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("HOME", t.TempDir())
	const sessionID = "23232323-4545-6767-8989-010101010101"
	rolloutDir := filepath.Join(codexHome, "sessions", "2026", "09", "04")
	if err := os.MkdirAll(rolloutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(rolloutDir, "rollout-2026-09-04T10-11-12-"+sessionID+".jsonl")
	line := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"/work/desktop","originator":"Codex Desktop"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, commandType := range []string{
		"user_message", "abort_create", "session_kill", "session_interrupt", "set_permission_config",
		"set_effort", "set_session_agent", "approval_response", "question_response", "question_reject",
		"mcp_elicitation_response", "interactive_response",
	} {
		t.Run(commandType, func(t *testing.T) {
			sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 8))
			cmd := protocol.ClientMessage{
				Type: commandType, SessionID: sessionID, RequestID: "request-historical", MsgID: "message-historical",
			}
			event, rejected := observerCommandRejection(sm, cmd)
			if !rejected {
				t.Fatal("unloaded historical Desktop control was not rejected")
			}
			wantType := "error"
			if commandType == "user_message" {
				wantType = "user_message_receipt"
			}
			if event.Type != wantType || event.Reason != session.ObserverReadOnlyCode ||
				event.SessionID != sessionID || event.RequestID != cmd.RequestID {
				t.Fatalf("historical control rejection=%+v", event)
			}
		})
	}
}

func TestHandleUpgradeAgentRejectsObserversInsideHandler(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, agent := range []string{adapter.AgentCodexDesktop, adapter.AgentZcode} {
		t.Run(agent, func(t *testing.T) {
			sender := &recordingDaemonMessageSender{}
			handleUpgradeAgent(sender, logger, agent)
			if len(sender.messages) != 1 {
				t.Fatalf("observer upgrade messages=%+v, want one rejection", sender.messages)
			}
			event, ok := sender.messages[0].(protocol.DaemonEvent)
			if !ok || event.Type != "upgrade_result" || event.Agent != agent || event.Status != "failed" ||
				event.Reason != session.ObserverReadOnlyCode || !strings.Contains(event.Error, "read-only") {
				t.Fatalf("observer upgrade event=%+v", sender.messages[0])
			}
		})
	}
}

func TestDaemonStatusDoesNotReportDeadStatePIDAsRunning(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	i18n.Set(i18n.English)
	var out bytes.Buffer
	renderDaemonStatus(&out, daemon.DaemonState{
		DaemonID:         "d1",
		PID:              424242,
		Connected:        true,
		ConnectionStatus: "connected",
	}, 424242, func(pid int) bool { return false })
	if !strings.Contains(out.String(), i18n.T("daemon.not_running")) {
		t.Fatalf("output=%q", out.String())
	}
}

func TestDaemonStatusUsesStructuredConnectionStatusAndLegacyFallback(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	tests := []struct {
		name  string
		lang  i18n.Lang
		state daemon.DaemonState
		want  []string
	}{
		{
			name: "structured English",
			lang: i18n.English,
			state: daemon.DaemonState{
				DaemonID: "d1", PID: os.Getpid(), ConnectionStatus: "auth_uncertain",
				ConnectionReason: "token_check_unavailable",
			},
			want: []string{"authentication uncertain", "Reason: token_check_unavailable"},
		},
		{
			name: "structured Chinese",
			lang: i18n.Chinese,
			state: daemon.DaemonState{
				DaemonID: "d1", PID: os.Getpid(), ConnectionStatus: "backpressured",
			},
			want: []string{"中继服务繁忙"},
		},
		{
			name:  "legacy connected",
			lang:  i18n.English,
			state: daemon.DaemonState{DaemonID: "d1", PID: os.Getpid(), Connected: true},
			want:  []string{"Status: connected"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			i18n.Set(tt.lang)
			var out bytes.Buffer
			renderDaemonStatus(&out, tt.state, tt.state.PID, func(int) bool { return true })
			for _, want := range tt.want {
				if !strings.Contains(out.String(), want) {
					t.Fatalf("output=%q, want %q", out.String(), want)
				}
			}
		})
	}
}

func TestDaemonStatusRendersDurableIngressDiagnostics(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	i18n.Set(i18n.English)
	ackAt := time.Date(2026, time.July, 29, 1, 2, 3, 0, time.UTC)
	var out bytes.Buffer
	renderDaemonStatus(&out, daemon.DaemonState{
		DaemonID: "d1", PID: os.Getpid(), EventWindow: 8, UnackedEvents: 2,
		SpoolEvents: 2, SpoolBytes: 123, LastACKAt: ackAt, ReconnectCount: 3,
		BackpressureDuration: 1500 * time.Millisecond,
	}, os.Getpid(), func(int) bool { return true })
	for _, want := range []string{
		"Ingress spool: 2 events, 123 bytes",
		"Ingress window: 8",
		"Ingress unacked: 2",
		"Ingress last ACK: 2026-07-29T01:02:03Z",
		"Reconnects: 3",
		"Backpressure duration: 1.5s",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output=%q, want %q", out.String(), want)
		}
	}
}

func TestDaemonStatusRendersStartupAccountEmail(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	i18n.Set(i18n.English)
	var out bytes.Buffer
	renderDaemonStatus(&out, daemon.DaemonState{
		DaemonID: "d1", PID: os.Getpid(), AccountEmail: "daemon@example.com",
	}, os.Getpid(), func(int) bool { return true })
	if got := out.String(); !strings.Contains(got, "Account: daemon@example.com") {
		t.Fatalf("output=%q", got)
	}
}

func TestDaemonStatePersistenceRecordsDurableIngressSnapshot(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	persistence := newDaemonStatePersistence(daemon.DaemonState{PID: os.Getpid(), EventWindow: -1, UnackedEvents: -1})
	ackAt := time.Date(2026, time.July, 29, 1, 2, 3, 0, time.UTC)
	if err := persistence.updateConnectionWithDiagnostics(ws.ConnectionConnected, "", ackAt, ws.DurableIngressDiagnostics{
		SpoolEvents: 2, SpoolBytes: 123, EventWindow: 8, UnackedEvents: 2,
		LastACKAt: ackAt, Reconnects: 3,
	}); err != nil {
		t.Fatal(err)
	}
	state, err := daemon.ReadState()
	if err != nil {
		t.Fatal(err)
	}
	if state.SpoolEvents != 2 || state.SpoolBytes != 123 || state.EventWindow != 8 ||
		state.UnackedEvents != 2 || !state.LastACKAt.Equal(ackAt) || state.ReconnectCount != 3 {
		t.Fatalf("diagnostics=%+v", state)
	}
}

func TestDaemonStatusRejectsPIDFileStateMismatch(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	i18n.Set(i18n.English)
	var out bytes.Buffer
	renderDaemonStatus(&out, daemon.DaemonState{
		DaemonID: "old", PID: 111, Connected: true, ConnectionStatus: "connected",
	}, 222, func(int) bool { return true })
	if got := out.String(); !strings.Contains(got, i18n.T("daemon.not_running")) ||
		strings.Contains(got, "Status: connected") {
		t.Fatalf("output=%q", got)
	}
}

func TestDaemonStatusUncertaintyIsLocalized(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	for _, tt := range []struct {
		lang i18n.Lang
		want string
	}{
		{i18n.English, "Daemon status cannot be confirmed"},
		{i18n.Chinese, "无法确认 Daemon 状态"},
	} {
		i18n.Set(tt.lang)
		var out bytes.Buffer
		renderDaemonStatusUncertainty(&out, errors.New("owner metadata missing"))
		if got := out.String(); !strings.Contains(got, tt.want) ||
			!strings.Contains(got, "owner metadata missing") {
			t.Fatalf("lang=%v output=%q", tt.lang, got)
		}
	}
}

func TestDaemonStatusStateIdentityMismatchIsUncertain(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	i18n.Set(i18n.English)
	var out bytes.Buffer
	var verified bool
	renderVerifiedDaemonStatus(
		&out,
		daemon.DaemonState{
			DaemonID:             "stale",
			PID:                  111,
			RuntimeInstanceToken: "stale-token",
			Connected:            true,
			ConnectionStatus:     "connected",
		},
		222,
		func(pid int, token string) (bool, error) {
			verified = true
			if pid != 111 || token != "stale-token" {
				t.Fatalf("identity=(%d, %q)", pid, token)
			}
			return false, fmt.Errorf("%w: state identity mismatch", daemon.ErrRuntimeStatusUncertain)
		},
	)
	got := out.String()
	if !verified {
		t.Fatal("typed runtime identity verifier was skipped")
	}
	if !strings.Contains(got, "Daemon status cannot be confirmed") ||
		strings.Contains(got, i18n.T("daemon.not_running")) ||
		strings.Contains(got, "Status: connected") {
		t.Fatalf("output=%q", got)
	}
}

func TestDetachedStartupObservationNeverTrustsUnverifiedConnectedState(t *testing.T) {
	state := &daemon.DaemonState{
		PID:                  101,
		RuntimeInstanceToken: "stale-token",
		Connected:            true,
		ConnectionStatus:     "connected",
	}
	identityChanged := fmt.Errorf(
		"%w: token changed",
		daemon.ErrRuntimeStatusUncertain,
	)
	running, connected, startupErr := observeDetachedDaemonStartup(
		func() (int, bool, error) { return 101, true, nil },
		func() (*daemon.DaemonState, error) { return state, nil },
		func(pid int, token string) (bool, error) {
			return false, identityChanged
		},
	)
	if !running || connected ||
		!errors.Is(startupErr, daemon.ErrRuntimeStatusUncertain) ||
		!errors.Is(startupErr, identityChanged) {
		t.Fatalf("running=%v connected=%v err=%v", running, connected, startupErr)
	}

	running, connected, startupErr = observeDetachedDaemonStartup(
		func() (int, bool, error) { return 101, true, nil },
		func() (*daemon.DaemonState, error) { return state, nil },
		func(pid int, token string) (bool, error) { return true, nil },
	)
	if !running || !connected || startupErr != nil {
		t.Fatalf(
			"verified runtime reported running=%v connected=%v err=%v",
			running,
			connected,
			startupErr,
		)
	}

	runtimeErr := fmt.Errorf(
		"%w: pidfile not published",
		daemon.ErrRuntimeStatusUncertain,
	)
	running, connected, startupErr = observeDetachedDaemonStartup(
		func() (int, bool, error) {
			return 0, false, runtimeErr
		},
		func() (*daemon.DaemonState, error) {
			t.Fatal("state read during runtime uncertainty")
			return nil, nil
		},
		func(int, string) (bool, error) {
			t.Fatal("identity verified during runtime uncertainty")
			return false, nil
		},
	)
	if running || connected ||
		!errors.Is(startupErr, daemon.ErrRuntimeStatusUncertain) ||
		!errors.Is(startupErr, runtimeErr) {
		t.Fatalf("uncertain runtime reported running=%v connected=%v err=%v", running, connected, startupErr)
	}
}

func TestDetachedStartupObservationReturnsTypedStateAndVerificationUncertainty(t *testing.T) {
	stateErr := errors.New("initial state read failed")
	running, connected, startupErr := observeDetachedDaemonStartup(
		func() (int, bool, error) { return 101, true, nil },
		func() (*daemon.DaemonState, error) { return nil, stateErr },
		func(int, string) (bool, error) {
			t.Fatal("verified identity without startup state")
			return false, nil
		},
	)
	if !running || connected ||
		!errors.Is(startupErr, daemon.ErrRuntimeStatusUncertain) ||
		!errors.Is(startupErr, stateErr) {
		t.Fatalf("state failure running=%v connected=%v err=%v", running, connected, startupErr)
	}

	running, connected, startupErr = observeDetachedDaemonStartup(
		func() (int, bool, error) { return 101, true, nil },
		func() (*daemon.DaemonState, error) {
			return &daemon.DaemonState{
				PID:                  101,
				RuntimeInstanceToken: "runtime-a",
			}, nil
		},
		func(int, string) (bool, error) { return false, nil },
	)
	if running || connected || !errors.Is(startupErr, daemon.ErrRuntimeStatusUncertain) {
		t.Fatalf("unverified runtime running=%v connected=%v err=%v", running, connected, startupErr)
	}
}

func TestDetachedStartupFailureRendersLocalizedSafeUncertaintyDetail(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	tests := []struct {
		name  string
		lang  i18n.Lang
		stage detachedDaemonStartupStage
		cause error
		want  string
	}{
		{
			name:  "permission English",
			lang:  i18n.English,
			stage: detachedDaemonStartupRuntime,
			cause: os.ErrPermission,
			want:  "permission",
		},
		{
			name:  "runtime metadata Chinese",
			lang:  i18n.Chinese,
			stage: detachedDaemonStartupRuntime,
			cause: errors.New("owner metadata unavailable"),
			want:  "运行身份元数据",
		},
		{
			name:  "initial state English",
			lang:  i18n.English,
			stage: detachedDaemonStartupState,
			cause: errors.New("disk full; runtime token super-secret-token"),
			want:  "initial daemon state",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			i18n.Set(tt.lang)
			var out bytes.Buffer
			renderDetachedDaemonStartupFailure(
				&out,
				"/tmp/daemon.log",
				newDetachedDaemonStartupUncertainty(tt.stage, tt.cause),
			)
			got := out.String()
			if !strings.Contains(got, i18n.T("daemon.start_failed", "/tmp/daemon.log")) ||
				!strings.Contains(got, tt.want) {
				t.Fatalf("output=%q", got)
			}
			if strings.Contains(got, "super-secret-token") {
				t.Fatalf("startup failure leaked internal runtime token: %q", got)
			}
		})
	}
}

func TestInitialDaemonStateFailureStopsStartupContinuation(t *testing.T) {
	initial := daemon.DaemonState{
		DaemonID:             "daemon-1",
		PID:                  101,
		RuntimeInstanceToken: "runtime-token",
	}
	var continued bool
	var released bool
	err := persistInitialDaemonStateAndContinue(
		initial,
		func(state *daemon.DaemonState) error {
			if state.PID != 101 || state.RuntimeInstanceToken != "runtime-token" {
				t.Fatalf("initial state=%+v", state)
			}
			return errors.New("disk full")
		},
		func() {
			released = true
		},
		func(*daemonStatePersistence) {
			continued = true
		},
	)
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("error=%v", err)
	}
	if continued {
		t.Fatal("client/loop continuation ran after initial state write failure")
	}
	if !released {
		t.Fatal("startup resources were not released after initial state write failure")
	}
}

func TestDaemonStatePersistenceDoesNotRegressConnectionWhenSessionsChange(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	persistence := newDaemonStatePersistence(daemon.DaemonState{
		DaemonID: "d1", PID: os.Getpid(), ConnectionStatus: "reconnecting",
	})
	updatedAt := time.Now().UTC().Truncate(time.Second)
	if err := persistence.updateConnection(ws.ConnectionAuthUncertain, "token_check_unavailable", updatedAt); err != nil {
		t.Fatal(err)
	}
	sessions := []daemon.SessionState{{SessionID: "session-1", Agent: "codex", Status: "busy"}}
	if err := persistence.updateSessions(sessions); err != nil {
		t.Fatal(err)
	}
	got, err := daemon.ReadState()
	if err != nil {
		t.Fatal(err)
	}
	if got.Connected || got.ConnectionStatus != "auth_uncertain" ||
		got.ConnectionReason != "token_check_unavailable" || !got.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("connection regressed: %+v", got)
	}
	if len(got.Sessions) != 1 || got.Sessions[0].SessionID != "session-1" {
		t.Fatalf("sessions=%+v", got.Sessions)
	}
}

func TestDaemonStatePersistenceRefreshesDiagnosticsWithoutConnectionTransition(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	ackAt := time.Date(2026, time.July, 29, 1, 2, 3, 0, time.UTC)
	persistence := newDaemonStatePersistence(daemon.DaemonState{
		DaemonID: "d1", PID: os.Getpid(), ConnectionStatus: string(ws.ConnectionConnected), Connected: true,
		UnackedEvents: 1, Sessions: []daemon.SessionState{{SessionID: "session-1", Agent: "codex"}},
	})
	if err := persistence.refreshDiagnostics(ws.DurableIngressDiagnostics{
		EventWindow: 8, UnackedEvents: 0, LastACKAt: ackAt,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := daemon.ReadState()
	if err != nil {
		t.Fatal(err)
	}
	if got.ConnectionStatus != string(ws.ConnectionConnected) || !got.Connected ||
		got.UnackedEvents != 0 || got.EventWindow != 8 || !got.LastACKAt.Equal(ackAt) {
		t.Fatalf("state after ACK diagnostics refresh=%+v", got)
	}
	if len(got.Sessions) != 1 || got.Sessions[0].SessionID != "session-1" {
		t.Fatalf("diagnostics refresh changed sessions: %+v", got.Sessions)
	}
}

func TestRenderServiceStatusExplainsInstalledButUnloaded(t *testing.T) {
	t.Cleanup(func() { i18n.Set(i18n.English) })
	for _, tt := range []struct {
		lang i18n.Lang
		want string
	}{
		{i18n.English, "Supervisor is not loaded"},
		{i18n.Chinese, "系统服务未加载"},
	} {
		i18n.Set(tt.lang)
		var out bytes.Buffer
		renderServiceStatus(&out, platform.ServiceStatus{Installed: true, Loaded: false})
		if got := out.String(); !strings.Contains(got, tt.want) ||
			!strings.Contains(got, "pocketctl daemon service install") {
			t.Fatalf("lang=%v output=%q", tt.lang, got)
		}
	}
}

func TestOpenCodeSessionMetaUsesLoadedAuthoritativeState(t *testing.T) {
	home := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HOME", home)
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(binDir, "opencode")
	cliContents := "#!/bin/sh\necho 1.2.3\n"
	if runtime.GOOS == "windows" {
		cli += ".cmd"
		cliContents = "@echo off\r\necho 1.2.3\r\n"
	}
	if err := os.WriteFile(cli, []byte(cliContents), 0o755); err != nil {
		t.Fatal(err)
	}
	serve := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/global/health":
			_, _ = w.Write([]byte(`{"healthy":true,"version":"1.2.3"}`))
		case "/api/session/ses_1":
			_, _ = fmt.Fprintf(w, `{"data":{"id":"ses_1","directory":%q,"agent":"build","model":{"providerID":"opencode","id":"deepseek-v4-flash-free"}}}`, repo)
		default:
			http.NotFound(w, r)
		}
	}))
	defer serve.Close()
	// This test covers metadata restoration through an authenticated handoff.
	// The adapter package separately covers external PID lifecycle validation,
	// so use the already-live test process instead of spawning a permanent
	// helper child whose startup/reaping can flake under parallel package load.
	if err := daemon.WriteOpenCodeServeState(&daemon.OpenCodeServeState{
		PID: os.Getpid(), BaseURL: serve.URL, Password: "test-secret", Version: "1.2.3",
		OwnerPID: os.Getpid(), UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 8))

	meta := buildSessionMeta(context.Background(), sm, "ses_1", "", slog.Default())
	if meta.Model != "opencode/deepseek-v4-flash-free" || meta.Cwd != repo || meta.CurrentAgent != "build" {
		t.Fatalf("meta=%+v", meta)
	}
	if meta.ControlMode != protocol.ControlLegacyReadOnly || len(meta.Capabilities) != 0 {
		t.Fatalf("control mode=%q capabilities=%v", meta.ControlMode, meta.Capabilities)
	}
	if err := sm.PrepareDaemonRestart(); err != nil {
		t.Fatal(err)
	}
	sm.ShutdownOpencode()
}

func TestBuildSessionMetaLoadsHistoricalCodexBeforeTryingUnavailableOpenCode(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	// Keep this fixture hermetic: a historical Codex lookup must not depend on
	// an OpenCode executable or server being available on the host.
	t.Setenv("PATH", filepath.Join(home, "bin"))

	const sessionID = "01a04272-2da9-7bd1-b95b-5fd6e0fea150"
	rolloutDir := filepath.Join(home, ".codex", "sessions", "2026", "08", "27")
	if err := os.MkdirAll(rolloutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(rolloutDir, "rollout-2026-08-27T16-59-34-"+sessionID+".jsonl")
	lines := "{\"type\":\"session_meta\",\"payload\":{\"id\":\"" + sessionID + "\",\"cwd\":\"/repo\"}}\n" +
		"{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-terra\",\"effort\":\"xhigh\"}}\n"
	if err := os.WriteFile(rollout, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	const requestID = "session-meta-request-1"
	meta := buildSessionMeta(context.Background(), session.NewSessionManager(make(chan protocol.DaemonEvent, 8)), sessionID, requestID, slog.Default())
	if meta.Model != "gpt-5.6-terra" || meta.Effort != "xhigh" || meta.Cwd != "/repo" {
		t.Fatalf("meta=%+v", meta)
	}
	if meta.RequestID != requestID {
		t.Fatalf("request id=%q, want %q", meta.RequestID, requestID)
	}
}

func TestBuildSessionMetaUsesCodexStorageForDesktopObserver(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	const sessionID = "desktop-partial-metadata"
	rolloutDir := filepath.Join(codexHome, "sessions", "2026", "09", "04")
	if err := os.MkdirAll(rolloutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(rolloutDir, "rollout-2026-09-04T12-00-00-"+sessionID+".jsonl")
	lines := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"/work/desktop","originator":"Codex Desktop"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"high"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}

	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 8))
	if result := sm.RegisterObservedSession(sessionID, "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop); result != session.ObservedSessionNew {
		t.Fatalf("new Desktop observer registration=%v", result)
	}
	meta := buildSessionMeta(context.Background(), sm, sessionID, "desktop-meta-request",
		slog.New(slog.NewTextHandler(io.Discard, nil)))

	if meta.Model != "gpt-5.6-sol" || meta.Effort != "high" {
		t.Fatalf("Desktop metadata model=%q effort=%q, want Codex JSONL values", meta.Model, meta.Effort)
	}
	if meta.ControlMode != protocol.ControlLegacyReadOnly ||
		!reflect.DeepEqual(meta.Capabilities, []string{"history_sync"}) {
		t.Fatalf("Desktop metadata control=%q capabilities=%v", meta.ControlMode, meta.Capabilities)
	}
}

func TestOpenCodeInteractionRaceResolvedElsewhereIsSuccessResult(t *testing.T) {
	event := interactionCommandResultEvent(
		"approval_response", "ses_1", "per_1",
		&session.ResolvedElsewhereError{RequestID: "per_1"},
	)
	if event.Type != "interaction_result" || event.Status != session.InteractionResolvedElsewhere || event.Reason != session.InteractionResolvedElsewhere {
		t.Fatalf("event=%+v", event)
	}
	if event.Operation != "approval_response" || event.SessionID != "ses_1" || event.RequestID != "per_1" || event.Error != "" {
		t.Fatalf("correlation=%+v", event)
	}

	failed := interactionCommandResultEvent("question_response", "ses_1", "que_1", errors.New("reply failed"))
	if failed.Type != "error" || failed.Operation != "question_response" || failed.Error != "reply failed" {
		t.Fatalf("failed event=%+v", failed)
	}
}

func TestCodexDesktopObserverInteractionErrorKeepsProtocolCodeAndSession(t *testing.T) {
	err := &session.ObserverReadOnlyError{SessionID: "desktop-observer"}
	event := interactionCommandResultEvent("question_response", "desktop-observer", "question-1", err)
	if event.Type != "error" || event.SessionID != "desktop-observer" ||
		event.RequestID != "question-1" || event.Operation != "question_response" ||
		event.Reason != session.ObserverReadOnlyCode || !strings.Contains(event.Error, "desktop-observer") {
		t.Fatalf("observer interaction error=%+v", event)
	}
}

func TestDaemonRestartReplacementProcessWaitsForOwnership(t *testing.T) {
	if os.Getenv("POCKETCTL_RESTART_TEST_HELPER") == "1" {
		lock, err := waitForRestartOwnership(os.Getenv("POCKETCTL_RESTART_READY_FILE"), 5*time.Second, func() (io.Closer, error) {
			return daemon.AcquireInstanceLockAt(os.Getenv("POCKETCTL_RESTART_LOCK_FILE"))
		})
		if err != nil {
			os.Exit(2)
		}
		defer lock.Close()
		if err := os.WriteFile(os.Getenv("POCKETCTL_RESTART_CLAIMED_FILE"), []byte("claimed"), 0o600); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	}
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "daemon.lock")
	oldLock, err := daemon.AcquireInstanceLockAt(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "POCKETCTL_RESTART_TEST_HELPER=1", "POCKETCTL_RESTART_READY_FILE=/stale", "POCKETCTL_RESTART_LOCK_FILE="+lockPath)
	for i := 1; i <= 2; i++ {
		readyPath := filepath.Join(dir, fmt.Sprintf("ready-%d", i))
		claimedPath := filepath.Join(dir, fmt.Sprintf("claimed-%d", i))
		cmd := exec.Command(os.Args[0], "-test.run=TestDaemonRestartReplacementProcessWaitsForOwnership")
		env = replaceEnv(env, "POCKETCTL_RESTART_CLAIMED_FILE", claimedPath)
		env = restartChildEnv(env, readyPath)
		cmd.Env = env
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		if err := waitForRestartReady(readyPath, cmd.Process.Pid, 3*time.Second); err != nil {
			_ = cmd.Process.Kill()
			t.Fatal(err)
		}
		if _, err := os.Stat(claimedPath); !os.IsNotExist(err) {
			t.Fatal("replacement claimed ownership before old release")
		}
		if err := oldLock.Close(); err != nil {
			t.Fatal(err)
		}
		if err := cmd.Wait(); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(claimedPath); err != nil {
			t.Fatalf("replacement %d never claimed ownership: %v", i, err)
		}
		for _, path := range []string{readyPath, restartHeartbeatPath(readyPath), restartChallengePath(readyPath), restartAckPath(readyPath)} {
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("replacement %d left handshake artifact %s: %v", i, path, err)
			}
		}
		if i < 2 {
			oldLock, err = daemon.AcquireInstanceLockAt(lockPath)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestDaemonRestartChildEnvReplacesReadyPathAcrossConsecutiveRestarts(t *testing.T) {
	t.Setenv("POCKETCTL_RESTART_READY_FILE", "/consumed")
	if got := consumeRestartReadyEnv(); got != "/consumed" {
		t.Fatalf("consumed=%q", got)
	}
	if _, exists := os.LookupEnv("POCKETCTL_RESTART_READY_FILE"); exists {
		t.Fatal("consumed restart env remained set")
	}
	env := []string{"A=1", "POCKETCTL_RESTART_READY_FILE=/first", "POCKETCTL_RESTART_READY_FILE=/older"}
	for _, want := range []string{"/second", "/third"} {
		env = restartChildEnv(env, want)
		count := 0
		for _, item := range env {
			if strings.HasPrefix(item, "POCKETCTL_RESTART_READY_FILE=") {
				count++
				if item != "POCKETCTL_RESTART_READY_FILE="+want {
					t.Fatalf("ready=%q want %q", item, want)
				}
			}
		}
		if count != 1 {
			t.Fatalf("ready entries=%d env=%v", count, env)
		}
	}
}

func TestDaemonRestartPostReadyChildDeathIsRejected(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "ready")
	cmd := exec.Command("sh", "-c", "echo $$ > \"$1.heartbeat\"", "sh", ready)
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if err := waitForRestartReady(ready, cmd.Process.Pid, 250*time.Millisecond); err == nil {
		t.Fatal("accepted dead child after one ready write")
	}
}

func TestDaemonRestartChildDeathAfterSecondHeartbeatIsRejected(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "ready")
	cmd := exec.Command("sh", "-c", "echo $$ > \"$1.heartbeat\"; sleep 0.1; echo $$ > \"$1.heartbeat\"; sleep 0.03", "sh", ready)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if err := waitForRestartReady(ready, cmd.Process.Pid, 500*time.Millisecond); err == nil {
		_ = cmd.Process.Kill()
		t.Fatal("accepted child that died after second heartbeat")
	}
	_ = cmd.Wait()
}

func TestDaemonRestartHeartbeatCannotOverwriteChallenge(t *testing.T) {
	base := filepath.Join(t.TempDir(), "ready")
	childDone := make(chan error, 1)
	go func() {
		_, err := waitForRestartOwnership(base, 750*time.Millisecond, func() (io.Closer, error) {
			return nil, errors.New("old daemon still owns instance lock")
		})
		childDone <- err
	}()
	if err := waitForRestartReady(base, os.Getpid(), 500*time.Millisecond); err != nil {
		t.Fatal(err)
	}

	challengePath := base + ".challenge"
	challenge, err := os.ReadFile(challengePath)
	if err != nil {
		t.Fatalf("challenge did not survive readiness handshake: %v", err)
	}
	wantAck := fmt.Sprintf("%d:%s", os.Getpid(), strings.TrimSpace(string(challenge)))
	ack, err := os.ReadFile(base + ".ack")
	if err != nil || strings.TrimSpace(string(ack)) != wantAck {
		t.Fatalf("ack=%q err=%v want %q", ack, err, wantAck)
	}
	challengeInfo, err := os.Stat(challengePath)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(300 * time.Millisecond)
	for {
		heartbeatInfo, statErr := os.Stat(base + ".heartbeat")
		if statErr == nil && heartbeatInfo.ModTime().After(challengeInfo.ModTime()) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not publish a heartbeat after challenge publication")
		}
		time.Sleep(10 * time.Millisecond)
	}
	challengeAfter, err := os.ReadFile(challengePath)
	if err != nil || string(challengeAfter) != string(challenge) {
		t.Fatalf("heartbeat altered challenge: before=%q after=%q err=%v", challenge, challengeAfter, err)
	}
	if err := <-childDone; err == nil {
		t.Fatal("ownership waiter unexpectedly acquired the instance lock")
	}
}

func TestDaemonRestartTerminationWaitsBeforeCleaningHandshakeFiles(t *testing.T) {
	if os.Getenv("POCKETCTL_RESTART_HEARTBEAT_HELPER") == "1" {
		base := os.Getenv("POCKETCTL_RESTART_HEARTBEAT_BASE")
		for {
			if err := os.WriteFile(base+".heartbeat", []byte(fmt.Sprintf("%d", os.Getpid())), 0o600); err != nil {
				os.Exit(2)
			}
			time.Sleep(time.Millisecond)
		}
	}
	base := filepath.Join(t.TempDir(), "ready")
	cmd := exec.Command(os.Args[0], "-test.run=^TestDaemonRestartTerminationWaitsBeforeCleaningHandshakeFiles$")
	cmd.Env = append(os.Environ(),
		"POCKETCTL_RESTART_HEARTBEAT_HELPER=1",
		"POCKETCTL_RESTART_HEARTBEAT_BASE="+base,
	)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	// This helper starts a second race-instrumented copy of the test binary.
	// Under the full release gate the host can still be compiling/running other
	// packages, so process startup itself may legitimately take over one second.
	// Keep this setup timeout aligned with the sibling restart-process test;
	// the behavior under test begins only after the heartbeat is visible.
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(base + ".heartbeat"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			terminateRestartChild(cmd.Process, base)
			t.Fatal("restart child did not publish heartbeat")
		}
		time.Sleep(5 * time.Millisecond)
	}
	terminateRestartChild(cmd.Process, base)
	for _, path := range []string{base, base + ".heartbeat", base + ".challenge", base + ".ack"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("restart termination left handshake artifact %s: %v", path, err)
		}
	}
}

func TestDaemonRestartStopIntentWinsBothInterleavings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	lockPath := filepath.Join(t.TempDir(), "lock")
	// Replacement claims first, then explicit stop publishes intent: the claim
	// must be released before any daemon/serve startup can continue.
	claimed, err := daemon.AcquireInstanceLockAt(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = daemon.BeginExplicitStopTransaction()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := finalizeRestartOwnership(claimed); err == nil {
		t.Fatal("claimed replacement ignored stop intent")
	}
	probe, err := daemon.AcquireInstanceLockAt(lockPath)
	if err != nil {
		t.Fatalf("replacement claim not released: %v", err)
	}
	probe.Close()
	// Stop intent first: a waiting replacement must never claim even when the
	// old lock is already free.
	if err := daemon.WriteOpenCodeServeState(&daemon.OpenCodeServeState{PID: 99999999, BaseURL: "http://127.0.0.1:1", Password: "dead", Version: "1.2.3", OwnerPID: 1, UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := daemon.CleanupOpenCodeServeAfterForcedStop(); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(t.TempDir(), "ready")
	if _, err := waitForRestartOwnership(ready, 100*time.Millisecond, func() (io.Closer, error) { return daemon.AcquireInstanceLockAt(lockPath) }); err == nil {
		t.Fatal("replacement proceeded while stop intent active")
	}
	if _, err := os.Stat(daemon.OpenCodeServeStatePath()); !os.IsNotExist(err) {
		t.Fatalf("credential state remains after stop-first ordering: %v", err)
	}
}

func TestDaemonNormalStartClearsOnlyCompletedStopIntent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	active, err := daemon.BeginExplicitStopTransaction()
	if err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(t.TempDir(), "lock")
	owner, err := daemon.AcquireInstanceLockAt(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := daemon.AcquireInstanceLockAt(lockPath); err == nil {
		t.Fatal("start acquired active daemon ownership")
	}
	if !daemon.ExplicitStopIntentActive() {
		t.Fatal("active stop marker was cleared")
	}
	owner.Close()
	if err := daemon.CompleteExplicitStopTransaction(active.Token); err != nil {
		t.Fatal(err)
	}
	complete, exists, err := daemon.ObserveStopIntent()
	if err != nil || !exists {
		t.Fatalf("complete intent=%+v exists=%v err=%v", complete, exists, err)
	}
	claimed, err := daemon.AcquireInstanceLockAt(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer claimed.Close()
	if err := daemon.PublishDaemonPID(303, false, &complete); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(daemon.PIDPath())
	if daemon.ExplicitStopIntentActive() {
		t.Fatal("completed stop marker remains")
	}
}

type restartPreparerStub struct {
	called bool
	err    error
}

func (s *restartPreparerStub) PrepareDaemonRestart() error { s.called = true; return s.err }

func TestDaemonRestartRequiresSuccessfulOpenCodeHandoff(t *testing.T) {
	ok := &restartPreparerStub{}
	if err := prepareDaemonRestart(ok); err != nil || !ok.called {
		t.Fatalf("prepare=%v called=%v", err, ok.called)
	}
	want := errors.New("handoff failed")
	bad := &restartPreparerStub{err: want}
	if err := prepareDaemonRestart(bad); !errors.Is(err, want) {
		t.Fatalf("error=%v want %v", err, want)
	}
}

func TestUpgradeGateDecision(t *testing.T) {
	cases := []struct {
		name        string
		found       bool
		manageable  bool
		agentName   string
		path        string
		wantProceed bool
		wantStatus  string
		wantReason  string
		wantErr     string
	}{
		{
			name:        "not installed",
			found:       false,
			manageable:  false,
			agentName:   "claude-code",
			path:        "",
			wantProceed: false,
			wantStatus:  "failed",
			wantReason:  "",
			wantErr:     "claude-code 未安装",
		},
		{
			name:        "system root-owned install",
			found:       true,
			manageable:  false,
			agentName:   "claude-code",
			path:        "/usr/local/bin/claude",
			wantProceed: false,
			wantStatus:  "failed",
			wantReason:  protocol.ReasonPermissionDenied,
			wantErr:     "/usr/local/bin/claude 为系统(root)安装，pocketctl 无法升级，请自行 sudo-free 升级",
		},
		{
			name:        "manageable user install proceeds",
			found:       true,
			manageable:  true,
			agentName:   "claude-code",
			path:        "/Users/me/.local/bin/claude",
			wantProceed: true,
			wantStatus:  "",
			wantReason:  "",
			wantErr:     "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			proceed, status, reason, errMsg := upgradeGateDecision(tc.found, tc.manageable, tc.agentName, tc.path)
			if proceed != tc.wantProceed {
				t.Errorf("proceed = %v, want %v", proceed, tc.wantProceed)
			}
			if status != tc.wantStatus {
				t.Errorf("status = %q, want %q", status, tc.wantStatus)
			}
			if reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", reason, tc.wantReason)
			}
			if errMsg != tc.wantErr {
				t.Errorf("errMsg = %q, want %q", errMsg, tc.wantErr)
			}
		})
	}

	// reason must be permission_denied ONLY for the !manageable case.
	if _, _, reason, _ := upgradeGateDecision(false, false, "x", ""); reason != "" {
		t.Errorf("!found reason should be empty, got %q", reason)
	}
	if _, _, reason, _ := upgradeGateDecision(true, false, "x", "/p"); reason != protocol.ReasonPermissionDenied {
		t.Errorf("!manageable reason should be permission_denied, got %q", reason)
	}
}

func TestIsPermissionDenied(t *testing.T) {
	for _, s := range []string{"npm ERR! EACCES", "Error: EPERM", "permission denied", "Insufficient permissions"} {
		if !isPermissionDenied(s) {
			t.Errorf("expected permission-denied for %q", s)
		}
	}
	for _, s := range []string{"network timeout", "404 not found", ""} {
		if isPermissionDenied(s) {
			t.Errorf("unexpected permission-denied for %q", s)
		}
	}
}

func TestClassifyCreateErrorBadCwd(t *testing.T) {
	for _, msg := range []string{
		"工作目录不存在: /Users/me/projcts/pocketctl-test",
		"工作目录创建失败: /Users/me/projcts/pocketctl-test (mkdir /Users/me/projcts: permission denied)",
		"工作目录无法访问: /Users/me/repo (permission denied)",
	} {
		if got := classifyCreateError(msg); got != "bad_cwd" {
			t.Errorf("classifyCreateError(%q) = %q, want bad_cwd", msg, got)
		}
	}
}

func TestClassifyCreateErrorUnsupportedAgent(t *testing.T) {
	if got := classifyCreateError("unsupported_agent: future-agent"); got != "unsupported_agent" {
		t.Fatalf("classifyCreateError() = %q, want unsupported_agent", got)
	}
}

// TestStartSpinnerNonTTY verifies the spinner degrades cleanly when stdout is
// not a terminal: it prints the message once (no escape codes), and the
// returned stop function is safe to call.
func TestStartSpinnerNonTTY(t *testing.T) {
	// In `go test`, os.Stdout is a pipe (not a char device), so startSpinner
	// takes the non-TTY branch.
	stop := startSpinner("starting test")
	if stop == nil {
		t.Fatal("startSpinner returned nil stop func")
	}
	stop() // must not panic or block
}

func TestPruneOrphanSpools(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	const id = "daemon-abc123"
	mk(id + ".log")         // current — keep
	mk(id + ".log.tmp")     // current's transient rewrite — keep
	mk("daemon-old111.log") // orphan — remove
	mk("daemon-old222.log") // orphan — remove
	mk("notes.txt")         // unrelated — keep

	pruneOrphanSpools(dir, id, slog.New(slog.NewTextHandler(io.Discard, nil)))

	got := map[string]bool{}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		got[e.Name()] = true
	}
	for _, want := range []string{id + ".log", id + ".log.tmp", "notes.txt"} {
		if !got[want] {
			t.Errorf("expected %q kept, but it was removed", want)
		}
	}
	for _, gone := range []string{"daemon-old111.log", "daemon-old222.log"} {
		if got[gone] {
			t.Errorf("expected orphan %q removed, but it remains", gone)
		}
	}
}

func TestReconnectDiscoveryEventIsMarkedAsResync(t *testing.T) {
	lastActivity := time.Date(2026, time.August, 1, 12, 30, 0, 0, time.UTC)
	event := reconnectDiscoveryEvent(session.SessionInfo{
		SessionID:      "session-a",
		Cwd:            "/tmp/project",
		Status:         protocol.StatusCompleted,
		Agent:          "codex",
		Model:          "gpt-5.3-codex",
		LastActivityAt: lastActivity,
	})

	if event.Type != "session_discovered" || !event.Resync {
		t.Fatalf("event = %#v, want resync session_discovered", event)
	}
	if event.SessionID != "session-a" || event.Source != "terminal" {
		t.Fatalf("event = %#v, want session identity and source preserved", event)
	}
	if event.LastActivityAt != lastActivity.Format(time.RFC3339Nano) {
		t.Fatalf("last_activity_at=%q, want %q", event.LastActivityAt, lastActivity.Format(time.RFC3339Nano))
	}
}

func TestTerminalJSONLTailAfterExitDoesNotReviveSession(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_JSONL_V2", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	const sessionID = "claude-exit-tail-session"
	const cwd = "/work/exit-tail"
	rolloutDir := filepath.Join(home, ".claude", "projects", "-work-exit-tail")
	if err := os.MkdirAll(rolloutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(rolloutDir, sessionID+".jsonl")
	initial := `{"type":"assistant","sessionId":"` + sessionID + `","message":{"role":"assistant","content":[{"type":"text","text":"before exit"}]}}` + "\n"
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}

	input := make(chan watcher.SessionEvent, 1)
	output := make(chan protocol.DaemonEvent, 32)
	sm := session.NewSessionManager(output)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go handleWatcherEvents(ctx, input, adapter.AgentClaude, sm, watcher.NewProcessMonitor(), output,
		slog.New(slog.NewTextHandler(io.Discard, nil)), &atomic.Bool{})
	input <- watcher.SessionEvent{
		Action:   "discovered",
		Filepath: path,
		Session: watcher.DiscoveredSession{
			SessionID: sessionID, Cwd: cwd, Status: protocol.StatusRunning,
			AgentType: adapter.AgentClaude, Source: "terminal",
		},
	}

	waitForEvent := func(wantType, wantText string) protocol.DaemonEvent {
		t.Helper()
		deadline := time.After(4 * time.Second)
		for {
			select {
			case event := <-output:
				if event.Type == wantType && (wantText == "" || event.Text == wantText) {
					return event
				}
			case <-deadline:
				t.Fatalf("timed out waiting for %s %q", wantType, wantText)
			}
		}
	}
	waitForEvent("session_discovered", "")
	waitForEvent("agent_text", "before exit")

	sm.SetSessionExited(sessionID, protocol.ExitReasonNormalExit)
	exited := waitForEvent("session_status", "")
	for exited.Status != protocol.StatusExited {
		exited = waitForEvent("session_status", "")
	}
	if exited.Status != protocol.StatusExited || exited.ExitReason != protocol.ExitReasonNormalExit {
		t.Fatalf("exit event=%+v", exited)
	}

	tail := `{"type":"user","sessionId":"` + sessionID + `","message":{"role":"user","content":"/exit"}}` + "\n" +
		`{"type":"assistant","sessionId":"` + sessionID + `","message":{"role":"assistant","content":[{"type":"text","text":"Catch you later!"}]}}` + "\n"
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(tail); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	seenTail := map[string]bool{}
	runningPublished := false
	deadline := time.After(4 * time.Second)
	for !seenTail["/exit"] || !seenTail["Catch you later!"] {
		select {
		case event := <-output:
			if event.Type == "session_status" && event.Status == protocol.StatusRunning {
				runningPublished = true
			}
			if event.Type == "user_text" || event.Type == "agent_text" {
				seenTail[event.Text] = true
			}
		case <-deadline:
			t.Fatalf("timed out waiting for exit tail messages: seen=%v", seenTail)
		}
	}

	if runningPublished {
		t.Fatal("JSONL exit tail published a false running status")
	}
	sessions := sm.ListSessions()
	if len(sessions) != 1 || sessions[0].Status != protocol.StatusExited {
		t.Fatalf("session after exit tail=%+v, want exited", sessions)
	}
}

func TestClaudeWatcherRemovedMarksSessionStateDirty(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := session.NewSessionManager(output)
	if !sm.RegisterTerminalSession(
		"removed-session", "/work/project", 0, "", protocol.StatusIdle, adapter.AgentClaude,
	) {
		t.Fatal("terminal session was not registered")
	}

	input := make(chan watcher.SessionEvent, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var stateDirty atomic.Bool
	go handleWatcherEvents(ctx, input, adapter.AgentClaude, sm, watcher.NewProcessMonitor(), output,
		slog.New(slog.NewTextHandler(io.Discard, nil)), &stateDirty)
	input <- watcher.SessionEvent{
		Action: "removed",
		Session: watcher.DiscoveredSession{
			SessionID: "removed-session", Status: protocol.StatusIdle,
			AgentType: adapter.AgentClaude, Source: "terminal",
		},
	}

	select {
	case event := <-output:
		if event.Type != "session_status" || event.Status != protocol.StatusExited {
			t.Fatalf("removed event=%+v, want exited session_status", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for removed session status")
	}
	if !stateDirty.Load() {
		t.Fatal("removed watcher event did not mark daemon state dirty")
	}
}

func TestCodexDesktopWatcherPublishesObserverWhileParsingCodexHistory(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	dayDir := filepath.Join(codexHome, "sessions", "2026", "09", "04")
	if err := os.MkdirAll(dayDir, 0o755); err != nil {
		t.Fatal(err)
	}
	const sessionID = "desktop-observer-session"
	path := filepath.Join(dayDir, "rollout-2026-09-04T08-09-10-"+sessionID+".jsonl")
	rollout := strings.Join([]string{
		`{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"/work/desktop","originator":"Codex Desktop"}}`,
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"inspect desktop history"}}`,
		`{"type":"event_msg","payload":{"type":"agent_message","message":"desktop answer","phase":"final_answer"}}`,
		`{"type":"response_item","payload":{"type":"function_call","call_id":"call-desktop","name":"exec","arguments":"{\"cmd\":\"pwd\"}"}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-desktop","output":"/work/desktop"}}`,
		`{"type":"event_msg","payload":{"type":"token_count","last_token_usage":{"input_tokens":21,"output_tokens":8}}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(rollout), 0o600); err != nil {
		t.Fatal(err)
	}
	activity := time.Date(2025, time.September, 4, 8, 9, 10, 123000000, time.UTC)
	if err := os.Chtimes(path, activity, activity); err != nil {
		t.Fatal(err)
	}

	input := make(chan watcher.SessionEvent, 1)
	output := make(chan protocol.DaemonEvent, 32)
	sm := session.NewSessionManager(output)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go handleWatcherEvents(ctx, input, adapter.AgentCodex, sm, watcher.NewProcessMonitor(), output,
		slog.New(slog.NewTextHandler(io.Discard, nil)), &atomic.Bool{})
	input <- watcher.SessionEvent{
		Action:   "discovered",
		Filepath: path,
		Session: watcher.DiscoveredSession{
			SessionID: sessionID, Cwd: "/work/desktop", Status: protocol.StatusBusy,
			AgentType: adapter.AgentCodexDesktop, Source: "observer",
			ControlMode: protocol.ControlLegacyReadOnly, Capabilities: []string{"history_sync"},
		},
	}

	deadline := time.After(4 * time.Second)
	var discovery protocol.DaemonEvent
	seen := map[string]bool{}
	for discovery.Type == "" || !seen["user_text"] || !seen["agent_text"] ||
		!seen["tool_call"] || !seen["tool_result"] || !seen["usage"] || !seen["model"] {
		select {
		case event := <-output:
			if event.Type == "session_discovered" {
				discovery = event
			}
			switch event.Type {
			case "user_text", "agent_text", "tool_call", "tool_result":
				seen[event.Type] = true
			case "session_model_changed":
				if event.Model == "gpt-5.6" {
					seen["model"] = true
				}
			}
			if event.Usage != nil && event.Usage.InputTokens == 21 && event.Usage.OutputTokens == 8 {
				seen["usage"] = true
			}
		case <-deadline:
			t.Fatalf("timed out: discovery=%+v parsed=%v", discovery, seen)
		}
	}

	if discovery.Agent != adapter.AgentCodexDesktop || discovery.Source != "observer" ||
		discovery.ControlMode != protocol.ControlLegacyReadOnly ||
		!reflect.DeepEqual(discovery.Capabilities, []string{"history_sync"}) {
		t.Fatalf("Desktop discovery = %+v", discovery)
	}
	if discovery.LastActivityAt != activity.Format(time.RFC3339Nano) {
		t.Fatalf("Desktop activity=%q, want JSONL mtime %q", discovery.LastActivityAt, activity.Format(time.RFC3339Nano))
	}
	if agent, ok := sm.GetSessionAgent(sessionID); !ok || agent != adapter.AgentCodexDesktop {
		t.Fatalf("session agent=%q ok=%v, want codex-desktop", agent, ok)
	}

	appendRecord := func(record string) {
		t.Helper()
		file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.WriteString(record + "\n"); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	waitStatus := func(want string) {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case event := <-output:
				if event.Type == "session_status" && event.SessionID == sessionID && event.Status == want {
					return
				}
			case <-deadline:
				t.Fatalf("timed out waiting for fresh Desktop status %q", want)
			}
		}
	}
	appendRecord(`{"type":"event_msg","payload":{"type":"task_started","turn_id":"desktop-fresh-turn"}}`)
	waitStatus(protocol.StatusRunning)
	if sessions := sm.ListSessions(); len(sessions) != 1 || sessions[0].Status != protocol.StatusRunning ||
		sessions[0].Agent != adapter.AgentCodexDesktop || sessions[0].Source != "observer" ||
		sessions[0].ControlMode != protocol.ControlLegacyReadOnly {
		t.Fatalf("observer state after fresh task_started=%+v, want running", sessions)
	}
	appendRecord(`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"desktop-fresh-turn"}}`)
	waitStatus(protocol.StatusIdle)

	sessions := sm.ListSessions()
	if len(sessions) != 1 || sessions[0].Status != protocol.StatusIdle ||
		sessions[0].Agent != adapter.AgentCodexDesktop || sessions[0].Source != "observer" ||
		sessions[0].ControlMode != protocol.ControlLegacyReadOnly ||
		!reflect.DeepEqual(sessions[0].Capabilities, []string{"history_sync"}) {
		t.Fatalf("observer list after fresh task_complete=%+v, want idle", sessions)
	}
	if reconnect := reconnectDiscoveryEvent(sessions[0]); reconnect.Status != protocol.StatusIdle {
		t.Fatalf("observer reconnect status=%q, want idle", reconnect.Status)
	}
	sm.ResyncSessions()
	for {
		select {
		case event := <-output:
			if event.Type == "session_discovered" && event.Resync && event.SessionID == sessionID {
				if event.Status != protocol.StatusIdle {
					t.Fatalf("observer resync status=%q, want idle", event.Status)
				}
				return
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for observer resync")
		}
	}
}

func TestReconnectDiscoveryPreservesCodexDesktopObserverClassification(t *testing.T) {
	activity := time.Date(2025, time.September, 4, 8, 9, 10, 123000000, time.UTC)
	event := reconnectDiscoveryEvent(session.SessionInfo{
		SessionID:      "desktop-reconnect",
		Cwd:            "/work/desktop",
		Status:         protocol.StatusBusy,
		Agent:          adapter.AgentCodexDesktop,
		Source:         "observer",
		Model:          "gpt-5.6",
		LastActivityAt: activity,
		ControlMode:    protocol.ControlLegacyReadOnly,
		Capabilities:   []string{"history_sync"},
	})

	if event.Agent != adapter.AgentCodexDesktop || event.Source != "observer" ||
		event.ControlMode != protocol.ControlLegacyReadOnly ||
		!reflect.DeepEqual(event.Capabilities, []string{"history_sync"}) || !event.Resync {
		t.Fatalf("Desktop reconnect discovery = %+v", event)
	}
	if event.LastActivityAt != activity.Format(time.RFC3339Nano) {
		t.Fatalf("Desktop reconnect activity=%q", event.LastActivityAt)
	}
}

func TestCodexDesktopSameIDReclassificationPublishesWithoutSecondTailer(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	const sessionID = "desktop-reclassified-live"
	rolloutDir := filepath.Join(codexHome, "sessions", "2026", "09", "04")
	if err := os.MkdirAll(rolloutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(rolloutDir, "rollout-2026-09-04T13-00-00-"+sessionID+".jsonl")
	lines := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"/work/desktop","originator":"Codex Desktop"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"user_message","message":"must not be tailed twice"}}` + "\n"
	if err := os.WriteFile(path, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}

	output := make(chan protocol.DaemonEvent, 16)
	sm := session.NewSessionManager(output)
	if !sm.RegisterTerminalSession(sessionID, "/work/old", 0, "", protocol.StatusIdle, adapter.AgentCodex) {
		t.Fatal("legacy Codex state was not registered")
	}
	existingTailer, err := watcher.NewJSONLTailerFromStart(path, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer existingTailer.Close()
	sm.SetTailer(sessionID, existingTailer)
	activity := time.Date(2025, time.September, 4, 13, 0, 0, 0, time.UTC)
	if _, ok := sm.RestoreSessionActivity(sessionID, activity); !ok {
		t.Fatal("legacy Codex activity was not restored")
	}

	input := make(chan watcher.SessionEvent, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go handleWatcherEvents(ctx, input, adapter.AgentCodex, sm, watcher.NewProcessMonitor(), output,
		slog.New(slog.NewTextHandler(io.Discard, nil)), &atomic.Bool{})
	input <- watcher.SessionEvent{
		Action:   "discovered",
		Filepath: path,
		Session: watcher.DiscoveredSession{
			SessionID: sessionID, Cwd: "/work/desktop", Status: protocol.StatusBusy,
			AgentType: adapter.AgentCodexDesktop, Source: "observer",
			ControlMode: protocol.ControlLegacyReadOnly, Capabilities: []string{"history_sync"},
		},
	}

	var discovery protocol.DaemonEvent
	select {
	case discovery = <-output:
	case <-time.After(2 * time.Second):
		t.Fatal("same-ID Desktop reclassification did not publish session_discovered")
	}
	if discovery.Type != "session_discovered" || discovery.Resync ||
		discovery.Agent != adapter.AgentCodexDesktop || discovery.Source != "observer" ||
		discovery.ControlMode != protocol.ControlLegacyReadOnly ||
		!reflect.DeepEqual(discovery.Capabilities, []string{"history_sync"}) {
		t.Fatalf("reclassification discovery=%+v", discovery)
	}
	if discovery.LastActivityAt != activity.Format(time.RFC3339Nano) {
		t.Fatalf("reclassification activity=%q, want preserved %q", discovery.LastActivityAt, activity.Format(time.RFC3339Nano))
	}
	if sessions := sm.ListSessions(); len(sessions) != 1 || sessions[0].Agent != adapter.AgentCodexDesktop {
		t.Fatalf("same-ID reclassification created the wrong state set: %+v", sessions)
	}

	select {
	case event := <-output:
		t.Fatalf("same-ID reclassification started a duplicate history tailer: %+v", event)
	case <-time.After(1200 * time.Millisecond):
	}
}

func TestCodexDesktopSameIDReclassificationStartsMissingHistoryTailer(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	const sessionID = "desktop-reclassified-missing-tailer"
	rolloutDir := filepath.Join(codexHome, "sessions", "2026", "09", "05")
	if err := os.MkdirAll(rolloutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(rolloutDir, "rollout-2026-09-05T07-33-36-"+sessionID+".jsonl")
	lines := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"/work/desktop","originator":"Codex Desktop","source":"vscode"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"user_message","message":"history user prompt"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"agent_message","message":"history assistant reply"}}` + "\n"
	if err := os.WriteFile(path, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}

	output := make(chan protocol.DaemonEvent, 16)
	sm := session.NewSessionManager(output)
	if !sm.RegisterTerminalSession(sessionID, "/work/desktop", 0, "", protocol.StatusIdle, adapter.AgentCodex) {
		t.Fatal("provisional Codex state was not registered")
	}

	input := make(chan watcher.SessionEvent, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go handleWatcherEvents(ctx, input, adapter.AgentCodex, sm, watcher.NewProcessMonitor(), output,
		slog.New(slog.NewTextHandler(io.Discard, nil)), &atomic.Bool{})
	input <- watcher.SessionEvent{
		Action:   "discovered",
		Filepath: path,
		Session: watcher.DiscoveredSession{
			SessionID: sessionID, Cwd: "/work/desktop", Status: protocol.StatusBusy,
			AgentType: adapter.AgentCodexDesktop, Source: "observer",
			ControlMode: protocol.ControlLegacyReadOnly, Capabilities: []string{"history_sync"},
		},
	}

	want := map[string]string{
		"user_text":  "history user prompt",
		"agent_text": "history assistant reply",
	}
	deadline := time.After(3 * time.Second)
	for len(want) > 0 {
		select {
		case event := <-output:
			if text, ok := want[event.Type]; ok && event.Text == text {
				delete(want, event.Type)
			}
		case <-deadline:
			t.Fatalf("timed out waiting for reclassified Desktop history: missing=%v", want)
		}
	}

	sessions := sm.ListSessions()
	if len(sessions) != 1 || sessions[0].Agent != adapter.AgentCodexDesktop ||
		sessions[0].Source != "observer" || sessions[0].ControlMode != protocol.ControlLegacyReadOnly {
		t.Fatalf("reclassified observer state=%+v", sessions)
	}
}

func TestReconnectDiscoveryEventCarriesExplicitRepositoryFacts(t *testing.T) {
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init", repo},
		{"-C", repo, "remote", "add", "origin", "git@gitee.com:muwb123/pocketctl.git"},
		{"-C", repo, "config", "user.name", "PocketCtl Test"},
		{"-C", repo, "config", "user.email", "test@pocketctl.invalid"},
		{"-C", repo, "commit", "--allow-empty", "-m", "initial"},
	} {
		if output, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}

	event := reconnectDiscoveryEvent(session.SessionInfo{
		SessionID: "session-repository", Cwd: repo, Status: protocol.StatusIdle, Agent: adapter.AgentCodex,
	})
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	if got := payload["repository_id"]; got != "gitee.com/muwb123/pocketctl" {
		t.Fatalf("repository_id = %#v, want explicit canonical remote", got)
	}
	if branch, ok := payload["branch"].(string); !ok || branch == "" || branch == "HEAD" {
		t.Fatalf("branch = %#v, want current symbolic branch", payload["branch"])
	}
	if commit, ok := payload["commit_sha"].(string); !ok || len(commit) != 40 {
		t.Fatalf("commit_sha = %#v, want full Git commit", payload["commit_sha"])
	}
	if _, leaked := payload["cwd_fingerprint"]; leaked {
		t.Fatalf("unexpected cwd-derived identity in payload: %#v", payload)
	}
}

func TestObserveTerminalLifecycleUpdatesReconnectState(t *testing.T) {
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.RegisterTerminalSession(
		"codex-terminal", "/tmp/project", 0, "", protocol.StatusIdle, adapter.AgentCodex,
	)
	restoredActivity := time.Date(2026, 9, 4, 6, 7, 8, 0, time.UTC)
	if _, ok := sm.RestoreSessionActivity("codex-terminal", restoredActivity); !ok {
		t.Fatal("terminal activity fixture was not restored")
	}

	if updated := observeJSONLLifecycle(sm, protocol.DaemonEvent{
		Type: "session_status", SessionID: "codex-terminal", Status: protocol.StatusRunning,
	}); !updated {
		t.Fatal("terminal lifecycle event did not update local state")
	}

	var current session.SessionInfo
	for _, info := range sm.ListSessions() {
		if info.SessionID == "codex-terminal" {
			current = info
			break
		}
	}
	if current.Status != protocol.StatusRunning {
		t.Fatalf("local status = %q, want running", current.Status)
	}
	if !current.LastActivityAt.After(restoredActivity) {
		t.Fatalf("live task_started activity = %v, want after restored %v", current.LastActivityAt, restoredActivity)
	}
	resync := reconnectDiscoveryEvent(current)
	if !resync.Resync || resync.Status != protocol.StatusRunning {
		t.Fatalf("reconnect event = %+v, want resync running", resync)
	}
	runningActivity := current.LastActivityAt
	if updated := observeJSONLLifecycle(sm, protocol.DaemonEvent{
		Type: "session_status", SessionID: "codex-terminal", Status: protocol.StatusIdle,
	}); !updated {
		t.Fatal("live task_complete lifecycle event did not update local state")
	}
	for _, info := range sm.ListSessions() {
		if info.SessionID == "codex-terminal" {
			current = info
			break
		}
	}
	if current.Status != protocol.StatusIdle || current.LastActivityAt.Before(runningActivity) {
		t.Fatalf("live task_complete state = %+v, want idle with monotonic activity", current)
	}

	if updated := observeJSONLLifecycle(sm, protocol.DaemonEvent{
		Type: "agent_text", SessionID: "codex-terminal", Text: "working",
	}); updated {
		t.Fatal("non-lifecycle event unexpectedly updated terminal status")
	}
}

func TestObserveJSONLLifecycleIgnoresHistoricalResyncStatus(t *testing.T) {
	tests := []struct {
		name     string
		session  string
		register func(*session.SessionManager, string)
	}{
		{
			name:    "terminal",
			session: "codex-terminal-history",
			register: func(sm *session.SessionManager, sessionID string) {
				sm.RegisterTerminalSession(
					sessionID, "/tmp/terminal", 0, "", protocol.StatusBusy, adapter.AgentCodex,
				)
			},
		},
		{
			name:    "desktop observer",
			session: "codex-desktop-history",
			register: func(sm *session.SessionManager, sessionID string) {
				if got := sm.RegisterObservedSession(
					sessionID, "/tmp/desktop", protocol.StatusBusy, adapter.AgentCodexDesktop,
				); got != session.ObservedSessionNew {
					t.Fatalf("observer registration = %v, want new", got)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 1))
			tt.register(sm, tt.session)
			restoredActivity := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
			if _, ok := sm.RestoreSessionActivity(tt.session, restoredActivity); !ok {
				t.Fatal("history activity fixture was not restored")
			}

			if updated := observeJSONLLifecycle(sm, protocol.DaemonEvent{
				Type: "session_status", SessionID: tt.session,
				Status: protocol.StatusCompleted, Resync: true,
			}); updated {
				t.Fatal("historical resync status mutated live lifecycle state")
			}

			var current session.SessionInfo
			for _, info := range sm.ListSessions() {
				if info.SessionID == tt.session {
					current = info
					break
				}
			}
			if current.Status != protocol.StatusBusy {
				t.Fatalf("hydration status = %q, want watcher snapshot busy", current.Status)
			}
			if !current.LastActivityAt.Equal(restoredActivity) {
				t.Fatalf("hydration activity = %v, want restored JSONL mtime %v", current.LastActivityAt, restoredActivity)
			}
			discovery := reconnectDiscoveryEvent(current)
			if discovery.Status != protocol.StatusBusy || discovery.LastActivityAt != restoredActivity.Format(time.RFC3339Nano) {
				t.Fatalf("reconnect snapshot = %+v, want preserved watcher status and mtime", discovery)
			}
		})
	}
}

func TestTerminalHydrationEventsKeepsCurrentStatusAuthoritative(t *testing.T) {
	events := []protocol.DaemonEvent{
		{Type: "agent_text", Text: "historical answer"},
		{Type: "session_status", Status: protocol.StatusCompleted},
		{Type: "tool_result", Output: "historical output"},
	}

	got := terminalHydrationEvents(events, "session-a", protocol.StatusBusy)
	if len(got) != 3 {
		t.Fatalf("events=%+v, want two historical content events and one authoritative status", got)
	}
	if got[0].Type != "agent_text" || got[1].Type != "tool_result" {
		t.Fatalf("historical content order changed: %+v", got)
	}
	if got[2].Type != "session_status" || got[2].SessionID != "session-a" || got[2].Status != protocol.StatusBusy {
		t.Fatalf("final event=%+v, want authoritative busy status", got[2])
	}
	for _, event := range got {
		if !event.Resync {
			t.Fatalf("hydrated event=%+v, want resync=true", event)
		}
	}
}

func TestTerminalHydrationEventsOmitsMissingStatus(t *testing.T) {
	got := terminalHydrationEvents([]protocol.DaemonEvent{
		{Type: "agent_text", Text: "historical answer"},
	}, "session-a", "")
	if len(got) != 1 || got[0].Type != "agent_text" || !got[0].Resync {
		t.Fatalf("events=%+v, want only historical content", got)
	}
}

func TestNormalizeClaudeWatcherSessionStatus(t *testing.T) {
	session := watcher.DiscoveredSession{Pid: 1234}
	normalizeWatcherSessionStatus(adapter.AgentClaude, &session)
	if session.Status != protocol.StatusIdle {
		t.Fatalf("status=%q, want idle", session.Status)
	}

	codex := watcher.DiscoveredSession{Pid: 1234}
	normalizeWatcherSessionStatus(adapter.AgentCodex, &codex)
	if codex.Status != "" {
		t.Fatalf("Codex status=%q, want unchanged", codex.Status)
	}
}

func TestCodexSubagentDiscoveryEvent(t *testing.T) {
	tests := []struct {
		name     string
		session  watcher.DiscoveredSession
		wantDesc string
	}{
		{
			name:     "nickname",
			session:  watcher.DiscoveredSession{SessionID: "child", RootSessionID: "root", AgentNickname: "Newton", AgentPath: "/root/task"},
			wantDesc: "Newton",
		},
		{
			name:     "agent path basename",
			session:  watcher.DiscoveredSession{SessionID: "child", RootSessionID: "root", AgentPath: "/root/keyboard_task2_impl"},
			wantDesc: "keyboard_task2_impl",
		},
		{
			name:     "short id",
			session:  watcher.DiscoveredSession{SessionID: "019f4ad3-342e-7213-a51f-2758edf9ec6b", RootSessionID: "root"},
			wantDesc: "edf9ec6b",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := codexSubagentDiscoveryEvent(tt.session)
			if got.Type != "subagent_discovered" || got.SessionID != "root" ||
				got.EventID != "codex-subagent:"+tt.session.SessionID+":discovery" ||
				got.AgentID != tt.session.SessionID || got.ParentSessionID != "root" ||
				got.RootSessionID != "root" || !got.IsSubagent || got.Agent != adapter.AgentCodex ||
				got.SubAgentType != adapter.AgentCodex || got.SubAgentDesc != tt.wantDesc {
				t.Fatalf("event = %+v", got)
			}
		})
	}
}

type recordingResumeShutdowner struct {
	mu       sync.Mutex
	calls    int
	err      error
	deadline time.Time
	bounded  bool
}

func (r *recordingResumeShutdowner) ShutdownResumeProcesses(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.deadline, r.bounded = ctx.Deadline()
	return r.err
}

func (r *recordingResumeShutdowner) snapshot() (int, time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	budget := time.Duration(0)
	if r.bounded {
		budget = time.Until(r.deadline)
	}
	return r.calls, budget
}

func newRestartTestLogger() (*slog.Logger, *bytes.Buffer) {
	buf := &bytes.Buffer{}
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelWarn})), buf
}

func TestNormalDaemonShutdownDrainsResumeBeforeAgentRuntimes(t *testing.T) {
	var mu sync.Mutex
	var order []string
	record := func(name string) func() {
		return func() {
			mu.Lock()
			defer mu.Unlock()
			order = append(order, name)
		}
	}
	shutdowner := &recordingResumeShutdowner{}

	runDaemonShutdownSequence(daemonShutdownSteps{
		ReleaseKeepAwake:  record("keepawake-release"),
		CloseKeepAwake:    record("keepawake-close"),
		CloseAgentControl: record("agentcontrol-close"),
		DrainResumes: func() {
			_ = drainResumeProcessesBeforeExit(context.Background(), shutdowner, slog.Default())
			record("drain-resumes")()
		},
		ShutdownCodex:     record("codex-shutdown"),
		StopZCodeObserver: record("zcode-stop"),
		ShutdownOpencode:  record("opencode-shutdown"),
	})

	mu.Lock()
	defer mu.Unlock()
	want := []string{
		"keepawake-release", "keepawake-close", "agentcontrol-close",
		"drain-resumes", "codex-shutdown", "zcode-stop", "opencode-shutdown",
	}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("shutdown order=%v, want %v", order, want)
	}
	if calls, _ := shutdowner.snapshot(); calls != 1 {
		t.Fatalf("resume drain calls=%d, want 1", calls)
	}
}

func TestHotRestartDrainsResumeAfterReplacementReadyBeforeExit(t *testing.T) {
	var mu sync.Mutex
	var order []string
	record := func(name string) func() { return func() { mu.Lock(); defer mu.Unlock(); order = append(order, name) } }
	shutdowner := &recordingResumeShutdowner{}
	logger, _ := newRestartTestLogger()

	runDaemonHotRestart(daemonRestartDeps{
		logger:     logger,
		activeStop: func() bool { return false },
		resolveExe: func() (string, error) { return "/pocketctl", nil },
		prepare:    func() error { return nil },
		spawnReplacement: func(string) (restartChildHandle, error) {
			record("spawn")()
			return restartChildHandle{pid: 4242}, nil
		},
		awaitReady: func(restartChildHandle) error {
			record("ready")()
			return nil
		},
		alive:            func(restartChildHandle) bool { return true },
		terminate:        func(restartChildHandle) { record("terminate")() },
		resumeShutdowner: shutdowner,
		exit:             func() { record("exit")() },
	})

	mu.Lock()
	defer mu.Unlock()
	want := []string{"spawn", "ready", "exit"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("restart order=%v, want %v (drain must complete before exit)", order, want)
	}
	if calls, _ := shutdowner.snapshot(); calls != 1 {
		t.Fatalf("resume drain calls=%d, want 1", calls)
	}
}

func TestHotRestartLogsTimeoutAndStillExitsAfterForceCleanup(t *testing.T) {
	var mu sync.Mutex
	exited := false
	shutdowner := &recordingResumeShutdowner{err: errors.New("resume shutdown: 1 of 1 owned processes were not reaped")}
	logger, buf := newRestartTestLogger()

	runDaemonHotRestart(daemonRestartDeps{
		logger:     logger,
		activeStop: func() bool { return false },
		resolveExe: func() (string, error) { return "/pocketctl", nil },
		prepare:    func() error { return nil },
		spawnReplacement: func(string) (restartChildHandle, error) {
			return restartChildHandle{pid: 4242}, nil
		},
		awaitReady:       func(restartChildHandle) error { return nil },
		alive:            func(restartChildHandle) bool { return true },
		terminate:        func(restartChildHandle) {},
		resumeShutdowner: shutdowner,
		exit: func() {
			mu.Lock()
			defer mu.Unlock()
			exited = true
		},
	})

	mu.Lock()
	defer mu.Unlock()
	if !exited {
		t.Fatal("daemon must still exit after an incomplete resume cleanup")
	}
	if calls, _ := shutdowner.snapshot(); calls != 1 {
		t.Fatalf("resume drain calls=%d, want 1", calls)
	}
	if !strings.Contains(buf.String(), "resume cleanup incomplete") {
		t.Fatalf("missing timeout warning in logs: %q", buf.String())
	}
}

func TestFailedReplacementDoesNotDrainCurrentResumeProcesses(t *testing.T) {
	cases := []struct {
		name string
		deps func(*recordingResumeShutdowner, func()) daemonRestartDeps
	}{
		{
			name: "replacement not ready",
			deps: func(s *recordingResumeShutdowner, exited func()) daemonRestartDeps {
				return daemonRestartDeps{
					logger:           slog.Default(),
					activeStop:       func() bool { return false },
					resolveExe:       func() (string, error) { return "/pocketctl", nil },
					prepare:          func() error { return nil },
					spawnReplacement: func(string) (restartChildHandle, error) { return restartChildHandle{pid: 9}, nil },
					awaitReady:       func(restartChildHandle) error { return errors.New("not ready") },
					terminate:        func(restartChildHandle) {},
					resumeShutdowner: s,
					exit:             exited,
				}
			},
		},
		{
			name: "spawn failure",
			deps: func(s *recordingResumeShutdowner, exited func()) daemonRestartDeps {
				return daemonRestartDeps{
					logger:           slog.Default(),
					activeStop:       func() bool { return false },
					resolveExe:       func() (string, error) { return "/pocketctl", nil },
					prepare:          func() error { return nil },
					spawnReplacement: func(string) (restartChildHandle, error) { return restartChildHandle{}, errors.New("fork failed") },
					awaitReady:       func(restartChildHandle) error { return nil },
					terminate:        func(restartChildHandle) {},
					resumeShutdowner: s,
					exit:             exited,
				}
			},
		},
		{
			name: "replacement died after readiness",
			deps: func(s *recordingResumeShutdowner, exited func()) daemonRestartDeps {
				return daemonRestartDeps{
					logger:           slog.Default(),
					activeStop:       func() bool { return false },
					resolveExe:       func() (string, error) { return "/pocketctl", nil },
					prepare:          func() error { return nil },
					spawnReplacement: func(string) (restartChildHandle, error) { return restartChildHandle{pid: 9}, nil },
					awaitReady:       func(restartChildHandle) error { return nil },
					alive:            func(restartChildHandle) bool { return false },
					terminate:        func(restartChildHandle) {},
					resumeShutdowner: s,
					exit:             exited,
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			shutdowner := &recordingResumeShutdowner{}
			runDaemonHotRestart(tc.deps(shutdowner, func() { t.Fatal("old daemon must not exit when the replacement failed") }))
			if calls, _ := shutdowner.snapshot(); calls != 0 {
				t.Fatalf("active resumes were canceled: drain calls=%d", calls)
			}
		})
	}
}

func TestDaemonWiresResumeCleanupRecorderToTelemetry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 8))
	rec := wireResumeCleanupTelemetry(sm)
	if rec == nil {
		t.Fatal("resume cleanup recorder was not wired")
	}
	rec("resume_cancelled")
	snapshot, err := agentcontrol.LoadClaudeTelemetry()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ResumeCleanup["resume_cancelled"] != 1 {
		t.Fatalf("resume cleanup counters=%+v", snapshot.ResumeCleanup)
	}
	// Forbidden reasons are rejected by telemetry and must not panic.
	rec("/sessions/secret.jsonl pid=1")
}

// --- M-6: no command interpreter in platform integrations ---

func TestValidateExternalURLRejectsDangerousSchemesAndShapes(t *testing.T) {
	valid := []string{
		"https://www.pocketctl.me/login/cli?code=ABCD-EFGH",
		"https://example.com/path",
		"http://localhost:8080/login/cli?code=ABCD-EFGH",
		"http://127.0.0.1:3000/login",
		"http://[::1]:9000/login/cli",
	}
	for _, raw := range valid {
		if err := ValidateExternalURL(raw); err != nil {
			t.Errorf("ValidateExternalURL(%q) = %v, want nil", raw, err)
		}
	}
	invalid := map[string]string{
		"javascript:alert(1)":                              "scheme",
		"file:///etc/passwd":                               "scheme",
		"ms-settings:windows-defender":                     "scheme",
		"pocketctl://callback":                             "scheme",
		"https://user:pass@example.com/login":              "userinfo",
		"http://192.168.1.10:8080/login":                   "loopback",
		"http://www.example.com/login":                     "loopback",
		"/login/cli?code=ABCD":                             "absolute",
		"login/cli":                                        "absolute",
		"https://example.com/\n/login":                     "control",
		"https://example.com/\x00/login":                   "control",
		"https://example.com/" + strings.Repeat("a", 2100): "length",
		"": "empty",
	}
	for raw, category := range invalid {
		err := ValidateExternalURL(raw)
		if err == nil {
			t.Errorf("ValidateExternalURL(%q) = nil, want error (%s)", raw, category)
		}
	}
}

func TestOpenBrowserRejectsInvalidURLBeforeAnyExec(t *testing.T) {
	err := openBrowser("javascript:alert(document.domain)")
	if err == nil {
		t.Fatal("openBrowser(javascript:...) = nil, want validation error")
	}
	if !strings.Contains(err.Error(), "invalid URL") && !strings.Contains(err.Error(), "URL") {
		t.Fatalf("openBrowser error should mention URL, got: %v", err)
	}
}

func TestWSLOpenArgsNeverUseCmdExeOrShell(t *testing.T) {
	hostile := "https://example.com/login?next=$(rm -rf ~)&x=`id`|whoami<>&^\n"
	for _, opener := range []string{"/usr/bin/wslview", "/mnt/c/Windows/System32/rundll32.exe", "/mnt/c/Windows/explorer.exe"} {
		args := WSLBrowserArgs(opener, hostile)
		if len(args) < 2 {
			t.Fatalf("WSLBrowserArgs(%q) returned %v, want opener + URL argv", opener, args)
		}
		if args[0] != opener {
			t.Fatalf("argv[0] = %q, want opener path", args[0])
		}
		if args[len(args)-1] != hostile {
			t.Fatalf("URL must round-trip as a single argv element, got %q", args[len(args)-1])
		}
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "cmd.exe") {
			t.Fatalf("cmd.exe must never appear in WSL browser args: %q", joined)
		}
		for _, shellFlag := range []string{"/c start", " -c ", "sh ", "/bin/sh"} {
			if strings.Contains(joined, shellFlag) {
				t.Fatalf("shell flag %q leaked into argv: %q", shellFlag, joined)
			}
		}
		if opener == "/mnt/c/Windows/System32/rundll32.exe" && args[1] != "url.dll,FileProtocolHandler" {
			t.Fatalf("rundll32 argv must pass FileProtocolHandler as a direct argument, got %v", args)
		}
	}
}
