//go:build windows

package watcher

import (
	"golang.org/x/sys/windows"
)

// IsProcessAlive checks if a process with the given PID is still running.
// PR5: real impl via OpenProcess (was PR2 stub returning false, which made
// TestIsProcessAlive fail on Windows). OpenProcess success = alive; process
// exited = error = false. Windows has no Unix zombie concept (exit = gone).
func IsProcessAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(handle)
	return true
}
