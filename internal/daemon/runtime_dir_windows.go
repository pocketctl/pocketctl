//go:build windows

package daemon

import (
	"fmt"
	"os"
	"path/filepath"
)

// secureRuntimeDir resolves or creates this user's private daemon runtime
// directory. Windows relies on the user-profile ACLs of the per-user cache
// directory instead of a world-shared temp path; no global "pocketctl"
// runtime name is used.
func secureRuntimeDir() (string, error) {
	if configured := os.Getenv("POCKETCTL_RUNTIME_DIR"); configured != "" {
		if !filepath.IsAbs(configured) {
			return "", fmt.Errorf("POCKETCTL_RUNTIME_DIR must be an absolute path, got %q", configured)
		}
		return ensurePrivateDir(configured)
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("resolve user cache dir: %w", err)
	}
	return ensurePrivateDir(filepath.Join(base, "pocketctl", "runtime"))
}

func ensurePrivateDir(dir string) (string, error) {
	if info, err := os.Lstat(dir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("runtime dir %s is a symlink", dir)
		}
		if !info.IsDir() {
			return "", fmt.Errorf("runtime dir %s is not a directory", dir)
		}
	} else if os.IsNotExist(err) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", fmt.Errorf("create runtime dir %s: %w", dir, err)
		}
	} else {
		return "", fmt.Errorf("stat runtime dir %s: %w", dir, err)
	}
	// Mode bits are advisory on Windows; the containing user-profile ACL is
	// the enforcement boundary. Keep the directory non-shareable regardless.
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fmt.Errorf("chmod runtime dir %s: %w", dir, err)
	}
	return dir, nil
}

// OwnedByCurrentUser on Windows trusts the per-user profile ACLs; there is no
// legacy shared runtime directory to guard.
func OwnedByCurrentUser(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}

func legacyRuntimeDirCandidate() (string, error) { return "", nil }
