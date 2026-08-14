package main

import (
	"context"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
)

func TestDaemonClaudeChannelIPCServesLauncherBootstrap(t *testing.T) {
	home := t.TempDir()
	if runtime.GOOS != "windows" {
		var err error
		home, err = os.MkdirTemp("/tmp", "ccd")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(home) })
	}
	t.Setenv("HOME", home)
	srv, err := startClaudeChannelIPC(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := agentcontrol.NewClaudeLauncher().Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.InstanceID == "" || result.CapabilityToken == "" || result.MCPConfigPath == "" {
		t.Fatalf("incomplete bootstrap result: %+v", result)
	}
}
