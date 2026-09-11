//go:build !windows

package daemon

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// Exercises real OS locks, process-start identity, SIGTERM and reaping without
// launching agents or connecting to a Relay. A status-only test would miss a
// stop path that still depended on the deleted PID file.
func TestStopRealRuntimeAfterPIDDeletion(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	t.Setenv("POCKETCTL_RUNTIME_DIR", dir)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPIDRecoveryProcessHelper$")
	cmd.Env = append(os.Environ(), "POCKETCTL_TEST_PID_RECOVERY_DIR="+dir)
	cmd.Stderr = os.Stderr
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-done })
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() || scanner.Text() != "ready" {
		t.Fatalf("helper did not publish runtime: %q (%v)", scanner.Text(), scanner.Err())
	}
	if err := os.Remove(PIDPath()); err != nil {
		t.Fatal(err)
	}
	if pid, running, err := RuntimeStatus(); err != nil || !running || pid != cmd.Process.Pid {
		t.Fatalf("deleted PID status=(%d, %v, %v)", pid, running, err)
	}
	if err := Stop(); err != nil {
		t.Fatalf("stop after PID deletion: %v", err)
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("verified child did not exit")
	}
	if _, running, err := RuntimeStatus(); err != nil || running {
		t.Fatalf("stopped runtime=(%v, %v)", running, err)
	}
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatalf("stopped child retained lock: %v", err)
	}
	_ = lock.Close()
}

func TestPIDRecoveryProcessHelper(t *testing.T) {
	dir := os.Getenv("POCKETCTL_TEST_PID_RECOVERY_DIR")
	if dir == "" {
		return
	}
	// TestMain intentionally isolates every process; point this helper back at
	// the dedicated runtime supplied by its parent after that initialization.
	t.Setenv("POCKETCTL_RUNTIME_DIR", dir)
	lock, err := AcquireInstanceLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	token, err := CurrentInstanceToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteState(&DaemonState{PID: os.Getpid(), RuntimeInstanceToken: token}); err != nil {
		t.Fatal(err)
	}
	if err := WritePID(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(filepath.Join(dir, "daemon.pid"))
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM)
	defer signal.Stop(term)
	fmt.Println("ready")
	<-term
}
