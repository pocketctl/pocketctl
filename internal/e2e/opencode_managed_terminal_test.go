//go:build !windows

package e2e

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
)

type managedTerminalProvider struct {
	realBinary string
	mu         sync.Mutex
	acquire    agentcontrol.AcquireRequest
	bound      agentcontrol.LeaseBindRequest
	released   agentcontrol.ReleaseRequest
}

func (p *managedTerminalProvider) Acquire(_ context.Context, req agentcontrol.AcquireRequest) (agentcontrol.AcquireResult, error) {
	p.mu.Lock()
	p.acquire = req
	p.mu.Unlock()
	return agentcontrol.AcquireResult{
		Mode:              string(agentcontrol.LaunchManaged),
		BaseURL:           "http://127.0.0.1:4096",
		Password:          "release-gate-secret",
		Username:          "pocketctl",
		RealBinary:        p.realBinary,
		ResolvedSessionID: "ses_shared",
		LeaseID:           "lease-terminal",
		Generation:        17,
	}, nil
}

func (p *managedTerminalProvider) BindLease(_ context.Context, req agentcontrol.LeaseBindRequest) error {
	p.mu.Lock()
	p.bound = req
	p.mu.Unlock()
	return nil
}

func (p *managedTerminalProvider) Release(_ context.Context, req agentcontrol.ReleaseRequest) error {
	p.mu.Lock()
	p.released = req
	p.mu.Unlock()
	return nil
}

func (*managedTerminalProvider) Status(context.Context, agentcontrol.RuntimeStatusRequest) (agentcontrol.RuntimeStatusResult, error) {
	return agentcontrol.RuntimeStatusResult{Mode: string(agentcontrol.LaunchManaged), BaseURL: "http://127.0.0.1:4096", Generation: 17}, nil
}

func writeRealAgentFixture(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("test executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

func TestOpenCodeManagedTerminalUsesSharedRuntimeThroughRealIPC(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "pocketctl-managed-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "control.sock")
	realBinary := writeRealAgentFixture(t, dir, "opencode")
	provider := &managedTerminalProvider{realBinary: realBinary}
	server := agentcontrol.NewServer(socket, map[string]agentcontrol.RuntimeProvider{agentcontrol.AgentOpenCode: provider})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })

	client := agentcontrol.NewClient(socket)
	var executed agentcontrol.ExecSpec
	launcher := agentcontrol.Launcher{
		Acquire:   client.Acquire,
		BindLease: client.BindLease,
		Release:   client.Release,
		Execute: func(spec agentcontrol.ExecSpec) error {
			executed = spec
			if spec.OnStart == nil {
				t.Fatal("managed terminal did not receive a lease binder")
			}
			return spec.OnStart(4242)
		},
		Environ: func() []string { return []string{"HOME=/fixture/home", "TERM=xterm-256color"} },
		Timeout: time.Second,
	}
	if err := launcher.Run(context.Background(), []string{"-c"}, "/fixture/repo"); err != nil {
		t.Fatal(err)
	}

	wantArgs := []string{"attach", "http://127.0.0.1:4096", "--dir", "/fixture/repo", "--session", "ses_shared"}
	if executed.Path != realBinary || !reflect.DeepEqual(executed.Args, wantArgs) || executed.Dir != "/fixture/repo" {
		t.Fatalf("managed execution=%+v", executed)
	}
	if strings.Contains(strings.Join(executed.Args, " "), "release-gate-secret") || envValue(executed.Env, "OPENCODE_SERVER_PASSWORD") != "release-gate-secret" {
		t.Fatalf("credential boundary violated: args=%q env=%q", executed.Args, executed.Env)
	}

	provider.mu.Lock()
	acquire, bound, released := provider.acquire, provider.bound, provider.released
	provider.mu.Unlock()
	if acquire.Payload.Intent != agentcontrol.IntentContinue || acquire.Payload.CWD != "/fixture/repo" {
		t.Fatalf("acquire=%+v", acquire)
	}
	if bound.Payload.LeaseID != "lease-terminal" || bound.Payload.PID != 4242 || released.Payload.LeaseID != "lease-terminal" {
		t.Fatalf("lease lifecycle: bind=%+v release=%+v", bound, released)
	}

	// Web and iOS consume relay state rather than this local socket. Two status
	// readers here assert the shared runtime identity that the daemon publishes
	// to both clients remains stable for this terminal generation.
	for _, clientName := range []string{"web", "ios"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		status, err := client.Status(ctx, agentcontrol.StatusPayload{})
		cancel()
		if err != nil || status.Mode != string(agentcontrol.LaunchManaged) || status.Generation != 17 || status.BaseURL != "http://127.0.0.1:4096" {
			t.Fatalf("%s shared runtime status=%+v err=%v", clientName, status, err)
		}
	}
}

func TestOpenCodeManagedTerminalMissingDaemonPreservesNativeInvocation(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "pocketctl-fallback-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	client := agentcontrol.NewClient(filepath.Join(dir, "missing.sock"))
	nativeExit := errors.New("fixture exit 23")
	var executed agentcontrol.ExecSpec
	var stderr bytes.Buffer
	launcher := agentcontrol.Launcher{
		Acquire: client.Acquire,
		ResolveBinary: func() (string, error) {
			return "/fixture/real-opencode", nil
		},
		Execute: func(spec agentcontrol.ExecSpec) error {
			executed = spec
			return nativeExit
		},
		Environ: func() []string { return []string{"HOME=/fixture/home", "TERM=xterm"} },
		Stderr:  &stderr,
		Timeout: 200 * time.Millisecond,
	}
	started := time.Now()
	err = launcher.Run(context.Background(), []string{"-c"}, "/fixture/repo")
	if !errors.Is(err, nativeExit) {
		t.Fatalf("native exit was not propagated: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("native fallback took %v", elapsed)
	}
	if executed.Path != "/fixture/real-opencode" || !reflect.DeepEqual(executed.Args, []string{"-c"}) || executed.Dir != "/fixture/repo" {
		t.Fatalf("native execution=%+v", executed)
	}
	if !reflect.DeepEqual(executed.Env, []string{"HOME=/fixture/home", "TERM=xterm"}) {
		t.Fatalf("native env=%q", executed.Env)
	}
	if strings.Count(strings.TrimSpace(stderr.String()), "\n") != 0 {
		t.Fatalf("fallback diagnostic must stay on one line: %q", stderr.String())
	}
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}
