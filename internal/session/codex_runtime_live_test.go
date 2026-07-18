//go:build !windows

package session

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestInstalledCodexRuntimeAcquireAndSecondClient(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_SMOKE") != "1" {
		t.Skip("set POCKETCTL_CODEX_SMOKE=1 to test the installed Codex CLI")
	}
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	originalHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", originalHome+"/.codex")
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	cfg.Codex.RealBinary = binary
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	provider := sm.CodexRuntimeProvider()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, err := provider.Acquire(ctx, agentcontrol.AcquireRequest{
		Agent: agentcontrol.AgentCodex, ClientPID: os.Getpid(),
		Payload: agentcontrol.AcquirePayload{CWD: t.TempDir(), Intent: agentcontrol.IntentNew, OperationID: "live-smoke"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = provider.Release(context.Background(), agentcontrol.ReleaseRequest{Agent: agentcontrol.AgentCodex, Payload: agentcontrol.ReleasePayload{LeaseID: result.LeaseID}})
		_ = sm.ShutdownCodex()
	}()
	if result.Mode != string(agentcontrol.LaunchManaged) || !strings.HasPrefix(result.RemoteURI, "unix://") {
		t.Fatalf("result=%+v", result)
	}
	second, err := codexapp.DialUnix(ctx, strings.TrimPrefix(result.RemoteURI, "unix://"))
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	var initialized map[string]any
	if err := second.Initialize(ctx, map[string]any{
		"clientInfo":   map[string]string{"name": "pocketctl-second", "title": "Pocketctl Second", "version": "0.1"},
		"capabilities": map[string]any{"experimentalApi": true},
	}, &initialized); err != nil {
		t.Fatal(err)
	}
	client, generation, ok := provider.coordinator.backendClient()
	if !ok {
		t.Fatal("daemon app-server client unavailable")
	}
	backend := newCodexAppServerBackend(sm, provider.coordinator, client, generation)
	threadID, err := backend.Start(ctx, protocol.SessionConfig{
		Agent: "codex", Cwd: t.TempDir(),
		Permission: &protocol.PermissionConfig{Agent: "codex", ApprovalPolicy: "never", SandboxMode: "workspace-write"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if threadID == "" {
		t.Fatal("thread/start returned an empty id")
	}
}
