package session

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
)

// resolveCwd resolves the working directory path:
// - "" or "~" → config.HomeDir()
// - "~/xxx" → join(home, "xxx")
// - other → as-is
func resolveCwd(cwd string) string {
	if cwd == "" || cwd == "~" {
		home, err := config.HomeDir()
		if err != nil {
			return cwd
		}
		return home
	}
	if strings.HasPrefix(cwd, "~/") {
		home, err := config.HomeDir()
		if err != nil {
			return cwd
		}
		return filepath.Join(home, cwd[2:])
	}
	return cwd
}

// normalizeCwd canonicalizes a path for use as a registry/lock key. It expands
// to an absolute path and resolves symlinks when possible, falling back to
// filepath.Clean so that "~/repo", "/Users/x/repo", and "/Users/x/./repo" all
// collapse to a single key.
//
// On Windows, a leading slash like "/repo" is preserved as-is so we do not
// accidentally materialize the current volume (for example "C:\\repo") and
// break protocol fixtures that use POSIX-style directories.
func normalizeCwd(p string) string {
	if strings.TrimSpace(p) == "" {
		return ""
	}
	if shouldPreserveRootedProtocolPath(runtime.GOOS, p, filepath.Separator) {
		return normalizeProtocolRootedPath(p, filepath.Separator)
	}

	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved
	}
	return filepath.Clean(abs)
}

func normalizeProtocolRootedPath(p string, separator uint8) string {
	return path.Clean(strings.ReplaceAll(p, string(separator), "/"))
}

func shouldPreserveRootedProtocolPath(goos, p string, separator uint8) bool {
	return goos == "windows" &&
		(strings.HasPrefix(p, "/") || strings.HasPrefix(p, string(separator)))
}

// registerCwd records (cwd, sessionID) in the cwd→sessions registry. Caller
// must NOT hold sm.mu; this method acquires it.
func (sm *SessionManager) registerCwd(sessionID, cwd string) {
	key := normalizeCwd(cwd)
	sm.mu.Lock()
	set, ok := sm.cwdSessions[key]
	if !ok {
		set = make(map[string]struct{})
		sm.cwdSessions[key] = set
	}
	set[sessionID] = struct{}{}
	sm.mu.Unlock()
}

// unregisterCwd removes sessionID from its cwd's session set under the given
// cwd. Safe to call multiple times. Caller must NOT hold sm.mu.
func (sm *SessionManager) unregisterCwd(sessionID, cwd string) {
	if cwd == "" {
		return
	}
	key := normalizeCwd(cwd)
	sm.mu.Lock()
	if set, ok := sm.cwdSessions[key]; ok {
		delete(set, sessionID)
		if len(set) == 0 {
			delete(sm.cwdSessions, key)
		}
	}
	sm.mu.Unlock()
}

// CwdSessionCount returns how many active sessions share the given cwd.
func (sm *SessionManager) CwdSessionCount(cwd string) int {
	key := normalizeCwd(cwd)
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.cwdSessions[key])
}

// validateCwd checks that the directory exists, is a directory, and is accessible.
func validateCwd(cwd string) error {
	info, err := os.Stat(cwd)
	if os.IsNotExist(err) {
		return fmt.Errorf("工作目录不存在: %s", cwd)
	}
	if err != nil {
		return fmt.Errorf("工作目录无法访问: %s (%w)", cwd, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("工作目录不是目录: %s", cwd)
	}
	// Test read access by opening the directory
	f, err := os.Open(cwd)
	if err != nil {
		return fmt.Errorf("工作目录无权限: %s", cwd)
	}
	f.Close()
	return nil
}
