//go:build !windows

package session

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
)

func codexHandoffChild(t *testing.T, endpoint string) *exec.Cmd {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app-server"), []byte("while :; do sleep 1; done\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/bash", "app-server", "--listen", "unix://"+endpoint)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); _ = cmd.Wait() })
	return cmd
}

func TestStopPersistedCodexHandoffDoesNotKillReusedPIDOrUnlinkForeignEndpoint(t *testing.T) {
	// A real unrelated process group occupies a stale handoff's PID. Merely
	// being alive must never authorize a signal or deletion of its endpoint.
	endpoint := filepath.Join(t.TempDir(), "foreign.sock")
	if err := os.WriteFile(endpoint, []byte("foreign endpoint"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := codexHandoffChild(t, endpoint+".different-runtime")
	state := &daemon.CodexAppServerState{PID: cmd.Process.Pid, Binary: "/bin/bash", Endpoint: endpoint, RemoteURI: "unix://" + endpoint}
	if err := stopPersistedCodexAppServer(state); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	var status syscall.WaitStatus
	if pid, err := syscall.Wait4(cmd.Process.Pid, &status, syscall.WNOHANG, nil); err != nil || pid != 0 {
		t.Fatalf("stale handoff killed a live foreign process: reaped_pid=%d status=%v error=%v", pid, status, err)
	}
	if raw, err := os.ReadFile(endpoint); err != nil || string(raw) != "foreign endpoint" {
		t.Fatalf("stale handoff unlinked foreign endpoint: %q %v", raw, err)
	}
}

func TestStopPersistedCodexHandoffStopsOnlyExactBinaryAndListenIdentity(t *testing.T) {
	endpoint := filepath.Join(t.TempDir(), "owned.sock")
	if err := os.WriteFile(endpoint, []byte("owned endpoint"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := codexHandoffChild(t, endpoint)
	// Allow the shell child to exec before inspecting its argv.
	deadline := time.Now().Add(time.Second)
	for {
		processes, err := platform.NewProcessInspector().List()
		if err != nil {
			t.Fatal(err)
		}
		ready := false
		for _, process := range processes {
			if process.PID == cmd.Process.Pid && len(process.Args) > 1 && process.Args[1] == "app-server" {
				ready = true
			}
		}
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fixture app-server did not exec")
		}
		time.Sleep(time.Millisecond)
	}
	state := &daemon.CodexAppServerState{PID: cmd.Process.Pid, Binary: "/bin/bash", Endpoint: endpoint, RemoteURI: "unix://" + endpoint}
	if err := stopPersistedCodexAppServer(state); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(endpoint); !os.IsNotExist(err) {
		t.Fatalf("owned stopped endpoint was not removed: %v", err)
	}
}

func TestStopPersistedCodexHandoffRequiresStoredBirthIdentity(t *testing.T) {
	endpoint := filepath.Join(t.TempDir(), "unchanged.sock")
	if err := os.WriteFile(endpoint, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := codexHandoffChild(t, endpoint)
	state := &daemon.CodexAppServerState{PID: cmd.Process.Pid, ProcessStartIdentity: "stale-birth-token", Binary: "/bin/bash", Endpoint: endpoint, RemoteURI: "unix://" + endpoint}
	if err := stopPersistedCodexAppServer(state); err != nil {
		t.Fatal(err)
	}
	var status syscall.WaitStatus
	if pid, err := syscall.Wait4(cmd.Process.Pid, &status, syscall.WNOHANG, nil); err != nil || pid != 0 {
		t.Fatalf("wrong birth identity killed process: pid=%d err=%v", pid, err)
	}
	if _, err := os.Stat(endpoint); err != nil {
		t.Fatalf("wrong birth identity unlinked endpoint: %v", err)
	}
	state.ProcessStartIdentity, _ = platform.ProcessStartIdentity(cmd.Process.Pid)
	if err := stopPersistedCodexAppServer(state); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(endpoint); !os.IsNotExist(err) {
		t.Fatalf("matching birth/argv did not release owned endpoint: %v", err)
	}
}

func TestCodexCoordinatorStaleProjectHandoffPreservesOtherProjectRuntime(t *testing.T) {
	for _, storedBirth := range []string{"", "stale-birth-token"} {
		t.Run(storedBirth, func(t *testing.T) {
			endpoint := filepath.Join(t.TempDir(), "live-other-project.sock")
			if err := os.WriteFile(endpoint, []byte("foreign project endpoint"), 0o600); err != nil {
				t.Fatal(err)
			}
			cmd := codexHandoffChild(t, endpoint)
			coord := newVerifiedTestCodexCoordinator(nil)
			coord.statePath = filepath.Join(t.TempDir(), "old-project.state")
			state := &daemon.CodexAppServerState{PID: cmd.Process.Pid, ProcessStartIdentity: storedBirth, Binary: "/bin/bash", Endpoint: endpoint + ".old-project", RemoteURI: "unix://" + endpoint + ".old-project", Version: "0.154.0", Generation: 7, SchemaHash: "schema", Threads: []string{"owned-old-thread"}}
			if err := daemon.WriteCodexAppServerStateAt(coord.statePath, state); err != nil {
				t.Fatal(err)
			}
			coord.adopt = func(context.Context, *daemon.CodexAppServerState) (*codexAppServerRuntime, error) {
				return nil, errors.New("old endpoint gone")
			}
			coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
				return &codexAppServerRuntime{PID: 999999, Endpoint: "/new/project.sock", RemoteURI: "unix:///new/project.sock"}, nil
			}
			snapshot, err := coord.ensureStarted(context.Background(), state.Binary, state.Version, agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: state.SchemaHash})
			if err != nil || snapshot.Generation != 8 {
				t.Fatalf("stale state replacement=%+v err=%v", snapshot, err)
			}
			var status syscall.WaitStatus
			if pid, err := syscall.Wait4(cmd.Process.Pid, &status, syscall.WNOHANG, nil); err != nil || pid != 0 {
				t.Fatalf("project recovery killed another runtime: pid=%d status=%v err=%v", pid, status, err)
			}
			if _, err := os.Stat(endpoint); err != nil {
				t.Fatalf("project recovery removed another runtime endpoint: %v", err)
			}
			if ids := coord.managedThreadSnapshot(); len(ids) != 1 || ids[0] != "owned-old-thread" {
				t.Fatalf("recovery lost existing thread identity: %v", ids)
			}
		})
	}
}
