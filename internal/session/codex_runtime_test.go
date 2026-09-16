package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
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

func TestCodexRuntimeAcquireSeparatesConfiguredHomes(t *testing.T) {
	userHome := t.TempDir()
	primaryHome := filepath.Join(userHome, ".codex")
	extraHome := filepath.Join(userHome, ".codex-proxy")
	for _, home := range []string{primaryHome, extraHome} {
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", userHome)
	t.Setenv("CODEX_HOME", primaryHome)
	t.Setenv("POCKETCTL_CODEX_HOMES", extraHome)
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
		return &codexAppServerRuntime{PID: 101, Endpoint: "/tmp/codex-primary.sock", RemoteURI: "unix:///tmp/codex-primary.sock"}, nil
	}
	provider.coordinator.probe = func(context.Context, *codexAppServerRuntime) error { return nil }
	provider.coordinatorFactory = func(adapter.CodexHomeProfile) *codexCoordinator {
		coord := newCodexCoordinator(sm)
		coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
			return &codexAppServerRuntime{PID: 202, Endpoint: "/tmp/codex-proxy.sock", RemoteURI: "unix:///tmp/codex-proxy.sock"}, nil
		}
		coord.probe = func(context.Context, *codexAppServerRuntime) error { return nil }
		return coord
	}

	resolvedPrimary, err := agentcontrol.ResolveCodexHome(primaryHome, userHome)
	if err != nil {
		t.Fatal(err)
	}
	resolvedExtra, err := agentcontrol.ResolveCodexHome(extraHome, userHome)
	if err != nil {
		t.Fatal(err)
	}
	primaryID := agentcontrol.CodexHomeID(resolvedPrimary)
	extraID := agentcontrol.CodexHomeID(resolvedExtra)
	acquire := func(operationID, homeID string) agentcontrol.AcquireResult {
		result, err := provider.Acquire(context.Background(), agentcontrol.AcquireRequest{
			Agent: agentcontrol.AgentCodex, ClientPID: os.Getpid(),
			Payload: agentcontrol.AcquirePayload{
				CWD: "/repo", Intent: agentcontrol.IntentNew, OperationID: operationID, CodexHomeID: homeID,
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}

	primary := acquire("primary", primaryID)
	extra := acquire("proxy", extraID)
	if primary.RemoteURI != "unix:///tmp/codex-primary.sock" || extra.RemoteURI != "unix:///tmp/codex-proxy.sock" || primary.RemoteURI == extra.RemoteURI {
		t.Fatalf("configured homes shared one runtime: primary=%+v extra=%+v", primary, extra)
	}
	primaryState, err := daemon.ReadCodexAppServerState()
	if err != nil {
		t.Fatal(err)
	}
	if primaryState.Endpoint != "/tmp/codex-primary.sock" {
		t.Fatalf("additional home overwrote primary runtime state: %+v", primaryState)
	}
	extraStates, err := filepath.Glob(filepath.Join(userHome, ".pocketctl", "codex-home-runtimes", "*.state"))
	if err != nil {
		t.Fatal(err)
	}
	if len(extraStates) != 1 {
		t.Fatalf("additional home runtime state files=%v, want one isolated state", extraStates)
	}
	extraState, err := daemon.ReadCodexAppServerStateAt(extraStates[0])
	if err != nil {
		t.Fatal(err)
	}
	if extraState.Endpoint != "/tmp/codex-proxy.sock" {
		t.Fatalf("additional home state=%+v", extraState)
	}
	for path, wantID := range map[string]string{
		daemon.CodexAppServerStatePath(): primaryID,
		extraStates[0]:                   extraID,
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]any
		if err := json.Unmarshal(raw, &wire); err != nil {
			t.Fatal(err)
		}
		if wire["codex_home_id"] != wantID {
			t.Fatalf("runtime state %s has codex_home_id=%v, want %s", path, wire["codex_home_id"], wantID)
		}
	}
	if err := provider.Release(context.Background(), agentcontrol.ReleaseRequest{
		Agent:   agentcontrol.AgentCodex,
		Payload: agentcontrol.ReleasePayload{LeaseID: extra.LeaseID},
	}); err != nil {
		t.Fatal(err)
	}
	extraState, err = daemon.ReadCodexAppServerStateAt(extraStates[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(extraState.Leases) != 0 {
		t.Fatalf("released additional-home lease remained persisted: %+v", extraState.Leases)
	}
}

func TestCodexRuntimeAcquireDoesNotRewriteLauncherOrShellFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/opt/codex/bin:/usr/bin:/bin")
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	cfg.Codex.RealBinary = "/opt/codex"
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	configPath, err := agentcontrol.ConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	fixtures := map[string]struct {
		content string
		mode    os.FileMode
	}{
		filepath.Join(home, ".pocketctl", "bin", "codex"):     {"#!/bin/sh\n# pocketctl-agent-launcher-v2\n", 0o755},
		filepath.Join(home, ".pocketctl", "shell", "path.sh"): {"export PATH=fixture\n", 0o600},
		filepath.Join(home, ".zshrc"):                         {"# zsh fixture\n", 0o600},
		filepath.Join(home, ".bash_profile"):                  {"# bash profile fixture\n", 0o600},
		filepath.Join(home, ".bashrc"):                        {"# bashrc fixture\n", 0o600},
	}
	for path, fixture := range fixtures {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(fixture.content), fixture.mode); err != nil {
			t.Fatal(err)
		}
	}

	type fileSnapshot struct {
		info    os.FileInfo
		content string
		mode    os.FileMode
		modTime int64
	}
	paths := []string{configPath}
	for path := range fixtures {
		paths = append(paths, path)
	}
	before := make(map[string]fileSnapshot, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		before[path] = fileSnapshot{info: info, content: string(raw), mode: info.Mode(), modTime: info.ModTime().UnixNano()}
	}
	pathEnv := os.Getenv("PATH")

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
		Payload: agentcontrol.AcquirePayload{CWD: "/repo", Intent: agentcontrol.IntentNew, OperationID: "readonly-acquire"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Mode != string(agentcontrol.LaunchManaged) {
		t.Fatalf("result=%+v want normal managed Acquire", result)
	}
	if got := os.Getenv("PATH"); got != pathEnv {
		t.Fatalf("PATH=%q want unchanged %q", got, pathEnv)
	}
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s after Acquire: %v", path, err)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s after Acquire: %v", path, err)
		}
		want := before[path]
		if !os.SameFile(want.info, info) || string(raw) != want.content || info.Mode() != want.mode || info.ModTime().UnixNano() != want.modTime {
			t.Errorf("Acquire rewrote %s", path)
		}
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

func TestCodexRuntimeAcquireFallsBackWhileIncompatibleRuntimeHasActiveLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	cfg.Codex.RealBinary = "/opt/codex"
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	provider := newCodexRuntimeProvider(sm)
	provider.resolve = func() (string, string, error) { return "/opt/codex", "0.147.0", nil }
	provider.probe = func(context.Context, string, string) (agentcontrol.CodexCapabilities, error) {
		return agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "new-schema"}, nil
	}
	provider.coordinator.runtime = &codexAppServerRuntime{
		PID: 123, Endpoint: "/tmp/codex-old.sock", RemoteURI: "unix:///tmp/codex-old.sock",
		Stop: func() error {
			t.Fatal("active terminal must preserve the old runtime")
			return nil
		},
	}
	provider.coordinator.binary = "/opt/codex"
	provider.coordinator.version = "0.146.1"
	provider.coordinator.schemaHash = "old-schema"
	provider.coordinator.generation = 4
	provider.coordinator.probe = func(context.Context, *codexAppServerRuntime) error { return nil }
	if err := sm.leases.Register(agentcontrol.Lease{ID: "active-terminal", Agent: agentcontrol.AgentCodex, PID: os.Getpid(), Generation: 4}); err != nil {
		t.Fatal(err)
	}

	result, err := provider.Acquire(context.Background(), agentcontrol.AcquireRequest{
		Agent: agentcontrol.AgentCodex, ClientPID: os.Getpid(),
		Payload: agentcontrol.AcquirePayload{CWD: "/repo", Intent: agentcontrol.IntentNew, OperationID: "after-upgrade"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Mode != string(agentcontrol.LaunchNative) || result.RealBinary != "/opt/codex" || result.LeaseID != "" {
		t.Fatalf("result=%+v want native fallback without a new lease", result)
	}
	if !strings.Contains(result.Reason, "upgrade is deferred") {
		t.Fatalf("reason=%q want deferred-upgrade explanation", result.Reason)
	}
	leases := sm.leases.Snapshot()
	if len(leases) != 1 || leases["active-terminal"].Generation != 4 {
		t.Fatalf("leases=%+v want only the pre-existing active lease", leases)
	}
}

func TestCodexRuntimeRecoverAdoptsIncompatibleHandoffWithActiveLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	cfg.Codex.RealBinary = "/opt/codex"
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	activeLeases := agentcontrol.NewLeaseRegistry()
	if err := activeLeases.Register(agentcontrol.Lease{ID: "active-terminal", Agent: agentcontrol.AgentCodex, PID: os.Getpid(), Generation: 7}); err != nil {
		t.Fatal(err)
	}
	state := &daemon.CodexAppServerState{
		PID: os.Getpid(), OwnerPID: 0, Endpoint: "/tmp/codex-old.sock", RemoteURI: "unix:///tmp/codex-old.sock",
		Binary: "/opt/codex", Version: "0.146.1", SchemaHash: "old-schema", Generation: 7,
		Leases:  activeLeases.Snapshot(),
		Threads: []string{"thr_keep"},
	}
	if err := daemon.WriteCodexAppServerState(state); err != nil {
		t.Fatal(err)
	}

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	provider := newCodexRuntimeProvider(sm)
	provider.resolve = func() (string, string, error) { return "/opt/codex", "0.147.0", nil }
	provider.probe = func(context.Context, string, string) (agentcontrol.CodexCapabilities, error) {
		return agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "new-schema"}, nil
	}
	adopted := false
	provider.coordinator.adopt = func(_ context.Context, got *daemon.CodexAppServerState) (*codexAppServerRuntime, error) {
		adopted = true
		if got.Generation != state.Generation || got.Version != state.Version || got.SchemaHash != state.SchemaHash {
			t.Fatalf("handoff=%+v want persisted old identity", got)
		}
		return &codexAppServerRuntime{PID: state.PID, Endpoint: state.Endpoint, RemoteURI: state.RemoteURI}, nil
	}
	provider.coordinator.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		t.Fatal("active handoff must be adopted, not replaced")
		return nil, nil
	}

	if err := provider.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !adopted {
		t.Fatal("active incompatible handoff was not adopted")
	}
	snapshot, running := provider.coordinator.status()
	if !running || snapshot.Generation != 7 || snapshot.Version != "0.146.1" || snapshot.SchemaHash != "old-schema" {
		t.Fatalf("snapshot=%+v running=%t want adopted old identity", snapshot, running)
	}
	if !hasActiveCodexLease(sm.leases.Snapshot(), 7) {
		t.Fatalf("leases=%+v want restored active lease", sm.leases.Snapshot())
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
