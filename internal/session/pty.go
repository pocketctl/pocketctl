package session

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/creack/pty"
)

// startPTYCli launches an interactive claude (or other CLI) under a PTY with a
// sanitized environment. Returns the PTY master (*os.File, used for stdin writes
// — write "<msg>\r" to submit) and the running *exec.Cmd.
//
// interactive-web-session D1 (PTY interactive) + D3 (env sanitization).
func startPTYCli(cliPath string, args []string, cwd string) (*os.File, *exec.Cmd, error) {
	cmd := exec.Command(cliPath, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = sanitizePTYEnv(os.Environ())

	// Start with a sane window size. Without this the PTY defaults to 0x0 and
	// claude's Ink-based TUI stalls rendering into a zero-size screen — startup
	// takes minutes and JSONL isn't written. (spike python inherited winsize
	// from the real terminal; creack/pty does not.)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		return nil, nil, fmt.Errorf("pty start: %w", err)
	}
	return ptmx, cmd, nil
}

// sanitizePTYEnv strips inherited CLAUDE_CODE_* markers (CLAUDE_CODE_CHILD_SESSION,
// CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT, …)
// so the spawned interactive claude does NOT detect a child-session context.
//
// Without this, claude runs ephemeral and skips JSONL persistence, breaking the
// JSONL output channel. Spike-verified (see proposal「技术验证」).
// ANTHROPIC_*, PATH, HOME and other vars are preserved.
func sanitizePTYEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		eq := strings.IndexByte(kv, '=')
		if eq < 0 {
			continue
		}
		key := kv[:eq]
		if strings.HasPrefix(key, "CLAUDE_CODE") || key == "CLAUDECODE" || key == "CLAUDE_EFFORT" {
			continue
		}
		out = append(out, kv)
	}
	return out
}
