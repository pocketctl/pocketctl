//go:build !windows

package discovery

import (
	"os"
	"syscall"
)

// fileOwnedByCurrentUser reports whether the file at path is owned by the
// current OS user. Used to decide if an agent binary is manageable (can be
// upgraded in place). Unix-only concept (uid).
func fileOwnedByCurrentUser(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}
