//go:build unix

package session

import "golang.org/x/sys/unix"

func directoryAccess(path string) (browse, write bool) {
	browse = unix.Access(path, unix.R_OK|unix.X_OK) == nil
	return browse, browse && unix.Access(path, unix.W_OK|unix.X_OK) == nil
}
