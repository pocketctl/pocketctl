package session

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	testHome, err := os.MkdirTemp("", "pc-session-test-")
	if err != nil {
		panic(err)
	}
	if err := os.Setenv("HOME", testHome); err != nil {
		panic(err)
	}
	if err := os.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", filepath.Join(testHome, "codex")); err != nil {
		panic(err)
	}
	code := m.Run()
	_ = os.RemoveAll(testHome)
	os.Exit(code)
}

// allowCwdForTest installs a permissive cwd policy rooted at the OS temp base
// so legacy CreateSession tests keep working under the H-7 fail-closed gate.
func allowCwdForTest(t *testing.T, sm *SessionManager) {
	t.Helper()
	policy, err := NewCwdPolicy([]string{os.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	sm.SetCwdPolicy(policy)
}
