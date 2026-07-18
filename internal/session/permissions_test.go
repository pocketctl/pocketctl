package session

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestHistoricalClaudePermissionIsRecoveredAndMutableForNextTurn(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", tmp)
	}
	sid := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	dir := filepath.Join(tmp, ".claude", "projects", "-Users-foo-project")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	jsonl := []byte(`{"type":"user","cwd":"/Users/foo/project"}` + "\n" + `{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"` + sid + `"}` + "\n")
	if err := os.WriteFile(filepath.Join(dir, sid+".jsonl"), jsonl, 0644); err != nil {
		t.Fatal(err)
	}

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	if !sm.tryResumeHistorical(sid) {
		t.Fatal("historical session was not recovered")
	}
	permission, mutable, modes, ok := sm.GetPermissionMeta(sid)
	if !ok || permission == nil || permission.Mode != "bypassPermissions" {
		t.Fatalf("permission = %+v, ok=%v", permission, ok)
	}
	if !mutable || len(modes) != 6 {
		t.Fatalf("mutable=%v modes=%v, want all Claude next-turn modes", mutable, modes)
	}
}

func TestDaemonClaudePermissionMetaAdvertisesConfirmedRuntimeModes(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: "claude-code", Source: "daemon", Status: protocol.StatusIdle, PTY: &interruptPTY{}, Permission: &protocol.PermissionConfig{Agent: "claude-code", Mode: "acceptEdits"}}
	_, mutable, modes, ok := sm.GetPermissionMeta("s")
	if !ok || !mutable {
		t.Fatalf("ok=%v mutable=%v", ok, mutable)
	}
	want := []string{"manual", "acceptEdits", "plan"}
	if len(modes) != len(want) {
		t.Fatalf("modes=%v, want %v", modes, want)
	}
	for i := range want {
		if modes[i] != want[i] {
			t.Fatalf("modes=%v, want %v", modes, want)
		}
	}
}

func TestDaemonClaudePermissionChangesOnlyAfterObservedConfirmation(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 1)
	pty := &interruptPTY{}
	sm := NewSessionManager(out)
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: "claude-code", Source: "daemon", Status: protocol.StatusIdle, PTY: pty, Permission: &protocol.PermissionConfig{Agent: "claude-code", Mode: "acceptEdits"}}
	if err := sm.SetPermissionConfig("s", &protocol.PermissionConfig{Agent: "claude-code", Mode: "plan"}); err != nil {
		t.Fatal(err)
	}
	if got := pty.String(); got != "\x1b[Z" {
		t.Fatalf("PTY bytes = %q", got)
	}
	if sm.sessions["s"].Permission.Mode != "acceptEdits" {
		t.Fatal("permission changed before Claude confirmation")
	}
	sm.ObservePermissionEvent(protocol.DaemonEvent{Type: "permission_config_changed", SessionID: "s", Permission: &protocol.PermissionConfig{Agent: "claude-code", Mode: "plan"}})
	if sm.sessions["s"].Permission.Mode != "plan" {
		t.Fatal("confirmed permission was not cached")
	}
}

func TestSetPermissionConfigCodexNextTurnAndDefensiveCopy(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 1)
	sm := NewSessionManager(out)
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: "codex", Source: "daemon", Status: protocol.StatusIdle, ControlMode: protocol.ControlManaged, Permission: &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "never", SandboxMode: "read-only"}}
	cfg := &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "on-request", SandboxMode: "workspace-write"}
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

func TestSetPermissionConfigRejectsCodexRemoteApprovalWithoutManagedBackend(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: "codex", Source: "daemon", Status: protocol.StatusIdle, Permission: &protocol.PermissionConfig{Agent: "codex", ApprovalPolicy: "never", SandboxMode: "read-only"}}
	err := sm.SetPermissionConfig("s", &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "on-request", SandboxMode: "workspace-write"})
	if err == nil || !strings.Contains(err.Error(), "managed app-server") {
		t.Fatalf("error=%v", err)
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
