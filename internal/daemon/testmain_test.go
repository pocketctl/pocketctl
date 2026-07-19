package daemon

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	runtimeDir, err := os.MkdirTemp("", "pocketctl-daemon-tests-")
	if err != nil {
		panic(err)
	}
	if err := os.Setenv("POCKETCTL_RUNTIME_DIR", runtimeDir); err != nil {
		panic(err)
	}
	code := m.Run()
	_ = os.RemoveAll(runtimeDir)
	os.Exit(code)
}
