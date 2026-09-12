package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

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
