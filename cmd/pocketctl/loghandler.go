package main

import (
	"context"
	"log/slog"
)

// fanoutHandler dispatches every slog record to several underlying handlers.
// The daemon uses it in --debug mode to write structured JSON to daemon.log
// AND human-readable text to the console at the same time. Each child handler
// applies its own level filter, so handlers at different levels compose cleanly.
type fanoutHandler struct {
	handlers []slog.Handler
}

func (f fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range f.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (f fanoutHandler) Handle(ctx context.Context, r slog.Record) error {
	var firstErr error
	for _, h := range f.handlers {
		if !h.Enabled(ctx, r.Level) {
			continue
		}
		// Clone so each handler can mutate its own copy without affecting others.
		if err := h.Handle(ctx, r.Clone()); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (f fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		next[i] = h.WithAttrs(attrs)
	}
	return fanoutHandler{handlers: next}
}

func (f fanoutHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		next[i] = h.WithGroup(name)
	}
	return fanoutHandler{handlers: next}
}
