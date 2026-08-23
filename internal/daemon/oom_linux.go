//go:build linux

package daemon

import (
	"log/slog"
	"os"
	"strconv"
)

// defaultOOMScoreAdj is written to /proc/self/oom_score_adj on Linux. The valid
// range is [-1000, 1000]; lower values make the kernel OOM killer less likely
// to pick this process under memory pressure. We use -500 (strongly disfavored)
// rather than -1000 (fully exempt) on purpose: the daemon spawns claude/codex
// PTY children that inherit a HIGHER effective score, so under real memory
// pressure the kernel sacrifices a runaway child first while the supervising
// daemon survives — without making the daemon itself completely un-killable
// (which could wedge a low-memory box).
const defaultOOMScoreAdj = -500

// ProtectFromOOM lowers this process's OOM score so the Linux kernel OOM killer
// disfavors it relative to its PTY children. Best-effort: on failure (e.g.
// restricted /proc, container without write access) it logs at debug and
// returns nil — OOM protection is a hardening measure, never required for
// correctness. No-op on non-Linux builds (see oom_other.go).
//
// Note: oom_score_adj is NOT inherited as a protection — children reset toward
// 0 relative to the daemon, which is exactly what we want (children become the
// preferred OOM victims).
func ProtectFromOOM(logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	const path = "/proc/self/oom_score_adj"
	data := []byte(strconv.Itoa(defaultOOMScoreAdj))
	if err := os.WriteFile(path, data, 0644); err != nil {
		logger.Debug("could not set oom_score_adj (OOM protection skipped)",
			"path", path, "value", defaultOOMScoreAdj, "error", err)
		return nil
	}
	logger.Info("OOM protection enabled", "oom_score_adj", defaultOOMScoreAdj)
	return nil
}
