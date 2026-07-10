package session

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// TestSendMessage_UnknownSessionReturnsError verifies that SendMessage on a
// session that is neither in the in-memory map nor on disk (no JSONL) returns
// an error instead of nil-deref panicking — the original "send message →
// daemon offline" crash. HOME is isolated so tryResumeHistorical can't find a
// real JSONL for the id.
func TestSendMessage_UnknownSessionReturnsError(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", tmp)
	}

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
	t.Setenv("CODEX_HOME", filepath.Join(tmp, ".codex"))
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", tmp)
	}

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
	if ps.Agent != adapter.AgentClaude {
		t.Errorf("agent = %q, want %q", ps.Agent, adapter.AgentClaude)
	}
}

func TestTryResumeHistorical_RegistersCodexRollout(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("CODEX_HOME", filepath.Join(tmp, ".codex"))
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", tmp)
	}

	sid := "11111111-2222-3333-4444-555555555555"
	dir := filepath.Join(tmp, ".codex", "sessions", "2026", "07", "10")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(dir, "rollout-2026-07-10T11-13-28-"+sid+".jsonl")
	line := `{"type":"session_meta","payload":{"id":"` + sid + `","cwd":"/Users/foo/codex-project"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(line), 0644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(rollout, old, old); err != nil {
		t.Fatal(err)
	}

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	if !sm.tryResumeHistorical(sid) {
		t.Fatal("expected Codex rollout to be recovered")
	}
	sm.mu.RLock()
	ps := sm.sessions[sid]
	sm.mu.RUnlock()
	if ps == nil {
		t.Fatal("Codex session not registered")
	}
	if ps.Agent != adapter.AgentCodex {
		t.Errorf("agent = %q, want %q", ps.Agent, adapter.AgentCodex)
	}
	if ps.Cwd != "/Users/foo/codex-project" {
		t.Errorf("cwd = %q, want /Users/foo/codex-project", ps.Cwd)
	}
	if ps.Source != "terminal" || ps.Status != protocol.StatusExited {
		t.Errorf("source/status = %q/%q, want terminal/exited", ps.Source, ps.Status)
	}
}

// TestTryResumeHistorical_NoJSONLReturnsFalse verifies an unknown session with
// no JSONL on disk returns false (caller surfaces "session not found").
func TestTryResumeHistorical_NoJSONLReturnsFalse(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("CODEX_HOME", filepath.Join(tmp, ".codex"))
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", tmp)
	}

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
