package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPIDUsesConfiguredRuntimeDirectory(t *testing.T) {
	runtimeDir := t.TempDir()
	t.Setenv("POCKETCTL_RUNTIME_DIR", runtimeDir)

	if err := WritePID(12345); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(runtimeDir, "daemon.pid")
	if PIDPath() != want {
		t.Fatalf("PIDPath()=%q want %q", PIDPath(), want)
	}
	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "12345" {
		t.Fatalf("pid=%q want 12345", data)
	}
}
