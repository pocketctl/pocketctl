//go:build !windows

package session

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexCoordinatorReplacesIncompatibleHandoffWithoutCodexLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	oldRuntime := exec.Command("sleep", "30")
	oldRuntime.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := oldRuntime.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = syscall.Kill(-oldRuntime.Process.Pid, syscall.SIGKILL)
		_, _ = oldRuntime.Process.Wait()
	}()
	state := &daemon.CodexAppServerState{
		PID: oldRuntime.Process.Pid, OwnerPID: 0,
		Endpoint: "/tmp/old-codex.sock", RemoteURI: "unix:///tmp/old-codex.sock",
		Binary: "/opt/codex", Version: "0.144.1", SchemaHash: "old-schema", Generation: 7,
		Threads: []string{"thr_managed"},
	}
	if err := daemon.WriteCodexAppServerState(state); err != nil {
		t.Fatal(err)
	}

	coord := newCodexCoordinator(nil)
	var startedGeneration uint64
	coord.start = func(_ context.Context, _, _ string, generation uint64) (*codexAppServerRuntime, error) {
		startedGeneration = generation
		return &codexAppServerRuntime{PID: os.Getpid(), Endpoint: "/tmp/new-codex.sock", RemoteURI: "unix:///tmp/new-codex.sock"}, nil
	}
	if _, err := coord.ensureStarted(context.Background(), state.Binary, state.Version, agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "new-schema"}); err != nil {
		t.Fatal(err)
	}
	if startedGeneration != 8 {
		t.Fatalf("generation=%d want 8", startedGeneration)
	}
	if threads := coord.managedThreadSnapshot(); len(threads) != 1 || threads[0] != "thr_managed" {
		t.Fatalf("managed threads=%v want persisted thread after runtime replacement", threads)
	}
}

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
