//go:build windows

package main

import "io"

// dupFileToFd is a no-op on Windows. The primary panic defense is the recover
// handlers in internal/daemon/safego.go; this OS-level fd duplication is a
// best-effort secondary net for the daemonized child's raw-stderr runtime trace.
func dupFileToFd(_ io.Writer, _ int) {}
