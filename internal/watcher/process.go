package watcher

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// ProcessStateChange is emitted when a process changes from alive→dead
type ProcessStateChange struct {
	Pid       int
	Alive     bool
	SessionID string
}

func UnmanagedOpenCodeProcesses(processes []platform.ProcessSnapshot, sharedBaseURL string) []platform.ProcessSnapshot {
	out := make([]platform.ProcessSnapshot, 0)
	for _, process := range processes {
		agentIndex := openCodeArgIndex(process)
		if agentIndex == -1 {
			continue
		}
		if agentIndex >= 0 && isManagedOpenCodeInvocation(process.Args[agentIndex+1:], sharedBaseURL) {
			continue
		}
		out = append(out, process)
	}
	return out
}

func HasUnmanagedOpenCodeProcessInCWD(processes []platform.ProcessSnapshot, cwd, sharedBaseURL string) bool {
	want := canonicalProcessCWD(cwd)
	for _, process := range UnmanagedOpenCodeProcesses(processes, sharedBaseURL) {
		if want != "" && canonicalProcessCWD(process.CWD) == want {
			return true
		}
	}
	return false
}

// NativeCodexTerminalPID returns the only native Codex process in cwd. Node
// launchers, app-server processes, and managed --remote clients are excluded.
// Multiple matches are left unbound because a rollout cannot safely identify
// which terminal process owns it from cwd alone.
func NativeCodexTerminalPID(processes []platform.ProcessSnapshot, cwd string) int {
	want := canonicalProcessCWD(cwd)
	if want == "" {
		return 0
	}
	matched := 0
	for _, process := range processes {
		name := strings.TrimSuffix(strings.ToLower(filepath.Base(process.Executable)), ".exe")
		if name != "codex" || canonicalProcessCWD(process.CWD) != want || !isNativeCodexTerminalInvocation(process.Args) {
			continue
		}
		if matched != 0 && matched != process.PID {
			return 0
		}
		matched = process.PID
	}
	return matched
}

func isNativeCodexTerminalInvocation(args []string) bool {
	for _, arg := range args {
		if arg == "--remote" || strings.HasPrefix(arg, "--remote=") {
			return false
		}
	}
	commandIndex := 0
	if len(args) > 0 && strings.TrimSuffix(strings.ToLower(filepath.Base(args[0])), ".exe") == "codex" {
		commandIndex = 1
	}
	if commandIndex < len(args) && args[commandIndex] == "app-server" {
		return false
	}
	return true
}

func openCodeArgIndex(process platform.ProcessSnapshot) int {
	for i, arg := range process.Args {
		name := strings.TrimSuffix(strings.ToLower(filepath.Base(arg)), ".exe")
		if name == "opencode" {
			return i
		}
	}
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(process.Executable)), ".exe")
	if name == "opencode" {
		return -2 // executable is OpenCode but argv may be unavailable
	}
	return -1
}

func isManagedOpenCodeInvocation(args []string, sharedBaseURL string) bool {
	sharedBaseURL = strings.TrimRight(sharedBaseURL, "/")
	if sharedBaseURL == "" || len(args) == 0 {
		return false
	}
	if args[0] == "attach" && len(args) > 1 {
		return strings.TrimRight(args[1], "/") == sharedBaseURL
	}
	if args[0] != "run" {
		return false
	}
	for i := 1; i < len(args); i++ {
		if args[i] == "--attach" && i+1 < len(args) {
			return strings.TrimRight(args[i+1], "/") == sharedBaseURL
		}
		if strings.HasPrefix(args[i], "--attach=") {
			return strings.TrimRight(strings.TrimPrefix(args[i], "--attach="), "/") == sharedBaseURL
		}
	}
	return false
}

func canonicalProcessCWD(cwd string) string {
	if strings.TrimSpace(cwd) == "" {
		return ""
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return filepath.Clean(cwd)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved
	}
	return filepath.Clean(abs)
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
