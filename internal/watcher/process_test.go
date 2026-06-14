package watcher

import (
	"context"
	"os"
	"testing"
	"time"
)

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
