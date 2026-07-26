package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestClaudeApprovalStateRoundTripAndRedaction(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	now := time.Now().UTC().Truncate(time.Second)
	state := ClaudeApprovalState{
		DaemonID: "daemon-1",
		Requests: []ClaudeApprovalStateItem{{
			SessionID: "session-1", RequestID: "request-1", CreatedAt: now,
		}},
	}
	if err := WriteClaudeApprovalState(state); err != nil {
		t.Fatalf("WriteClaudeApprovalState: %v", err)
	}
	info, err := os.Stat(ClaudeApprovalStatePath())
	if err != nil {
		t.Fatalf("stat state: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state mode=%o want 600", info.Mode().Perm())
	}
	raw, err := os.ReadFile(ClaudeApprovalStatePath())
	if err != nil {
		t.Fatalf("read raw state: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("decode raw state: %v", err)
	}
	for _, forbidden := range []string{"tool", "input", "cwd", "prompt", "approved"} {
		if _, ok := fields[forbidden]; ok {
			t.Fatalf("state contains forbidden top-level field %q", forbidden)
		}
	}
	loaded, err := ReadClaudeApprovalState()
	if err != nil {
		t.Fatalf("ReadClaudeApprovalState: %v", err)
	}
	if loaded.DaemonID != "daemon-1" || len(loaded.Requests) != 1 || loaded.Requests[0].RequestID != "request-1" {
		t.Fatalf("loaded=%#v", loaded)
	}
}

func TestClaudeApprovalStateRejectsLoosePermissionsAndSymlink(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := WriteClaudeApprovalState(ClaudeApprovalState{
		DaemonID: "daemon-1",
		Requests: []ClaudeApprovalStateItem{{
			SessionID: "session-1", RequestID: "request-1", CreatedAt: time.Now(),
		}},
	}); err != nil {
		t.Fatalf("write state: %v", err)
	}
	if err := os.Chmod(ClaudeApprovalStatePath(), 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if _, err := ReadClaudeApprovalState(); err == nil {
		t.Fatal("loose permissions must be rejected")
	}

	if err := os.Remove(ClaudeApprovalStatePath()); err != nil {
		t.Fatalf("remove: %v", err)
	}
	target := filepath.Join(home, "target")
	if err := os.WriteFile(target, []byte(`{"version":1,"requests":[]}`), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(target, ClaudeApprovalStatePath()); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := ReadClaudeApprovalState(); err == nil {
		t.Fatal("symlink state must be rejected")
	}
}

func TestClaudeApprovalStateEmptyClearsFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := WriteClaudeApprovalState(ClaudeApprovalState{
		Requests: []ClaudeApprovalStateItem{{
			SessionID: "session-1", RequestID: "request-1", CreatedAt: time.Now(),
		}},
	}); err != nil {
		t.Fatalf("write state: %v", err)
	}
	if err := WriteClaudeApprovalState(ClaudeApprovalState{}); err != nil {
		t.Fatalf("clear state: %v", err)
	}
	if _, err := os.Stat(ClaudeApprovalStatePath()); !os.IsNotExist(err) {
		t.Fatalf("state still exists: %v", err)
	}
}
