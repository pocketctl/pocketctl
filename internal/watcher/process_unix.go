//go:build !windows

package watcher

import "syscall"

// IsProcessAlive checks if a process with the given PID is still running.
func IsProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil
}
