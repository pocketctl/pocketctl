//go:build !windows

package daemon

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// AcquireInstanceLock takes an exclusive, non-blocking advisory lock on the
// daemon lock file, ensuring only one daemon process runs per host.
//
// The lock is released when the returned Closer is closed — and, critically,
// is ALSO released automatically by the kernel the moment the process dies
// (even via SIGKILL or a crash). That makes this race-free, unlike the PID-file
// check (daemon.IsRunning), where two near-simultaneous `daemon start` invocations
// can both read a stale/missing PID and both proceed to fork.
//
// Why it matters: two daemon processes on one host each load whatever token
// generation they find and register with the relay. When the token rotates, the
// one holding the old token goes stale and becomes an invalid-token zombie that
// spams the relay. The single-instance lock prevents the second process from
// ever starting, so this can't happen. This is the P1-d root-cause fix on top
// of the P0 relay-side rate limiting and P1-a auto-refresh.
func AcquireInstanceLock() (io.Closer, error) {
	if err := os.MkdirAll(pidDir, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", pidDir, err)
	}
	path := filepath.Join(pidDir, "daemon.lock")
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another pocketctl daemon is already running on this host")
	}
	return f, nil
}
