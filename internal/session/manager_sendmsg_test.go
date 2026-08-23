package session

import (
	"context"
	"fmt"
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

func TestSendMessageCodexResumePreservesPlanRevisionAcrossProcesses(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	if runtime.GOOS == "windows" {
		t.Skip("fake Codex shell fixture is Unix-only")
	}

	installFakeCodexResumeCLI(t, home, 0)

	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sessionID := "11111111-aaaa-bbbb-cccc-222222222222"
	sm.sessions[sessionID] = &ProcessState{
		SessionID: sessionID,
		Agent:     adapter.AgentCodex,
		Source:    "daemon",
		Status:    protocol.StatusCompleted,
		Cwd:       home,
	}

	if err := sm.SendMessage(context.Background(), sessionID, "first"); err != nil {
		t.Fatal(err)
	}
	first := waitForCodexPlanAndCompletion(t, output)
	if first.Revision != 1 || first.PreviousEventID != "" {
		t.Fatalf("first plan identity = revision %d previous %q", first.Revision, first.PreviousEventID)
	}

	if err := sm.SendMessage(context.Background(), sessionID, "second"); err != nil {
		t.Fatal(err)
	}
	second := waitForCodexPlanAndCompletion(t, output)
	if second.Revision != 2 || second.PreviousEventID != "codex:plan:call-1" {
		t.Fatalf("resumed plan identity = revision %d previous %q, want 2/codex:plan:call-1", second.Revision, second.PreviousEventID)
	}
}

func TestTryResumeHistoricalHydratesCodexPlanRevision(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Codex shell fixture is Unix-only")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	installFakeCodexResumeCLI(t, home, 2)

	sessionID := "33333333-aaaa-bbbb-cccc-444444444444"
	dir := filepath.Join(home, ".codex", "sessions", "2026", "08", "01")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(dir, "rollout-2026-08-01T10-00-00-"+sessionID+".jsonl")
	lines := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"` + home + `"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":"tools.update_plan({plan:[{step:\"Turn 1\",status:\"completed\"}]})"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-2","name":"exec","input":"tools.update_plan({plan:[{step:\"Turn 2\",status:\"in_progress\"}]})"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	if !sm.tryResumeHistorical(sessionID) {
		t.Fatal("expected historical Codex session to load")
	}
	if err := sm.SendMessage(context.Background(), sessionID, "third"); err != nil {
		t.Fatal(err)
	}
	plan := waitForCodexPlanAndCompletion(t, output)
	if plan.Revision != 3 || plan.PreviousEventID != "codex:plan:call-2" {
		t.Fatalf("historical resume identity = revision %d previous %q, want 3/codex:plan:call-2", plan.Revision, plan.PreviousEventID)
	}
}

func installFakeCodexResumeCLI(t *testing.T, home string, initialCount int) {
	t.Helper()
	counterPath := filepath.Join(home, "codex-resume-count")
	if initialCount > 0 {
		if err := os.WriteFile(counterPath, []byte(fmt.Sprintf("%d\n", initialCount)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("FAKE_CODEX_COUNTER", counterPath)
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeCodex := filepath.Join(binDir, "codex")
	script := `#!/bin/sh
count=0
if [ -f "$FAKE_CODEX_COUNTER" ]; then IFS= read -r count < "$FAKE_CODEX_COUNTER"; fi
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_CODEX_COUNTER"
printf '{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-%s","name":"exec","input":"tools.update_plan({plan:[{step:\\"Turn %s\\",status:\\"in_progress\\"}]})"}}\n' "$count" "$count"
`
	if err := os.WriteFile(fakeCodex, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func waitForCodexPlanAndCompletion(t *testing.T, output <-chan protocol.DaemonEvent) protocol.DaemonEvent {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var plan protocol.DaemonEvent
	for {
		select {
		case event := <-output:
			if event.Type == "agent_plan" {
				plan = event
			}
			if event.Type == "session_status" && event.Status == protocol.StatusCompleted {
				if plan.Type == "" {
					t.Fatal("Codex process completed without an agent_plan event")
				}
				return plan
			}
		case <-timer.C:
			t.Fatal("timed out waiting for Codex plan and completion")
		}
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
		filepath.Join("h", ".claude", "projects", "-tmp", "x.jsonl"):           "/tmp",
	}
	for path, want := range cases {
		if got := cwdFromProjectsDir(path); got != want {
			t.Errorf("cwdFromProjectsDir(%q) = %q, want %q", path, got, want)
		}
	}
}
