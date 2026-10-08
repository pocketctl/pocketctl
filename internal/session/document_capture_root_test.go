package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestRequestedDocumentRootLoadsHistoricalCodexAfterRestart(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("POCKETCTL_CODEX_HOMES", "")
	dir := filepath.Join(home, ".codex", "sessions", "2026", "10", "08")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	sid := "01a11936-09a8-77f3-84f3-e1bea892b704"
	data, err := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]any{"id": sid, "cwd": root, "originator": "codex_cli_rs"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rollout-2026-10-08T09-52-14-"+sid+".jsonl"), append(data, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	for _, allowed := range []bool{true, false} {
		sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
		allowedRoot := root
		if !allowed {
			allowedRoot = t.TempDir()
		}
		policy, err := NewCwdPolicy([]string{allowedRoot})
		if err != nil {
			t.Fatal(err)
		}
		sm.SetCwdPolicy(policy)
		got, ok := sm.GetRequestedDocumentCaptureRoot(sid)
		canonical, _ := filepath.EvalSymlinks(root)
		if ok != allowed || (ok && got != canonical) {
			t.Fatalf("allowed=%v root=%q ok=%v", allowed, got, ok)
		}
		if sm.sessions[sid] == nil || sm.sessions[sid].Status != protocol.StatusExited || sm.sessions[sid].PTY != nil {
			t.Fatal("metadata read must not start an agent")
		}
	}
}

func TestDocumentCaptureRootPrefersAuthorizedWorktreeThenCanonicalCwd(t *testing.T) {
	allowed := t.TempDir()
	cwd := filepath.Join(allowed, "repo")
	worktree := filepath.Join(allowed, "worktree")
	for _, directory := range []string{cwd, worktree} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	policy, err := NewCwdPolicy([]string{allowed})
	if err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.SetCwdPolicy(policy)
	sm.sessions["session-1"] = &ProcessState{SessionID: "session-1", Cwd: cwd, WorktreePath: worktree}

	canonicalWorktree, err := filepath.EvalSymlinks(worktree)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := sm.GetDocumentCaptureRoot("session-1"); !ok || got != canonicalWorktree {
		t.Fatalf("worktree root = %q, %v; want %q", got, ok, canonicalWorktree)
	}
	sm.sessions["session-1"].WorktreePath = ""
	canonical, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := sm.GetDocumentCaptureRoot("session-1"); !ok || got != canonical {
		t.Fatalf("cwd root = %q, %v; want %q", got, ok, canonical)
	}
}

func TestDocumentCaptureRootFailsClosedForUnknownMissingOrUnauthorizedState(t *testing.T) {
	allowed := t.TempDir()
	outside := t.TempDir()
	policy, err := NewCwdPolicy([]string{allowed})
	if err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.SetCwdPolicy(policy)
	sm.sessions["outside"] = &ProcessState{SessionID: "outside", Cwd: outside}
	sm.sessions["missing"] = &ProcessState{SessionID: "missing"}

	for _, sessionID := range []string{"unknown", "outside", "missing"} {
		if root, ok := sm.GetDocumentCaptureRoot(sessionID); ok || root != "" {
			t.Fatalf("%s unexpectedly resolved %q", sessionID, root)
		}
	}
	sm.cwdPolicy = nil
	sm.sessions["allowed"] = &ProcessState{SessionID: "allowed", Cwd: allowed}
	if _, ok := sm.GetDocumentCaptureRoot("allowed"); ok {
		t.Fatal("missing cwd policy did not fail closed")
	}
}
