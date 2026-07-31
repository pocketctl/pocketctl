package session

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
)

func TestResolveOpenCodeCLIUsesConfiguredRealBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only; Windows resolver behavior is unit tested with an injected runner")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(home, "real-opencode")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf 'opencode 1.17.11\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := agentcontrol.DefaultConfig()
	cfg.OpenCode.RealBinary = bin
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	got, version, err := resolveOpenCodeCLI()
	if err != nil {
		t.Fatal(err)
	}
	gotInfo, err := os.Stat(got)
	if err != nil {
		t.Fatal(err)
	}
	wantInfo, err := os.Stat(bin)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(gotInfo, wantInfo) || version != "1.17.11" {
		t.Fatalf("got path=%q version=%q", got, version)
	}
}
