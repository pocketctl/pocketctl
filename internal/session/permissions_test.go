package session

import (
	"bytes"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestSetPermissionConfigCodexNextTurnAndDefensiveCopy(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 1)
	sm := NewSessionManager(out)
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: "codex", Source: "daemon", Status: protocol.StatusIdle, Permission: &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "never", SandboxMode: "read-only"}}
	cfg := &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "never", SandboxMode: "workspace-write"}
	if err := sm.SetPermissionConfig("s", cfg); err != nil {
		t.Fatal(err)
	}
	cfg.SandboxMode = "danger-full-access"
	evt := <-out
	if evt.Type != "permission_config_changed" || evt.PermissionEffective != "next_turn" || evt.Permission.SandboxMode != "workspace-write" {
		t.Fatalf("event = %+v", evt)
	}
	got, mutable, _, ok := sm.GetPermissionMeta("s")
	if !ok || !mutable || got.SandboxMode != "workspace-write" {
		t.Fatalf("meta = %+v mutable=%v ok=%v", got, mutable, ok)
	}
}

func TestSetPermissionConfigRejectsBusyWithoutMutation(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: "codex", Source: "daemon", Status: protocol.StatusRunning, Permission: &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "never", SandboxMode: "read-only"}}
	err := sm.SetPermissionConfig("s", &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "never", SandboxMode: "workspace-write"})
	if err == nil || err.Error() != "session_busy" {
		t.Fatalf("error = %v", err)
	}
	if sm.sessions["s"].Permission.SandboxMode != "read-only" {
		t.Fatal("busy session permission mutated")
	}
}

type interruptPTY struct {
	bytes.Buffer
}

func (p *interruptPTY) Close() error                    { return nil }
func (p *interruptPTY) SetSize(rows, cols uint16) error { return nil }

func TestInterruptDaemonPTYPublishesIdleStatus(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 1)
	sm := NewSessionManager(outputCh)
	pty := &interruptPTY{}
	sm.sessions["session-1"] = &ProcessState{
		SessionID: "session-1",
		Source:    "daemon",
		Status:    protocol.StatusRunning,
		PTY:       pty,
	}

	if err := sm.InterruptSession("session-1"); err != nil {
		t.Fatalf("InterruptSession() error = %v", err)
	}
	if got := pty.Bytes(); !bytes.Equal(got, []byte{0x03}) {
		t.Fatalf("PTY bytes = %v, want Ctrl+C", got)
	}

	select {
	case event := <-outputCh:
		if event.Type != "session_status" || event.SessionID != "session-1" || event.Status != protocol.StatusIdle {
			t.Fatalf("event = %+v, want idle session_status", event)
		}
		if event.LastActivityAt == "" {
			t.Fatal("idle session_status missing last_activity_at")
		}
	case <-time.After(time.Second):
		t.Fatal("InterruptSession() did not publish idle session_status")
	}

	sm.mu.RLock()
	status := sm.sessions["session-1"].Status
	sm.mu.RUnlock()
	if status != protocol.StatusIdle {
		t.Fatalf("stored status = %q, want %q", status, protocol.StatusIdle)
	}
}
