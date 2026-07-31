//go:build linux

package main

import (
	"io"
	"syscall"
)

// dupFileToFd redirects the OS-level file descriptor targetFd to point at the
// same open file as f. Uses dup3 because linux/arm64 has no dup2 syscall.
func dupFileToFd(f io.Writer, targetFd int) {
	type fdGetter interface{ Fd() uintptr }
	fg, ok := f.(fdGetter)
	if !ok {
		return
	}
	srcFd := int(fg.Fd())
	if err := syscall.Dup3(srcFd, targetFd, 0); err != nil {
		_ = err
	}
}
