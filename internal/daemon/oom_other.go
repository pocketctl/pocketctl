//go:build !linux

package daemon

import "log/slog"

// ProtectFromOOM is a no-op on non-Linux platforms. macOS uses jetsam (which
// isn't tunable via a simple /proc write, and rarely targets headless CLI
// processes), and Windows has no comparable per-process OOM-kill knob, so there
// is nothing to do here.
func ProtectFromOOM(_ *slog.Logger) error { return nil }
