package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
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
}

func (s promptReceiptSessionStub) SendMessage(context.Context, string, string) error {
	return s.sendErr
}

func (s promptReceiptSessionStub) GetSessionAgent(string) (string, bool) {
	return s.agent, true
}

func (s promptReceiptSessionStub) SessionControlMode(string) string {
	return s.controlMode
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
			wantReason:  rejected.Error(),
		},
		{
			name: "managed OpenCode unchanged",
			session: promptReceiptSessionStub{
				agent: adapter.AgentOpencode, controlMode: protocol.ControlManaged,
			},
		},
		{
			name: "Claude unchanged",
			session: promptReceiptSessionStub{
				agent: adapter.AgentClaude, controlMode: protocol.ControlManaged,
			},
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
	if os.Getenv("POCKETCTL_OPENCODE_SERVE_TEST_HELPER") == "1" {
		select {}
	}
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
	serveProcess := exec.Command(os.Args[0], "-test.run=^TestOpenCodeSessionMetaUsesLoadedAuthoritativeState$")
	serveProcess.Env = append(os.Environ(), "POCKETCTL_OPENCODE_SERVE_TEST_HELPER=1")
	if err := serveProcess.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = serveProcess.Process.Kill()
		_, _ = serveProcess.Process.Wait()
	})
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
	if err := daemon.WriteOpenCodeServeState(&daemon.OpenCodeServeState{
		PID: serveProcess.Process.Pid, BaseURL: serve.URL, Password: "test-secret", Version: "1.2.3",
		OwnerPID: os.Getpid(), UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 8))

	meta := buildSessionMeta(context.Background(), sm, "ses_1", slog.Default())
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
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(base + ".heartbeat"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
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
	event := reconnectDiscoveryEvent(session.SessionInfo{
		SessionID: "session-a",
		Cwd:       "/tmp/project",
		Status:    protocol.StatusCompleted,
		Agent:     "codex",
		Model:     "gpt-5.3-codex",
	})

	if event.Type != "session_discovered" || !event.Resync {
		t.Fatalf("event = %#v, want resync session_discovered", event)
	}
	if event.SessionID != "session-a" || event.Source != "terminal" {
		t.Fatalf("event = %#v, want session identity and source preserved", event)
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
