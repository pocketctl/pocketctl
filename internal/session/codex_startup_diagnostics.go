package session

import (
	"log/slog"
	"strings"
	"sync"
)

const codexStartupStderrLimit = 8 << 10

// Only retain stderr until initialize succeeds. Never attach these bytes to an
// error: runtimeProtocolError forwards errors to remote clients. Diagnostics use
// fixed categories, not regex-scrubbed child text, since arbitrary credentials,
// private paths and plugin output cannot be reliably recognized by a regex.
type codexStartupStderr struct {
	mu        sync.Mutex
	buf       []byte
	truncated bool
	stopped   bool
}

func (s *codexStartupStderr) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stopped {
		if s.buf == nil && len(p) > 0 {
			s.buf = make([]byte, 0, codexStartupStderrLimit)
		}
		n := min(len(p), codexStartupStderrLimit-len(s.buf))
		s.buf = append(s.buf, p[:n]...)
		s.truncated = s.truncated || n < len(p)
	}
	return len(p), nil
}

func (s *codexStartupStderr) finish(phase string, generation uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	s.stopped = true
	if phase != "" {
		slog.Default().Warn("Codex app-server startup failed",
			"phase", phase, "generation", generation,
			"stderr_bytes", len(s.buf), "stderr_truncated", s.truncated,
			"diagnosis", codexStartupDiagnosis(string(s.buf)))
	}
	clear(s.buf)
	s.buf = nil
}

// Fail closed: even unknown or partially captured output is never reproduced.
// These hints describe stderr evidence; they are not a definitive root cause.
func codexStartupDiagnosis(raw string) string {
	text := strings.ToLower(raw)
	switch {
	case strings.Contains(text, "codex_home points to") && strings.Contains(text, "does not exist"):
		return "codex_home_missing"
	case strings.Contains(text, "permission denied"), strings.Contains(text, "operation not permitted"):
		return "permission_denied"
	case strings.Contains(text, "address already in use"):
		return "address_in_use"
	case strings.Contains(text, "path must be shorter"), strings.Contains(text, "unix socket path too long"), strings.Contains(text, "path too long"):
		return "socket_path_too_long"
	case strings.Contains(text, "error loading config"), strings.Contains(text, "failed to load config"), strings.Contains(text, "error parsing config"):
		return "config_error"
	case strings.Contains(text, "unexpected argument"), strings.Contains(text, "unrecognized option"):
		return "unsupported_argument"
	case strings.TrimSpace(text) == "":
		return "stderr_empty"
	default:
		return "stderr_redacted"
	}
}
