package daemon

import (
	"context"
	"log/slog"
	"runtime/debug"
	"time"
)

// This file provides goroutine supervision for the daemon's long-running event
// loops. The daemon daemonizes with stdin/stdout/stderr redirected to /dev/null
// (see cmdDaemonStart), so a panicking goroutine's runtime stack trace — which
// Go writes to stderr — is silently discarded. That turned a one-off panic in a
// single event handler into a permanent, invisible failure: the goroutine died,
// its event channel lost its consumer, the producer blocked, and the whole
// subsystem (e.g. Claude session discovery) froze forever with no log trace.
//
// Go wraps every `go f()` in its own recover scope that has no default handler,
// so a panic terminates only that one goroutine — the rest of the daemon keeps
// running, which is exactly why the failure is so hard to notice. These helpers
// add an explicit recover that (a) logs the panic + stack to the daemon log via
// slog, and (b) for long-running loops, restarts the goroutine after a backoff
// so a transient panic doesn't permanently disable a subsystem.

// maxRestartBackoff caps the restart delay for [RunLoop]. A panicking loop that
// can't make progress would otherwise restart in a tight loop; capping the
// backoff bounds CPU waste while still retrying.
const maxRestartBackoff = 30 * time.Second

// Go runs fn in a new goroutine with a panic recover. If fn panics, the panic
// value and full stack trace are logged (at ERROR) to logger under the given
// name, and the goroutine exits cleanly instead of dying silently. Use this for
// one-shot goroutines where a panic should be observable but not restartable.
//
//	logger may be nil; it falls back to slog.Default() (the daemon sets a
//	default logger early in startup, so package-level slog calls land in the
//	daemon log).
func Go(name string, logger *slog.Logger, fn func()) {
	go func() {
		defer recoverAndLog(name, logger)
		fn()
	}()
}

// RunLoop runs fn in a new goroutine that is automatically restarted if it
// returns or panics, until ctx is cancelled (fn must select on ctx.Done()).
// Use this for long-lived event loops (watcher/process/ws handlers) where a
// single transient panic must NOT permanently disable the subsystem.
//
// On panic the value + stack are logged and the loop restarts after a backoff
// that doubles (capped at maxRestartBackoff) on repeated failures. On a clean
// return the loop restarts immediately (short backoff) — a well-behaved loop
// only returns when ctx is done, so this is harmless.
func RunLoop(ctx context.Context, name string, logger *slog.Logger, fn func()) {
	go func() {
		backoff := time.Second
		for {
			func() {
				defer recoverAndLog(name, logger)
				fn()
			}()
			// Loop returned (clean or panicked). If the daemon is shutting down,
			// stop restarting.
			select {
			case <-ctx.Done():
				return
			default:
			}
			if logger == nil {
				logger = slog.Default()
			}
			logger.Warn("daemon loop restarting after exit/panic", "name", name, "backoff", backoff)
			time.Sleep(backoff)
			backoff *= 2
			if backoff > maxRestartBackoff {
				backoff = maxRestartBackoff
			}
		}
	}()
}

// recoverAndLog is the recover handler shared by Go and RunLoop. It logs the
// panic value and the full runtime stack (so the daemon log finally carries the
// failing call site — stderr is /dev/null in daemonized runs) and re-binds the
// recovered panic so the goroutine exits normally rather than crashing.
func recoverAndLog(name string, logger *slog.Logger) {
	r := recover()
	if r == nil {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	logger.Error("goroutine panic recovered",
		"name", name,
		"panic", r,
		"stack", string(debug.Stack()),
	)
}
