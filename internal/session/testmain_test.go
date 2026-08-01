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
