package session

import (
	"os"
	"path/filepath"
	"testing"
)

// H-7: remote sessions may only run inside locally configured allowed roots.
// With no roots configured the policy must fail closed, and authorization has
// to happen before any mkdir/worktree/hook/process side effect.

func mustDir(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCwdPolicyFailsClosedWithoutRoots(t *testing.T) {
	policy, err := NewCwdPolicy(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := policy.AuthorizeProposed(mustDir(t, filepath.Join(t.TempDir(), "repo"))); err == nil {
		t.Fatal("policy without roots must reject every cwd")
	} else if !isCwdNotAuthorized(err) {
		t.Fatalf("error must carry cwd_not_authorized, got %v", err)
	}
	if err := policy.Allows("/tmp"); err == nil {
		t.Fatal("Allows must fail closed with no roots")
	}
}

func TestCwdPolicyAuthorizesInsideRootOnly(t *testing.T) {
	base := t.TempDir()
	root := mustDir(t, filepath.Join(base, "allowed", "repo"))
	policy, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := policy.AuthorizeProposed(root); err != nil {
		t.Fatalf("root itself must be allowed: %v", err)
	}
	inside := filepath.Join(root, "sub", "dir") // does not exist yet
	if _, err := policy.AuthorizeProposed(inside); err != nil {
		t.Fatalf("missing path inside root must be authorizable pre-creation: %v", err)
	}
	if err := policy.Allows(mustDir(t, filepath.Join(base, "allowed-evil"))); err == nil {
		t.Fatal("sibling path with a shared prefix must be rejected")
	}
	if _, err := policy.AuthorizeProposed(filepath.Join(root, "..", "escape")); err == nil {
		t.Fatal("relative escape must be rejected")
	}
}

func TestCwdPolicyBlocksSymlinkEscape(t *testing.T) {
	if testing.Short() {
		t.Skip("filesystem symlink fixture")
	}
	base := t.TempDir()
	root := mustDir(t, filepath.Join(base, "allowed"))
	outside := mustDir(t, filepath.Join(base, "outside"))
	policy, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(root, "jump")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	if _, err := policy.AuthorizeProposed(link); err == nil {
		t.Fatal("symlink escaping the root must be rejected")
	}
	// A symlink pointing back INSIDE the root resolves to an allowed path.
	inner := mustDir(t, filepath.Join(root, "inner"))
	innerLink := filepath.Join(root, "inner-link")
	if err := os.Symlink(inner, innerLink); err != nil {
		t.Fatal(err)
	}
	resolved, err := policy.AuthorizeProposed(innerLink)
	if err != nil {
		t.Fatalf("in-root symlink must authorize to its target: %v", err)
	}
	canonicalInner, err := filepath.EvalSymlinks(inner)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != canonicalInner {
		t.Fatalf("proposed authorization must return the canonical path, got %q want %q", resolved, canonicalInner)
	}
}

func TestCwdPolicyMissingPathUnderSymlinkedParent(t *testing.T) {
	base := t.TempDir()
	realRoot := mustDir(t, filepath.Join(base, "real"))
	policy, err := NewCwdPolicy([]string{realRoot})
	if err != nil {
		t.Fatal(err)
	}
	// A parent directory that is itself a symlink to inside the root: the
	// missing tail must still authorize against the resolved ancestor.
	bridge := filepath.Join(base, "bridge")
	if err := os.Symlink(realRoot, bridge); err != nil {
		t.Skip("symlinks unavailable")
	}
	missing := filepath.Join(bridge, "new", "sub")
	if _, err := policy.AuthorizeProposed(missing); err != nil {
		t.Fatalf("missing path under symlinked ancestor inside root must pass: %v", err)
	}
	// Same shape but pointing outside the root must fail.
	outside := mustDir(t, filepath.Join(base, "outside"))
	evilBridge := filepath.Join(base, "evil-bridge")
	if err := os.Symlink(outside, evilBridge); err != nil {
		t.Fatal(err)
	}
	if _, err := policy.AuthorizeProposed(filepath.Join(evilBridge, "new")); err == nil {
		t.Fatal("missing path escaping via symlinked ancestor must be rejected")
	}
}

func TestCwdPolicyCanonicalRecheckAfterCreation(t *testing.T) {
	base := t.TempDir()
	root := mustDir(t, filepath.Join(base, "root"))
	policy, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	created := mustDir(t, filepath.Join(root, "created"))
	if err := policy.Allows(created); err != nil {
		t.Fatalf("created path inside root must pass the canonical recheck: %v", err)
	}
	if err := policy.Allows(mustDir(t, filepath.Join(base, "other"))); err == nil {
		t.Fatal("created path outside any root must fail the canonical recheck")
	}
}

func TestCwdPolicyRootsMustBeAbsoluteExistingDirectories(t *testing.T) {
	if _, err := NewCwdPolicy([]string{"relative/root"}); err == nil {
		t.Fatal("relative root must be rejected at policy construction")
	}
	if _, err := NewCwdPolicy([]string{filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Fatal("missing root must be rejected at policy construction")
	}
	base := t.TempDir()
	plain := filepath.Join(base, "file")
	if err := os.WriteFile(plain, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewCwdPolicy([]string{plain}); err == nil {
		t.Fatal("file root must be rejected at policy construction")
	}
}

func TestCwdPolicyDeduplicatesNestedRoots(t *testing.T) {
	base := t.TempDir()
	outer := mustDir(t, filepath.Join(base, "outer"))
	inner := mustDir(t, filepath.Join(outer, "inner"))
	policy, err := NewCwdPolicy([]string{outer, inner})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(policy.Roots()); got != 1 {
		t.Fatalf("nested roots must collapse to the outer one, got %d", got)
	}
}
