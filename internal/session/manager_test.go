package session

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestSetSessionExited(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	// Register a terminal session
	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning)

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

			sm.RegisterTerminalSession(sid, "/tmp", 12345, "/dev/ttys001", protocol.StatusIdle)
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

	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning)
	sm.SetSessionStatus("test-sid", protocol.StatusIdle)

	select {
	case evt := <-outputCh:
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

	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning)

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

	sm.RegisterTerminalSession("session-a", "/tmp", 100, "/dev/ttys001", protocol.StatusRunning)
	sm.RegisterTerminalSession("session-b", "/tmp", 200, "/dev/ttys002", protocol.StatusRunning)

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
	sm.RegisterTerminalSession("exited-sid", "/tmp", 9999999, "", protocol.StatusExited)

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
	sm.RegisterTerminalSession("dead-sid", os.TempDir(), 9999999, "", protocol.StatusIdle)

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
