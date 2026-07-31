package main

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
)

// TestFanoutDispatchesToAll verifies a single log record reaches every child
// handler — the property --debug relies on to write JSON to the file AND text
// to the console simultaneously.
func TestFanoutDispatchesToAll(t *testing.T) {
	var fileBuf, consoleBuf bytes.Buffer
	h := fanoutHandler{handlers: []slog.Handler{
		slog.NewJSONHandler(&fileBuf, &slog.HandlerOptions{Level: slog.LevelDebug}),
		slog.NewTextHandler(&consoleBuf, &slog.HandlerOptions{Level: slog.LevelDebug}),
	}}
	logger := slog.New(h)

	logger.Debug("hello", "k", "v")

	if !strings.Contains(fileBuf.String(), `"msg":"hello"`) {
		t.Errorf("JSON handler missing record: %q", fileBuf.String())
	}
	if !strings.Contains(consoleBuf.String(), "msg=hello") {
		t.Errorf("text handler missing record: %q", consoleBuf.String())
	}
}

// TestFanoutRespectsPerHandlerLevel verifies each child applies its own level
// filter: a Debug record goes only to the Debug-level handler, not the
// Info-level one.
func TestFanoutRespectsPerHandlerLevel(t *testing.T) {
	var debugBuf, infoBuf bytes.Buffer
	h := fanoutHandler{handlers: []slog.Handler{
		slog.NewTextHandler(&debugBuf, &slog.HandlerOptions{Level: slog.LevelDebug}),
		slog.NewTextHandler(&infoBuf, &slog.HandlerOptions{Level: slog.LevelInfo}),
	}}

	if !h.Enabled(context.Background(), slog.LevelDebug) {
		t.Fatal("fanout should be enabled at Debug when any child is")
	}

	logger := slog.New(h)
	logger.Debug("only-debug")

	if !strings.Contains(debugBuf.String(), "only-debug") {
		t.Errorf("debug-level handler should have received the record: %q", debugBuf.String())
	}
	if strings.Contains(infoBuf.String(), "only-debug") {
		t.Errorf("info-level handler should NOT have received a Debug record: %q", infoBuf.String())
	}
}
