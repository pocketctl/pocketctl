package main

import (
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
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func TestOpenCodeSessionMetaUsesLoadedAuthoritativeState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(binDir, "opencode")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\necho 1.2.3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	serveProcess := exec.Command("sleep", "30")
	if err := serveProcess.Start(); err != nil {
		t.Fatal(err)
	}
	defer serveProcess.Process.Kill()
	serve := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/global/health":
			_, _ = w.Write([]byte(`{"healthy":true,"version":"1.2.3"}`))
		case "/api/session/ses_1":
			_, _ = w.Write([]byte(`{"data":{"id":"ses_1","directory":"/repo","agent":"build","model":{"providerID":"opencode","id":"deepseek-v4-flash-free"}}}`))
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
	if meta.Model != "opencode/deepseek-v4-flash-free" || meta.Cwd != "/repo" || meta.CurrentAgent != "build" {
		t.Fatalf("meta=%+v", meta)
	}
	wantCapabilities := []string{"dynamic_commands", "agent_switch", "permission_actions", "questions"}
	if strings.Join(meta.Capabilities, ",") != strings.Join(wantCapabilities, ",") {
		t.Fatalf("capabilities=%v", meta.Capabilities)
	}
	if err := sm.PrepareDaemonRestart(); err != nil {
		t.Fatal(err)
	}
	sm.ShutdownOpencode()
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
	base := filepath.Join(t.TempDir(), "ready")
	cmd := exec.Command("sh", "-c", "while :; do echo $$ > \"$1.heartbeat\"; done", "sh", base)
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
