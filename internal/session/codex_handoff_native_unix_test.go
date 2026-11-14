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
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Explicitly opt in: no developer auth/config or running daemon is used.
func TestCodexNpmNativeRestartHandoff(t *testing.T) {
	binary, node := os.Getenv("POCKETCTL_TEST_CODEX_NPM"), os.Getenv("POCKETCTL_TEST_CODEX_NODE")
	if binary == "" || node == "" {
		t.Skip("set POCKETCTL_TEST_CODEX_NPM and POCKETCTL_TEST_CODEX_NODE for isolated native acceptance")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
	versionOutput, err := exec.Command(node, binary, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(string(versionOutput))
	if len(fields) != 2 {
		t.Fatalf("unexpected Codex version: %q", versionOutput)
	}
	version := fields[1]
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	first := newCodexCoordinator(sm)
	first.start = func(ctx context.Context, binary, version string, generation uint64) (*codexAppServerRuntime, error) {
		return startCodexAppServerWithFactoryForHome(ctx, binary, version, generation, "", os.Getenv("CODEX_HOME"), 15*time.Second, func(binary, socket string) *exec.Cmd {
			return exec.Command(node, binary, "app-server", "-c", "thread_unload_delay_secs=0", "--listen", "unix://"+socket)
		})
	}
	caps := agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "native-handoff"}
	snapshot, err := first.ensureStarted(ctx, binary, version, caps)
	if err != nil {
		t.Fatal(err)
	}
	runtime := first.runtime
	defer runtime.Stop()
	if runtime.ProcessExecutable == "" || normalizeCwd(runtime.ProcessExecutable) == normalizeCwd(binary) {
		t.Fatalf("execve image was not pinned: %+v", runtime)
	}
	if err = sm.leases.Register(agentcontrol.Lease{ID: "native-terminal", Agent: agentcontrol.AgentCodex, PID: os.Getpid(), Generation: snapshot.Generation}); err != nil {
		t.Fatal(err)
	}
	if err = first.shutdown(); err != nil {
		t.Fatal(err)
	}
	_ = runtime.Client.Close() // Simulate the old daemon process exiting.
	for _, legacy := range []bool{false, true} {
		state, err := daemon.ReadCodexAppServerState()
		if err != nil {
			t.Fatal(err)
		}
		if legacy {
			state.ProcessExecutable = ""
			if err = daemon.WriteCodexAppServerState(state); err != nil {
				t.Fatal(err)
			}
		}
		next := newCodexCoordinator(NewSessionManager(make(chan protocol.DaemonEvent, 32)))
		next.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
			t.Fatal("replaced live terminal runtime instead of adopting")
			return nil, nil
		}
		restored, err := next.ensureStarted(ctx, binary, version, caps)
		if err != nil {
			t.Fatalf("legacy=%v: %v", legacy, err)
		}
		if restored.PID != snapshot.PID || restored.Generation != snapshot.Generation || restored.RemoteURI != snapshot.RemoteURI {
			t.Fatalf("live runtime identity changed: %+v -> %+v", snapshot, restored)
		}
		if len(next.sm.leases.Active(restored.Generation)) != 1 {
			t.Fatal("terminal lease lost during restart")
		}
		t.Logf("legacy=%v adopted pid=%d generation=%d executable=%s", legacy, restored.PID, restored.Generation, next.runtime.ProcessExecutable)
		client := next.runtime.Client
		if err = next.shutdown(); err != nil {
			t.Fatal(err)
		}
		_ = client.Close()
	}
}
