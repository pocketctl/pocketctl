//go:build !windows

package update

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

func preserveInstallOwner(path string, info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("cannot determine installation owner")
	}
	if os.Geteuid() == 0 {
		return os.Chown(path, int(stat.Uid), int(stat.Gid))
	}
	// An ordinary rename must not turn a root-owned executable into user-owned.
	if int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("installation requires owner uid %d", stat.Uid)
	}
	return os.Chown(path, -1, int(stat.Gid))
}

func IsElevated() bool { return os.Geteuid() == 0 }

// NeedsElevation checks both ownership and the directory used for atomic rename.
func NeedsElevation(target string) (bool, error) {
	info, err := os.Stat(target)
	if err != nil {
		return false, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false, fmt.Errorf("cannot determine installation owner")
	}
	if IsElevated() {
		return false, nil
	}
	if int(stat.Uid) != os.Geteuid() {
		return true, nil
	}
	if err = unix.Access(filepath.Dir(target), unix.W_OK|unix.X_OK); err != nil {
		if err == unix.EACCES || err == unix.EPERM {
			return true, nil
		}
		return false, err
	}
	return false, nil
}

// ValidateElevatedExecutable refuses to run a user-writable program as root.
// Resolve symlinks first; every real ancestor must also be root-controlled.
func ValidateElevatedExecutable(target string) error {
	path, err := filepath.EvalSymlinks(target)
	if err != nil {
		return err
	}
	for {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 0 || info.Mode().Perm()&0022 != 0 {
			return fmt.Errorf("cannot elevate an executable through a non-root-controlled path: %s", path)
		}
		parent := filepath.Dir(path)
		if parent == path {
			break
		}
		path = parent
	}
	return nil
}
