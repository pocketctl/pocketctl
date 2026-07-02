//go:build windows

package main

import (
	"os"
	"os/signal"
)

// installSignalHandler on Windows: only os.Interrupt (Ctrl+C) is deliverable.
// A detached daemon has no console, so this is a placeholder — real Windows
// graceful stop uses the named-pipe control channel (PR4). Kept so main.go
// compiles cross-platform without syscall.SIGTERM.
func installSignalHandler(sigCh chan<- os.Signal) {
	signal.Notify(sigCh, os.Interrupt)
}
