//go:build !windows

package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

const legacyDefaultRuntimeDir = "/tmp/pocketctl"

// secureRuntimeDir resolves or creates this user's private daemon runtime
// directory. H-6 invariants: per-UID default under the OS temp dir (never the
// shared /tmp/pocketctl), absolute overrides only, 0700 mode, owned by the
// current effective UID, and never resolved through a symlink.
func secureRuntimeDir() (string, error) {
	if configured := os.Getenv("POCKETCTL_RUNTIME_DIR"); configured != "" {
		if !filepath.IsAbs(configured) {
			return "", fmt.Errorf("POCKETCTL_RUNTIME_DIR must be an absolute path, got %q", configured)
		}
		return ensurePrivateDir(configured)
	}
	return ensurePrivateDir(filepath.Join(os.TempDir(), "pocketctl-"+strconv.Itoa(os.Getuid())))
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

func legacyRuntimeDirCandidate() (string, error) {
	if os.Getenv("POCKETCTL_RUNTIME_DIR") != "" {
		return "", nil
	}
	if err := validateLegacyRuntimeDir(legacyDefaultRuntimeDir); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return legacyDefaultRuntimeDir, nil
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
