// Package service installs and manages the pocketctl daemon as a native,
// OS-supervised service so it (a) starts at login/boot, (b) is automatically
// restarted if it crashes or is killed, and (c) on Linux survives logout.
//
// Platform backends:
//   - macOS: a per-user LaunchAgent (~/Library/LaunchAgents) with KeepAlive.
//   - Linux: a systemd user unit (~/.config/systemd/user) with Restart=always
//     and OOMScoreAdjust, plus a best-effort `loginctl enable-linger`.
//   - other: unsupported (returns ErrUnsupported).
//
// The supervised process runs `pocketctl daemon start --foreground` so the
// init system — not pocketctl's own self-fork — owns the process lifecycle.
package service

import (
	"errors"
	"time"
)

// Label is the reverse-DNS identifier used for the launchd job and the systemd
// unit base name. Kept stable so install/uninstall/status always agree.
const Label = "me.pocketctl.daemon"

// ErrUnsupported is returned by the service backend on platforms without a
// supported supervisor (e.g. plain Windows).
var ErrUnsupported = errors.New("native service management is not supported on this platform")

const statusQueryTimeout = 5 * time.Second

// Config describes how the supervised daemon should be launched.
type Config struct {
	// ExePath is the absolute path to the pocketctl binary.
	ExePath string
	// Args are the full argument vector passed after ExePath, e.g.
	// {"daemon", "start", "--foreground"} optionally followed by relay flags.
	Args []string
	// LogPath is where stdout/stderr of the supervised process are written.
	LogPath string
}

// Info is the result of Status. Installed describes only the on-disk unit;
// Loaded and Running come from a live supervisor query.
type Info struct {
	Installed    bool
	Loaded       bool
	Running      bool
	PID          int
	LastExitCode *int
	UnitPath     string
	Detail       string
}
