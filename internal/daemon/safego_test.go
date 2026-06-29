package daemon

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// testLogger returns a slog logger writing to buf so tests can assert on output.
func testLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func TestGo_RecoversAndLogsPanic(t *testing.T) {
	var buf bytes.Buffer
	logger := testLogger(&buf)

	done := make(chan struct{})
	Go("panic-one-shot", logger, func() {
		panic("boom")
	})
	// Recover is in the same goroutine; give it a moment to run + log.
	go func() { time.Sleep(100 * time.Millisecond); close(done) }()
	<-done

	out := buf.String()
	if !strings.Contains(out, "goroutine panic recovered") {
		t.Fatalf("expected panic to be logged, got: %s", out)
	}
	if !strings.Contains(out, "boom") {
		t.Fatalf("expected panic value in log, got: %s", out)
	}
	if !strings.Contains(out, "stack") {
		t.Fatalf("expected stack trace in log, got: %s", out)
	}
	if !strings.Contains(out, "panic-one-shot") {
		t.Fatalf("expected goroutine name in log, got: %s", out)
	}
}

func TestGo_NilLogger_DoesNotPanic(t *testing.T) {
	// Temporarily point slog.Default() at a discard handler so the nil-logger
	// fallback doesn't dump the panic trace to the test's stderr.
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	defer slog.SetDefault(prev)

	done := make(chan struct{})
	Go("nil-logger", nil, func() {
		panic("ignored")
	})
	go func() { time.Sleep(100 * time.Millisecond); close(done) }()
	<-done
	// Reaching here without the test process panicking means the nil-logger
	// fallback to slog.Default() worked.
}

func TestGo_NoPanic_RunsCleanly(t *testing.T) {
	var buf bytes.Buffer
	ran := make(chan struct{}, 1)
	Go("clean", testLogger(&buf), func() {
		ran <- struct{}{}
	})
	select {
	case <-ran:
		// good
	case <-time.After(time.Second):
		t.Fatal("fn did not run")
	}
	if strings.Contains(buf.String(), "panic recovered") {
		t.Fatalf("should not have logged a panic: %s", buf.String())
	}
}

func TestRunLoop_RestartsAfterPanic(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var buf bytes.Buffer
	var calls atomic.Int32
	// fn panics on the first two invocations, then succeeds by waiting on ctx.
	RunLoop(ctx, "restart-test", testLogger(&buf), func() {
		n := calls.Add(1)
		if n <= 2 {
			panic("transient")
		}
		// On the 3rd call, block until ctx cancelled so the loop stays alive.
		<-ctx.Done()
	})

	// Wait until it has survived past the two panics (3rd invocation reached).
	// The loop backs off after each panic (1s then 2s), so reaching the 3rd
	// invocation takes ~3s; budget generously.
	deadline := time.After(8 * time.Second)
	for calls.Load() < 3 {
		select {
		case <-deadline:
			t.Fatalf("loop did not restart after panics; calls=%d log=%s", calls.Load(), buf.String())
		default:
			time.Sleep(20 * time.Millisecond)
		}
	}

	out := buf.String()
	if strings.Count(out, "goroutine panic recovered") < 2 {
		t.Fatalf("expected ≥2 panic recoveries logged, got: %s", out)
	}
}

func TestRunLoop_StopsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var buf bytes.Buffer

	// fn returns immediately each time (clean return), so the loop keeps
	// restarting until ctx is cancelled.
	RunLoop(ctx, "stop-test", testLogger(&buf), func() {})

	cancel()
	// Give the restart loop a moment to observe cancellation.
	time.Sleep(300 * time.Millisecond)

	// After cancel, the loop must stop trying to restart. We can't observe the
	// goroutine directly, but we can assert it didn't spin forever: sleep a bit
	// more and confirm no fresh "restarting" lines keep accumulating rapidly.
	before := strings.Count(buf.String(), "restarting")
	time.Sleep(500 * time.Millisecond)
	after := strings.Count(buf.String(), "restarting")
	// A bounded number of restarts may have been logged before cancellation
	// took effect; we only assert it doesn't grow unboundedly after cancel.
	if after-before > 5 {
		t.Fatalf("loop kept restarting after ctx cancel: before=%d after=%d", before, after)
	}
}

func TestRunLoop_NilLoggerFallback(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	RunLoop(ctx, "nil-fallback", nil, func() {
		<-ctx.Done()
	})
	// Should not panic with nil logger. cancelling exits cleanly.
}
