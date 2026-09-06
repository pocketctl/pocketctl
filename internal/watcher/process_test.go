package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

func TestOpenCodeAdoptionProcessClassification(t *testing.T) {
	repo := t.TempDir()
	sharedURL := "http://127.0.0.1:4096"
	processes := []platform.ProcessSnapshot{
		{PID: 1, Executable: "/opt/opencode", Args: []string{"/opt/opencode"}, CWD: repo},
		{PID: 2, Executable: "/opt/opencode", Args: []string{"/opt/opencode", "attach", sharedURL, "--dir", repo}, CWD: repo},
		{PID: 3, Executable: "/opt/opencode", Args: []string{"/opt/opencode", "attach", "http://127.0.0.1:9999"}, CWD: repo},
		{PID: 4, Executable: "/opt/opencode", Args: []string{"/opt/opencode", "run", "--attach=" + sharedURL, "fix"}, CWD: repo},
		{PID: 5, Executable: "/bin/zsh", Args: []string{"zsh"}, CWD: repo},
	}
	got := UnmanagedOpenCodeProcesses(processes, sharedURL)
	if len(got) != 2 || got[0].PID != 1 || got[1].PID != 3 {
		t.Fatalf("unmanaged=%+v", got)
	}
	if !HasUnmanagedOpenCodeProcessInCWD(processes, filepath.Join(repo, "."), sharedURL) {
		t.Fatal("native OpenCode process in cwd was not detected")
	}
	if HasUnmanagedOpenCodeProcessInCWD(processes[1:2], repo, sharedURL) {
		t.Fatal("managed attach was classified as unmanaged")
	}
}

func TestNativeCodexTerminalPID(t *testing.T) {
	repo := t.TempDir()
	processes := []platform.ProcessSnapshot{
		{PID: 11, Executable: "/opt/codex", Args: []string{"/opt/codex", "--dangerously-bypass-approvals-and-sandbox"}, CWD: repo},
		{PID: 12, Executable: "/opt/node", Args: []string{"node", "/opt/codex.js"}, CWD: repo},
		{PID: 13, Executable: "/opt/codex", Args: []string{"/opt/codex", "app-server", "--listen", "stdio://"}, CWD: repo},
		{PID: 14, Executable: "/opt/codex", Args: []string{"/opt/codex", "--remote", "unix:///tmp/app.sock"}, CWD: repo},
		{PID: 15, Executable: "/opt/codex", Args: []string{"/opt/codex"}, CWD: t.TempDir()},
	}
	if got := NativeCodexTerminalPID(processes, filepath.Join(repo, ".")); got != 11 {
		t.Fatalf("pid=%d, want native terminal pid 11", got)
	}
	processes = append(processes, platform.ProcessSnapshot{PID: 16, Executable: "/opt/codex", Args: []string{"/opt/codex"}, CWD: repo})
	if got := NativeCodexTerminalPID(processes, repo); got != 0 {
		t.Fatalf("ambiguous pid=%d, want 0", got)
	}
}

func TestProcessMonitorDetectsExit(t *testing.T) {
	pm := NewProcessMonitor()
	// Use current process PID — it's alive
	myPid := os.Getpid()
	pm.Register(myPid, "test-session")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Check that alive process is not reported as dead
	go pm.Run(ctx)
	time.Sleep(50 * time.Millisecond)

	// No changes expected for alive process
	select {
	case change := <-pm.Changes():
		t.Errorf("unexpected change for alive process: %+v", change)
	default:
		// Expected: no change
	}

	// Unregister
	pm.Unregister(myPid)
}

func TestProcessMonitorDetectsDeadProcess(t *testing.T) {
	pm := NewProcessMonitor()

	// Use a PID that definitely doesn't exist
	deadPid := 9999999
	pm.Register(deadPid, "test-session-dead")
	// Override initial state to "alive" so the transition is detected
	pm.states[deadPid] = true

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan ProcessStateChange, 1)
	go pm.Run(ctx)

	select {
	case change := <-pm.Changes():
		if change.Pid != deadPid {
			t.Errorf("expected pid %d, got %d", deadPid, change.Pid)
		}
		if change.Alive {
			t.Error("expected Alive to be false")
		}
		if change.SessionID != "test-session-dead" {
			t.Errorf("expected session_id test-session-dead, got %q", change.SessionID)
		}
		done <- change
	case <-time.After(4 * time.Second):
		t.Fatal("timed out waiting for dead process detection")
	}
}

func TestIsProcessAlive(t *testing.T) {
	// Current process should be alive
	if !IsProcessAlive(os.Getpid()) {
		t.Error("current process should be alive")
	}

	// Non-existent PID should not be alive
	if IsProcessAlive(9999999) {
		t.Error("non-existent PID should not be alive")
	}
}

func TestProcessMonitorUnregister(t *testing.T) {
	pm := NewProcessMonitor()
	myPid := os.Getpid()
	pm.Register(myPid, "test-session")
	pm.Unregister(myPid)

	// After unregister, no entries should exist
	if _, ok := pm.pids[myPid]; ok {
		t.Error("pid should have been unregistered")
	}
	if _, ok := pm.states[myPid]; ok {
		t.Error("state should have been removed")
	}
}

func TestProcessMonitor_MultiplePIDs(t *testing.T) {
	pm := NewProcessMonitor()
	myPid := os.Getpid()
	deadPid := 9999999

	pm.Register(myPid, "alive-session")
	pm.Register(deadPid, "dead-session")
	// Set dead PID initial state to alive so transition is detected
	pm.states[deadPid] = true

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go pm.Run(ctx)

	// Wait for check cycle
	time.Sleep(2500 * time.Millisecond)

	// Should have exactly one change: dead PID detected
	var changes []ProcessStateChange
	timeout := time.After(500 * time.Millisecond)
collect:
	for {
		select {
		case change := <-pm.Changes():
			changes = append(changes, change)
		case <-timeout:
			break collect
		}
	}

	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}
	if changes[0].Pid != deadPid {
		t.Errorf("expected dead PID %d, got %d", deadPid, changes[0].Pid)
	}
	if changes[0].SessionID != "dead-session" {
		t.Errorf("expected session 'dead-session', got %q", changes[0].SessionID)
	}
}

func TestProcessMonitor_NoDuplicateEvents(t *testing.T) {
	pm := NewProcessMonitor()
	deadPid := 9999998
	pm.Register(deadPid, "dedup-session")
	pm.states[deadPid] = true // force alive state

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	go pm.Run(ctx)

	// Wait for first event
	select {
	case change := <-pm.Changes():
		if change.Pid != deadPid {
			t.Errorf("expected PID %d, got %d", deadPid, change.Pid)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("timed out waiting for first death event")
	}

	// Drain any additional events for 3 seconds
	var extra int
	extraTimeout := time.After(3 * time.Second)
drain:
	for {
		select {
		case <-pm.Changes():
			extra++
		case <-extraTimeout:
			break drain
		}
	}

	if extra > 0 {
		t.Errorf("expected no duplicate events, got %d additional events", extra)
	}
}
