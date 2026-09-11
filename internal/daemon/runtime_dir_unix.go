//go:build !windows

package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/pocketctl/pocketctl/internal/config"
)

const legacyDefaultRuntimeDir = "/tmp/pocketctl"

// secureRuntimeDir resolves or creates this user's private daemon runtime
// directory. Identity files live outside OS temporary storage so age-based
// cleanup cannot remove them. Absolute overrides only, 0700 mode, owned by the
// current effective UID, and never resolved through a symlink.
func secureRuntimeDir() (string, error) {
	if configured := os.Getenv("POCKETCTL_RUNTIME_DIR"); configured != "" {
		if !filepath.IsAbs(configured) {
			return "", fmt.Errorf("POCKETCTL_RUNTIME_DIR must be an absolute path, got %q", configured)
		}
		return ensurePrivateDir(configured)
	}
	home, err := config.HomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve daemon runtime home: %w", err)
	}
	if !filepath.IsAbs(home) {
		return "", fmt.Errorf("daemon runtime home must be absolute")
	}
	return ensurePrivateDir(filepath.Join(home, ".pocketctl", "run"))
}

// ensurePrivateDir guarantees dir is a real directory (no symlink anywhere at
// the final component), owned by the current euid, with mode 0700, creating it
// when missing. It never writes through a symlinked path.
func ensurePrivateDir(dir string) (string, error) {
	if info, err := os.Lstat(dir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("runtime dir %s is a symlink", dir)
		}
		if !info.IsDir() {
			return "", fmt.Errorf("runtime dir %s is not a directory", dir)
		}
		if err := verifyDirOwner(dir, info); err != nil {
			return "", err
		}
	} else if os.IsNotExist(err) {
		parent := filepath.Dir(dir)
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return "", fmt.Errorf("create runtime parent %s: %w", parent, err)
		}
		if err := os.Mkdir(dir, 0o700); err != nil {
			// Raced with a concurrent creator: re-validate what exists now.
			if info, statErr := os.Lstat(dir); statErr != nil {
				return "", fmt.Errorf("create runtime dir %s: %w", dir, err)
			} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return "", fmt.Errorf("runtime dir %s is not a plain directory", dir)
			}
		}
	} else {
		return "", fmt.Errorf("stat runtime dir %s: %w", dir, err)
	}

	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fmt.Errorf("chmod runtime dir %s: %w", dir, err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", fmt.Errorf("re-stat runtime dir %s: %w", dir, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", fmt.Errorf("runtime dir %s is not a plain directory", dir)
	}
	if err := verifyDirOwner(dir, info); err != nil {
		return "", err
	}
	return dir, nil
}

func verifyDirOwner(dir string, info os.FileInfo) error {
	if info.Mode().Perm()&0o077 != 0 {
		// Group/other bits may exist from an older shared layout; tightening
		// happens in ensurePrivateDir, but a foreign owner stays fatal below.
		_ = dir
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("runtime dir %s ownership cannot be verified", dir)
	}
	if stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("runtime dir %s is owned by uid %d, want current euid %d", dir, stat.Uid, os.Geteuid())
	}
	return nil
}

// OwnedByCurrentUser reports whether path is a plain (non-symlink) directory
// owned by the current effective user. Used by uninstall to decide whether a
// legacy shared runtime directory may be removed.
func OwnedByCurrentUser(path string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return stat.Uid == uint32(os.Geteuid())
}

func validateLegacyRuntimeDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("legacy runtime dir %s is not a plain directory", dir)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("legacy runtime dir %s is not owned by the current user", dir)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("legacy runtime dir %s is writable by group or others", dir)
	}
	return nil
}

// legacyRuntimeDirs includes the former per-user temp directory and the
// original shared location. Never create or change permissions while discovering
// legacy state; an unsafe directory must fail closed.
func legacyRuntimeDirs() ([]string, error) {
	if os.Getenv("POCKETCTL_RUNTIME_DIR") != "" {
		return nil, nil
	}
	var dirs []string
	for _, dir := range []string{filepath.Join(os.TempDir(), "pocketctl-"+strconv.Itoa(os.Getuid())), legacyDefaultRuntimeDir} {
		if err := validateLegacyRuntimeDir(dir); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		dirs = append(dirs, dir)
	}
	return dirs, nil
}

// Reserve the previous per-user location even on a fresh installation so an
// older binary using the same temp root cannot start alongside the new daemon.
func prepareLegacyRuntimeLockDir() error {
	if os.Getenv("POCKETCTL_RUNTIME_DIR") != "" {
		return nil
	}
	_, err := ensurePrivateDir(filepath.Join(os.TempDir(), "pocketctl-"+strconv.Itoa(os.Getuid())))
	return err
}
