//go:build !windows

package codexapp

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestInstalledCodexAppServerUnixInitialize(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_SMOKE") != "1" {
		t.Skip("set POCKETCTL_CODEX_SMOKE=1 to test the installed Codex CLI")
	}
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(shortUnixTempDir(t), "a.sock")
	cmd := exec.Command(binary, "app-server", "--listen", "unix://"+socketPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(socketPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("socket was not created: %s", stderr.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := DialUnix(ctx, socketPath)
	if err != nil {
		t.Fatalf("dial: %v; app-server stderr: %s", err, stderr.String())
	}
	defer client.Close()
	params := map[string]any{
		"clientInfo":   map[string]string{"name": "pocketctl-smoke", "title": "Pocketctl Smoke", "version": "0.1"},
		"capabilities": map[string]any{"experimentalApi": true},
	}
	var result map[string]any
	if err := client.Initialize(ctx, params, &result); err != nil {
		t.Fatalf("initialize: %v; app-server stderr: %s", err, stderr.String())
	}
}
