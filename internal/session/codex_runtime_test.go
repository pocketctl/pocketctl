package session

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexRuntimeAcquireReturnsManagedRemoteAndLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	cfg.Codex.RealBinary = "/opt/codex"
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	provider := newCodexRuntimeProvider(sm)
	provider.resolve = func() (string, string, error) { return "/opt/codex", "0.144.1", nil }
	provider.probe = func(context.Context, string, string) (agentcontrol.CodexCapabilities, error) {
		return agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "abc"}, nil
	}
	provider.coordinator.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		return &codexAppServerRuntime{PID: 123, Endpoint: "/tmp/codex.sock", RemoteURI: "unix:///tmp/codex.sock"}, nil
	}
	result, err := provider.Acquire(context.Background(), agentcontrol.AcquireRequest{
		Agent: agentcontrol.AgentCodex, ClientPID: os.Getpid(),
		Payload: agentcontrol.AcquirePayload{CWD: "/repo", Intent: agentcontrol.IntentNew, OperationID: "op-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Mode != string(agentcontrol.LaunchManaged) || result.RemoteURI != "unix:///tmp/codex.sock" || result.Generation != 1 || result.LeaseID == "" {
		t.Fatalf("result=%+v", result)
	}
	if err := provider.BindLease(context.Background(), agentcontrol.LeaseBindRequest{Agent: agentcontrol.AgentCodex, Payload: agentcontrol.LeaseBindPayload{LeaseID: result.LeaseID, PID: os.Getpid()}}); err != nil {
		t.Fatal(err)
	}
	if err := provider.Release(context.Background(), agentcontrol.ReleaseRequest{Agent: agentcontrol.AgentCodex, Payload: agentcontrol.ReleasePayload{LeaseID: result.LeaseID}}); err != nil {
		t.Fatal(err)
	}
	if active := sm.leases.Active(result.Generation); len(active) != 0 {
		t.Fatalf("leases=%+v", active)
	}
}

func TestCodexRuntimeAcquireFallsBackWhenDisabledOrOld(t *testing.T) {
	for _, test := range []struct {
		name    string
		state   string
		version string
	}{
		{"disabled", agentcontrol.StateDisabled, "0.144.1"},
		{"old", agentcontrol.StateEnabled, "0.144.0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			cfg := agentcontrol.DefaultConfig()
			cfg.Codex.State = test.state
			cfg.Codex.RealBinary = "/opt/codex"
			if err := agentcontrol.SaveConfig(cfg); err != nil {
				t.Fatal(err)
			}
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
			provider := newCodexRuntimeProvider(sm)
			provider.resolve = func() (string, string, error) { return "/opt/codex", test.version, nil }
			provider.coordinator.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
				t.Fatal("fallback must not start app-server")
				return nil, errors.New("unreachable")
			}
			result, err := provider.Acquire(context.Background(), agentcontrol.AcquireRequest{Agent: agentcontrol.AgentCodex, ClientPID: os.Getpid(), Payload: agentcontrol.AcquirePayload{OperationID: "op"}})
			if err != nil {
				t.Fatal(err)
			}
			if result.Mode != string(agentcontrol.LaunchNative) || result.RealBinary != "/opt/codex" {
				t.Fatalf("result=%+v", result)
			}
		})
	}
}

func TestCodexRuntimeRecoverIsLazyWithoutHandoff(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	provider := newCodexRuntimeProvider(NewSessionManager(make(chan protocol.DaemonEvent, 1)))
	provider.resolve = func() (string, string, error) {
		t.Fatal("recovery without a handoff must not probe or start Codex")
		return "", "", nil
	}
	if err := provider.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
}
