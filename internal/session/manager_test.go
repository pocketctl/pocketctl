package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type fixedProcessController struct {
	alive map[int]bool
}

func (f fixedProcessController) IsAlive(pid int) bool { return f.alive[pid] }
func (fixedProcessController) Terminate(int) error    { return nil }
func (fixedProcessController) Kill(int) error         { return nil }

// drainDiscovered consumes a session_discovered event if one is pending.
// RegisterTerminalSession no longer emits session_discovered itself — it's
// emitted later by handleWatcherEvents (cmd/pocketctl/main.go) once the JSONL
// tailer confirms the file exists, and by the opencode discovery loop. So this
// is a tolerant, non-blocking drain (nothing to consume in these unit tests).
func drainDiscovered(t *testing.T, ch <-chan protocol.DaemonEvent) {
	t.Helper()
	select {
	case evt := <-ch:
		if evt.Type != "session_discovered" {
			t.Errorf("expected session_discovered, got %q", evt.Type)
		}
	default:
		// no pending event — expected
	}
}

func TestSetSessionExited(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	// Register a terminal session
	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	// Set exited
	sm.SetSessionExited("test-sid", protocol.ExitReasonNormalExit)

	// Verify status is exited
	sm.mu.RLock()
	ps, ok := sm.sessions["test-sid"]
	sm.mu.RUnlock()
	if !ok {
		t.Fatal("session not found")
	}
	if ps.Status != protocol.StatusExited {
		t.Errorf("expected status %q, got %q", protocol.StatusExited, ps.Status)
	}
	if ps.ExitReason != protocol.ExitReasonNormalExit {
		t.Errorf("expected exit_reason %q, got %q", protocol.ExitReasonNormalExit, ps.ExitReason)
	}

	// Verify event was emitted
	select {
	case evt := <-outputCh:
		if evt.Type != "session_status" {
			t.Errorf("expected event type session_status, got %q", evt.Type)
		}
		if evt.Status != protocol.StatusExited {
			t.Errorf("expected event status %q, got %q", protocol.StatusExited, evt.Status)
		}
		if evt.ExitReason != protocol.ExitReasonNormalExit {
			t.Errorf("expected exit_reason %q, got %q", protocol.ExitReasonNormalExit, evt.ExitReason)
		}
		if evt.LastActivityAt == "" {
			t.Error("expected last_activity_at to be set")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for session_status event")
	}
}

func TestSetSessionExitedWithDifferentReasons(t *testing.T) {
	tests := []struct {
		name       string
		exitReason string
	}{
		{"user_interrupt", protocol.ExitReasonUserInterrupt},
		{"normal_exit", protocol.ExitReasonNormalExit},
		{"process_crash", protocol.ExitReasonProcessCrash},
		{"signal_kill", protocol.ExitReasonSignalKill},
		{"unknown", protocol.ExitReasonUnknown},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			outputCh := make(chan protocol.DaemonEvent, 16)
			sm := NewSessionManager(outputCh)
			sid := "test-" + tt.name

			sm.RegisterTerminalSession(sid, "/tmp", 12345, "/dev/ttys001", protocol.StatusIdle, "")
			sm.SetSessionExited(sid, tt.exitReason)

			sm.mu.RLock()
			ps := sm.sessions[sid]
			sm.mu.RUnlock()

			if ps.ExitReason != tt.exitReason {
				t.Errorf("expected exit_reason %q, got %q", tt.exitReason, ps.ExitReason)
			}
		})
	}
}

func TestSetSessionExitedNonexistent(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	// Should not panic on nonexistent session
	sm.SetSessionExited("nonexistent-sid", protocol.ExitReasonUnknown)

	// Should not emit event
	select {
	case evt := <-outputCh:
		t.Errorf("unexpected event: %+v", evt)
	default:
		// Expected: no event
	}
}

func TestSetSessionStatusIncludesLastActivityAt(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)
	sm.SetSessionStatus("test-sid", protocol.StatusIdle)

	select {
	case evt := <-outputCh:
		if evt.Type != "session_status" {
			t.Errorf("expected session_status, got %q", evt.Type)
		}
		if evt.LastActivityAt == "" {
			t.Error("expected last_activity_at to be set in session_status event")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for session_status event")
	}
}

func TestSetSessionExited_StatusTransition(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	// Transition: running → exited
	sm.SetSessionExited("test-sid", protocol.ExitReasonNormalExit)

	sm.mu.RLock()
	ps := sm.sessions["test-sid"]
	sm.mu.RUnlock()

	if ps.Status != protocol.StatusExited {
		t.Errorf("expected status %q, got %q — should NOT be 'idle'", protocol.StatusExited, ps.Status)
	}
	if ps.ExitReason != protocol.ExitReasonNormalExit {
		t.Errorf("expected exit_reason %q, got %q", protocol.ExitReasonNormalExit, ps.ExitReason)
	}

	// Drain the event
	select {
	case evt := <-outputCh:
		if _, err := time.Parse(time.RFC3339, evt.LastActivityAt); err != nil {
			t.Errorf("last_activity_at is not valid ISO 8601: %q", evt.LastActivityAt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestSetSessionExited_DoesNotAffectOtherSessions(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("session-a", "/tmp", 100, "/dev/ttys001", protocol.StatusRunning, "")
	sm.RegisterTerminalSession("session-b", "/tmp", 200, "/dev/ttys002", protocol.StatusRunning, "")

	// Only exit session-a
	sm.SetSessionExited("session-a", protocol.ExitReasonUnknown)

	sm.mu.RLock()
	psA := sm.sessions["session-a"]
	psB := sm.sessions["session-b"]
	sm.mu.RUnlock()

	if psA.Status != protocol.StatusExited {
		t.Errorf("session-a: expected exited, got %q", psA.Status)
	}
	if psB.Status != protocol.StatusRunning {
		t.Errorf("session-b: expected running (unchanged), got %q", psB.Status)
	}
}

func TestSendMessage_ExitedSession_Allowed(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(outputCh)

	// Use a PID that is definitely dead (9999999 does not exist)
	sm.RegisterTerminalSession("exited-sid", "/tmp", 9999999, "", protocol.StatusExited, "")

	// SendMessage should NOT return "session not found"
	err := sm.SendMessage(context.Background(), "exited-sid", "hello")
	// It may fail if claude CLI is not available or session data is missing,
	// but it should NOT return "session not found" or "session busy in terminal"
	if err != nil && err.Error() == "session not found: exited-sid" {
		t.Error("SendMessage should not return 'session not found' for exited session")
	}
	if err != nil && err.Error() == "session busy in terminal" {
		t.Error("SendMessage should not return 'session busy in terminal' for exited session")
	}
}

func TestSendMessage_ExitedSession_InvalidPID(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(outputCh)

	// PID 0 — special case, isProcessAlive(0) returns true on some systems
	// Use a definitely-dead PID
	sm.RegisterTerminalSession("dead-sid", os.TempDir(), 9999999, "", protocol.StatusIdle, "")

	// SendMessage should attempt resume (process is dead)
	err := sm.SendMessage(context.Background(), "dead-sid", "test resume")
	if err != nil {
		// Acceptable errors: CLI not found, etc.
		t.Logf("SendMessage returned error (expected for missing CLI): %v", err)
	}
	// The key assertion: it should NOT be "session busy in terminal"
	if err != nil && err.Error() == "session busy in terminal" {
		t.Error("should not return 'session busy' for dead PID")
	}
}

func TestResolveCwd(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("cannot get home dir: %v", err)
	}

	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"empty string", "", home},
		{"tilde", "~", home},
		{"tilde-relative", "~/projects", filepath.Join(home, "projects")},
		{"absolute path", "/opt/workspace", "/opt/workspace"},
		{"another absolute", "/tmp", "/tmp"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := resolveCwd(tt.input)
			if result != tt.expected {
				t.Errorf("resolveCwd(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestValidateCwd(t *testing.T) {
	// Create a temp directory for testing
	tmpDir := t.TempDir()

	// Valid directory should pass
	if err := validateCwd(tmpDir); err != nil {
		t.Errorf("validateCwd(%q) should pass, got: %v", tmpDir, err)
	}

	// Non-existent path should fail
	if err := validateCwd("/nonexistent/path/xyz"); err == nil {
		t.Error("validateCwd for non-existent path should return error")
	}

	// Create a temp file (not a directory)
	tmpFile, err := os.CreateTemp("", "test-validate-cwd")
	if err != nil {
		t.Fatalf("cannot create temp file: %v", err)
	}
	tmpFile.Close()
	defer os.Remove(tmpFile.Name())

	if err := validateCwd(tmpFile.Name()); err == nil {
		t.Error("validateCwd for file should return error")
	}
}

func TestKillSession_SetsKilledStatus(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(outputCh)

	// Create a daemon session
	ctx := context.Background()
	sid, err := sm.CreateSession(ctx, protocol.SessionConfig{
		Agent:          "claude-code",
		Cwd:            os.TempDir(),
		Prompt:         "echo hello",
		PermissionMode: "acceptEdits",
	})
	if err != nil {
		t.Skipf("cannot create session (claude CLI may not be available): %v", err)
	}

	// Kill it
	if err := sm.KillSession(sid); err != nil {
		t.Fatalf("KillSession failed: %v", err)
	}

	sm.mu.RLock()
	ps := sm.sessions[sid]
	sm.mu.RUnlock()

	if ps.Status != protocol.StatusKilled {
		t.Errorf("expected status killed, got %q", ps.Status)
	}
}

func TestUpdateLastActivity(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	sm.mu.RLock()
	before := sm.sessions["test-sid"].LastActivityAt
	sm.mu.RUnlock()

	time.Sleep(10 * time.Millisecond)

	sm.UpdateLastActivity("test-sid")

	sm.mu.RLock()
	after := sm.sessions["test-sid"].LastActivityAt
	sm.mu.RUnlock()

	if !after.After(before) {
		t.Errorf("expected LastActivityAt to be updated (before=%v after=%v)", before, after)
	}
}

func TestUpdateLastActivity_NonexistentSession(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	// should not panic
	sm.UpdateLastActivity("nonexistent")
}

func TestRemapSessionIDUpdatesSessionMapAndCwdRegistry(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	cwd := t.TempDir()

	sm.mu.Lock()
	sm.sessions["old-id"] = &ProcessState{
		SessionID: "old-id",
		Cwd:       cwd,
		Agent:     adapter.AgentCodex,
	}
	sm.mu.Unlock()
	sm.registerCwd("old-id", cwd)

	gotCwd, gotAgent, changed := sm.remapSessionID("old-id", "new-id")
	if !changed {
		t.Fatal("expected session id to change")
	}
	if gotCwd != cwd || gotAgent != adapter.AgentCodex {
		t.Fatalf("metadata = (%q, %q), want (%q, %q)", gotCwd, gotAgent, cwd, adapter.AgentCodex)
	}

	sm.mu.RLock()
	_, oldExists := sm.sessions["old-id"]
	ps, newExists := sm.sessions["new-id"]
	registry := sm.cwdSessions[normalizeCwd(cwd)]
	_, oldRegistered := registry["old-id"]
	_, newRegistered := registry["new-id"]
	sm.mu.RUnlock()

	if oldExists || !newExists {
		t.Fatalf("session map migration failed: old=%v new=%v", oldExists, newExists)
	}
	if ps.SessionID != "new-id" {
		t.Fatalf("process state session id = %q, want new-id", ps.SessionID)
	}
	if oldRegistered || !newRegistered {
		t.Fatalf("cwd registry migration failed: old=%v new=%v", oldRegistered, newRegistered)
	}
}

func TestRegisterTerminalSessionCodexWatcherDoesNotTakeOverDaemonSessionWithoutPID(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	sm.proc = fixedProcessController{alive: map[int]bool{4321: true}}
	sm.mu.Lock()
	sm.sessions["codex-session"] = &ProcessState{
		SessionID: "codex-session",
		Cwd:       "/tmp/project",
		Agent:     adapter.AgentCodex,
		Source:    "daemon",
		Status:    protocol.StatusRunning,
		Pid:       4321,
	}
	sm.childPids[4321] = true
	sm.mu.Unlock()

	startTailer := sm.RegisterTerminalSession(
		"codex-session",
		"/tmp/project",
		0, // Codex rollout discovery has no process id.
		"",
		protocol.StatusRunning,
		adapter.AgentCodex,
	)

	if startTailer {
		t.Fatal("codex watcher must not start a second tailer for a daemon-created session")
	}
	sm.mu.RLock()
	ps := sm.sessions["codex-session"]
	sm.mu.RUnlock()
	if ps.Source != "daemon" {
		t.Fatalf("session source = %q, want daemon", ps.Source)
	}
	if ps.Pid != 4321 {
		t.Fatalf("session pid = %d, want original daemon child pid 4321", ps.Pid)
	}
}

func TestRegisterTerminalSessionCodexWatcherTakesOverExitedDaemonSessionWithoutPID(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	sm.proc = fixedProcessController{alive: map[int]bool{4321: false}}
	sm.mu.Lock()
	sm.sessions["codex-session"] = &ProcessState{
		SessionID: "codex-session",
		Cwd:       "/tmp/project",
		Agent:     adapter.AgentCodex,
		Source:    "daemon",
		Status:    protocol.StatusCompleted,
		Pid:       4321,
	}
	sm.childPids[4321] = true
	sm.mu.Unlock()

	startTailer := sm.RegisterTerminalSession(
		"codex-session",
		"/tmp/project",
		0,
		"",
		protocol.StatusRunning,
		adapter.AgentCodex,
	)

	if !startTailer {
		t.Fatal("external Codex resume must start a JSONL tailer after daemon session exits")
	}
	sm.mu.RLock()
	ps := sm.sessions["codex-session"]
	sm.mu.RUnlock()
	if ps.Source != "terminal" {
		t.Fatalf("session source = %q, want terminal", ps.Source)
	}
	if ps.Pid != 0 {
		t.Fatalf("session pid = %d, want watcher pid 0", ps.Pid)
	}
}

func TestListSessions_SortedByLastActivity(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("old-sid", "/tmp", 100, "", protocol.StatusIdle, "")
	drainDiscovered(t, outputCh)
	time.Sleep(10 * time.Millisecond)
	sm.RegisterTerminalSession("new-sid", "/tmp", 101, "", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	// new-sid should have more recent LastActivityAt
	sessions := sm.ListSessions()
	if len(sessions) < 2 {
		t.Fatalf("expected at least 2 sessions, got %d", len(sessions))
	}
	// Active sessions sorted by last activity (most recent first)
	if sessions[0].SessionID != "new-sid" {
		t.Errorf("expected new-sid first, got %s", sessions[0].SessionID)
	}
	if sessions[1].SessionID != "old-sid" {
		t.Errorf("expected old-sid second, got %s", sessions[1].SessionID)
	}
}

func TestResyncSessionsMarksDiscoveryEvents(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	sm.mu.Lock()
	sm.sessions["session-a"] = &ProcessState{
		SessionID: "session-a",
		Cwd:       "/tmp/project",
		Agent:     adapter.AgentCodex,
		Source:    "daemon",
		Status:    protocol.StatusCompleted,
	}
	sm.mu.Unlock()

	sm.ResyncSessions()
	evt := <-outputCh
	if evt.Type != "session_discovered" || !evt.Resync {
		t.Fatalf("event = %#v, want resync session_discovered", evt)
	}
}

func TestTerminalProbeResponsesForCodexStartupQueries(t *testing.T) {
	chunk := []byte("\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c")
	got := terminalProbeResponses(chunk)
	want := [][]byte{
		[]byte("\x1b[1;1R"),
		[]byte("\x1b[?1;2c"),
		[]byte("\x1b[?0u"),
		[]byte("\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
		[]byte("\x1b]11;rgb:0000/0000/0000\x1b\\"),
	}
	if len(got) != len(want) {
		t.Fatalf("responses = %d, want %d: %q", len(got), len(want), got)
	}
	for i := range want {
		if string(got[i]) != string(want[i]) {
			t.Fatalf("response[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}
