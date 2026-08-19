//go:build !windows

package daemon

import (
	"os"
	"syscall"
	"testing"
)

func assertRuntimeDirOwner(t *testing.T, info os.FileInfo) {
	t.Helper()
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("runtime dir owner metadata is unavailable")
	}
	if stat.Uid != uint32(os.Geteuid()) {
		t.Fatalf("runtime dir owned by uid %d, want %d", stat.Uid, os.Geteuid())
	}
}
