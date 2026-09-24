//go:build !windows

package session

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"golang.org/x/sys/unix"
)

// Runs without credentials/inference in an isolated Docker container. Check
// both upstream unload and the actual OS writer lock, not merely local state.
func TestInstalledCodexThreadReleaseAndResume(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_LIFECYCLE_SMOKE") != "1" {
		t.Skip("isolated Codex lifecycle smoke is opt-in")
	}
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	t.Setenv("HOME", t.TempDir())
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("thread_unload_delay_secs = 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	runtime, err := startCodexAppServerForHome(ctx, binary, "smoke", 981, "", home)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Stop()
	defer runtime.Client.Close()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-runtime.Client.Events():
				if !ok {
					return
				}
			}
		}
	}()
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	c := newVerifiedTestCodexCoordinator(sm)
	c.runtime, c.generation = runtime, 981
	c.statePath = filepath.Join(t.TempDir(), "runtime.state")
	b := newCodexAppServerBackend(sm, c, runtime.Client, 981)
	a, err := b.Start(ctx, protocol.SessionConfig{Agent: "codex", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	other, err := b.Start(ctx, protocol.SessionConfig{Agent: "codex", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	locked := func(id string) bool {
		t.Helper()
		f, err := os.OpenFile(filepath.Join(home, "thread-writer-locks", id+".lock"), os.O_RDWR, 0600)
		if os.IsNotExist(err) {
			return false
		}
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			_ = unix.Flock(int(f.Fd()), unix.LOCK_UN)
			return false
		}
		if err != unix.EWOULDBLOCK {
			t.Fatal(err)
		}
		return true
	}
	if !locked(a) || !locked(other) {
		t.Fatal("initial writer locks are not held")
	}
	for leaseID, threadID := range map[string]string{"cli-a": a, "cli-b": other} {
		if err := sm.leases.Register(agentcontrol.Lease{ID: leaseID, Agent: "codex", SessionID: threadID, PID: os.Getpid(), Generation: 981}); err != nil {
			t.Fatal(err)
		}
	}
	provider := &CodexRuntimeProvider{sm: sm, coordinator: c}
	if err := provider.Release(ctx, agentcontrol.ReleaseRequest{Payload: agentcontrol.ReleasePayload{LeaseID: "cli-a"}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	c.reapIdleThreads(ctx, now)
	c.reapIdleThreads(ctx, now.Add(65*time.Second))
	for locked(a) {
		select {
		case <-ctx.Done():
			t.Fatal("writer lock remained held after unsubscribe")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !locked(other) {
		t.Fatal("release affected another thread's writer lock")
	}
	var loaded struct {
		Data []string `json:"data"`
	}
	if err := runtime.Client.Call(ctx, "thread/loaded/list", map[string]any{}, &loaded); err != nil {
		t.Fatal(err)
	}
	for _, id := range loaded.Data {
		if id == a {
			t.Fatal("released thread is still loaded")
		}
	}
	if err := b.Resume(ctx, a); err != nil {
		t.Fatal(err)
	}
	if !locked(a) || !locked(other) {
		t.Fatal("resume did not reacquire target while preserving other thread")
	}
	t.Log("real app-server: target unloaded and writer lock released; sibling retained; remote resume reacquired target")
}
