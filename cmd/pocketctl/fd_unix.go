//go:build unix && !linux

package main

import (
	"io"
	"syscall"
)

// dupFileToFd redirects the OS-level file descriptor targetFd to point at the
// same open file as f. This is used so the daemonized process (whose fd 1/2
// inherited /dev/null) writes stdout/stderr — including Go runtime panic stack
// traces, which go through raw write(2) syscalls, not the os.Stderr variable —
// into the daemon log file. Best-effort: failures are silently ignored since
// losing this redirection only means a panic trace might not be captured; the
// primary defense is the recover handlers in internal/daemon/safego.go.
func dupFileToFd(f io.Writer, targetFd int) {
	type fdGetter interface{ Fd() uintptr }
	fg, ok := f.(fdGetter)
	if !ok {
		return
	}
	srcFd := int(fg.Fd())
	// dup2 makes targetFd refer to the same description as srcFd.
	if err := syscall.Dup2(srcFd, targetFd); err != nil {
		_ = err
	}
}
