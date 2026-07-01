//go:build windows

package watcher

// IsProcessAlive on Windows: native impl (OpenProcess) lands in a later PR.
// Returns false for now so ProcessMonitor treats registered pids as dead on
// next check — acceptable since daemon-side Windows PTY sessions are stubbed
// (PR1) and terminal-session monitoring on Windows is a later concern.
func IsProcessAlive(pid int) bool {
	return false
}
