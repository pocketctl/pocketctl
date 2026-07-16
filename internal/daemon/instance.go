package daemon

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// AcquireInstanceLock takes an exclusive, non-blocking lock ensuring only one
// daemon process runs per host. PR2: delegates to platform.InstanceLocker
// (was direct unix.Flock in the former instance_unix.go). The lock is released
// when the returned Closer is closed — and, critically, is ALSO released
// automatically by the OS the moment the process dies (even via SIGKILL or a
// crash), making it race-free vs the PID-file check.
//
// Public API unchanged — main.go calls daemon.AcquireInstanceLock() with zero
// modification. Replaces the former instance_unix.go / instance_windows.go
// build-tag split (platform now owns the platform split).
func AcquireInstanceLock() (io.Closer, error) {
	if err := os.MkdirAll(pidDir, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", pidDir, err)
	}
	return AcquireInstanceLockAt(filepath.Join(pidDir, "daemon.lock"))
}

// AcquireInstanceLockAt is the path-selectable form used by restart ownership
// handoff and process-level tests.
func AcquireInstanceLockAt(path string) (io.Closer, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	lock, err := defaultLocker.Acquire(path)
	if err != nil {
		return nil, err // platform 已包装 "another pocketctl daemon is already running..."
	}
	return lock, nil
}
