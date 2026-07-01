package watcher

import (
	"context"
	"time"
)

// ProcessStateChange is emitted when a process changes from alive→dead
type ProcessStateChange struct {
	Pid     int
	Alive   bool
	SessionID string
}


// ProcessMonitor periodically checks PID liveness and reports changes.
type ProcessMonitor struct {
	checkInterval time.Duration
	pids          map[int]string // pid → sessionID
	states        map[int]bool   // pid → last known alive state
	changesCh     chan ProcessStateChange
}

// NewProcessMonitor creates a process monitor with 2-second check interval.
func NewProcessMonitor() *ProcessMonitor {
	return &ProcessMonitor{
		checkInterval: 2 * time.Second,
		pids:          make(map[int]string),
		states:        make(map[int]bool),
		changesCh:     make(chan ProcessStateChange, 32),
	}
}

// Changes returns the channel for process state changes.
func (pm *ProcessMonitor) Changes() <-chan ProcessStateChange {
	return pm.changesCh
}

// Register adds a PID to monitor.
func (pm *ProcessMonitor) Register(pid int, sessionID string) {
	pm.pids[pid] = sessionID
	pm.states[pid] = true // Assume alive when registered
}

// Unregister stops monitoring a PID.
func (pm *ProcessMonitor) Unregister(pid int) {
	delete(pm.pids, pid)
	delete(pm.states, pid)
}

// Run starts the monitoring loop. Blocks until context is cancelled.
func (pm *ProcessMonitor) Run(ctx context.Context) {
	ticker := time.NewTicker(pm.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pm.checkAll()
		}
	}
}

func (pm *ProcessMonitor) checkAll() {
	for pid, sessionID := range pm.pids {
		alive := IsProcessAlive(pid)
		wasAlive := pm.states[pid]

		if wasAlive && !alive {
			// Process just died
			pm.states[pid] = false
			pm.changesCh <- ProcessStateChange{
				Pid:       pid,
				Alive:     false,
				SessionID: sessionID,
			}
		}
	}
}
