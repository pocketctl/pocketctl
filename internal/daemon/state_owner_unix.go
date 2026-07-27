//go:build !windows

package daemon

import (
	"os"
	"syscall"
)

func stateFileOwnedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid())
}

func stateFileHasPrivatePermissions(info os.FileInfo) bool {
	return info.Mode().Perm() == 0o600
}
