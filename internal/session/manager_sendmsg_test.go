package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// TestSendMessage_UnknownSessionReturnsError verifies that SendMessage on a
// session that is neither in the in-memory map nor on disk (no JSONL) returns
// an error instead of nil-deref panicking — the original "send message →
// daemon offline" crash. HOME is isolated so tryResumeHistorical can't find a
// real JSONL for the id.
func TestSendMessage_UnknownSessionReturnsError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	err := sm.SendMessage(context.Background(), "00000000-0000-0000-0000-000000000000", "hi")
	if err == nil {
		t.Fatal("expected error for unknown session, got nil")
	}
}

// TestTryResumeHistorical_RegistersFromJSONL verifies a session present on disk
// (JSONL) but not in memory gets registered as terminal/exited with the cwd
// extracted from the JSONL, so SendMessage's --resume path can drive it.
func TestTryResumeHistorical_RegistersFromJSONL(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	sid := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	dir := filepath.Join(tmp, ".claude", "projects", "-Users-foo-bar")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	jsonl := filepath.Join(dir, sid+".jsonl")
	if err := os.WriteFile(jsonl, []byte(`{"type":"summary"}`+"\n"+`{"type":"user","cwd":"/Users/foo/bar"}`+"\n"), 0644); err != nil {
		t.Fatal(err)
	}

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	if !sm.tryResumeHistorical(sid) {
		t.Fatal("expected tryResumeHistorical to find the JSONL and return true")
	}
	sm.mu.RLock()
	ps, ok := sm.sessions[sid]
	sm.mu.RUnlock()
	if !ok {
		t.Fatal("session not registered after tryResumeHistorical")
	}
	if ps.Cwd != "/Users/foo/bar" {
		t.Errorf("cwd = %q, want /Users/foo/bar", ps.Cwd)
	}
	if ps.Source != "terminal" || ps.Status != protocol.StatusExited {
		t.Errorf("source/status = %q/%q, want terminal/exited", ps.Source, ps.Status)
	}
}

// TestTryResumeHistorical_NoJSONLReturnsFalse verifies an unknown session with
// no JSONL on disk returns false (caller surfaces "session not found").
func TestTryResumeHistorical_NoJSONLReturnsFalse(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	if sm.tryResumeHistorical("ffffffff-0000-0000-0000-000000000000") {
		t.Fatal("expected false for session with no JSONL")
	}
}

func TestExtractCwdFromJSONL(t *testing.T) {
	f := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(f, []byte(`{"type":"summary"}`+"\n"+`{"type":"user","cwd":"/work/x"}`+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if got := extractCwdFromJSONL(f); got != "/work/x" {
		t.Errorf("extractCwdFromJSONL = %q, want /work/x", got)
	}
}

func TestCwdFromProjectsDir(t *testing.T) {
	cases := map[string]string{
		filepath.Join("h", ".claude", "projects", "-Users-foo-bar", "x.jsonl"): "/Users/foo/bar",
		filepath.Join("h", ".claude", "projects", "-tmp", "x.jsonl"):            "/tmp",
	}
	for path, want := range cases {
		if got := cwdFromProjectsDir(path); got != want {
			t.Errorf("cwdFromProjectsDir(%q) = %q, want %q", path, got, want)
		}
	}
}
