//go:build windows

package daemon

import "io"

// AcquireInstanceLock is a no-op on Windows: there is no flock, and native
// daemon support isn't implemented yet (PTY/ConPTY pending). The PID-file
// check (daemon.IsRunning) remains the guard, to be replaced by LockFileEx
// when native Windows lands. Returns a no-op closer so call sites compile.
func AcquireInstanceLock() (io.Closer, error) {
	return io.NopCloser(nil), nil
}
