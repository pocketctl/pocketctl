//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
)

// installSignalHandler registers the daemon's graceful-shutdown signals. Unix:
// SIGINT + SIGTERM. PR2: extracted from main.go to a build-tag split file so
// main.go no longer references syscall.SIGTERM (absent on Windows).
func installSignalHandler(sigCh chan<- os.Signal) {
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
}
