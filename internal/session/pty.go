package session

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/creack/pty"
)

// startPTYCli launches an interactive agent (claude, codex, …) under a PTY with
// a sanitized environment. extraEnv is appended after sanitization (e.g. the
// approval session id / socket path for non-bypass Claude sessions). agentType
// selects which inherited env markers to strip and ensures TERM is suitable for
// the agent's TUI. Returns the PTY master (*os.File, used for stdin writes —
// write "<msg>\r" to submit) and the running *exec.Cmd.
//
// interactive-web-session D1 (PTY interactive) + D3 (env sanitization).
func startPTYCli(cliPath string, args []string, cwd string, extraEnv []string, agentType string) (*os.File, *exec.Cmd, error) {
	cmd := exec.Command(cliPath, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	env := sanitizePTYEnv(os.Environ(), agentType)
	env = append(env, extraEnv...)
	// Ensure TERM is set to a value the agent's TUI accepts. Claude tolerates an
	// unset/dumb TERM, but codex's TUI refuses to start under TERM=dumb. Setting
	// xterm-256color is safe for both and matches what a real terminal provides.
	env = ensureTERM(env, "xterm-256color")
	cmd.Env = env

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

// sanitizePTYEnv strips inherited per-agent markers so the spawned interactive
// agent does NOT detect a child-session context.
//
// Claude: strips CLAUDE_CODE_* markers (CLAUDE_CODE_CHILD_SESSION, CLAUDECODE,
// CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT, …) so claude
// does NOT run ephemeral and skip JSONL persistence (spike-verified).
// Codex: strips CODEX_* child markers if any are introduced; CODEX_HOME is
// preserved so the rollout files land in the user's ~/.codex.
// ANTHROPIC_*, PATH, HOME and other vars are always preserved.
func sanitizePTYEnv(env []string, agentType string) []string {
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
		// Codex doesn't currently inject child markers into the env, but strip
		// any future CODEX_SESSION_* the way we do for claude, while keeping
		// CODEX_HOME (needed to locate ~/.codex).
		if strings.HasPrefix(key, "CODEX_SESSION") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// ensureTERM sets TERM to want if it's missing or "dumb", returning a new env
// slice. codex's TUI refuses to start under TERM=dumb.
func ensureTERM(env []string, want string) []string {
	out := make([]string, 0, len(env)+1)
	set := false
	for _, kv := range env {
		if strings.HasPrefix(kv, "TERM=") {
			val := kv[len("TERM="):]
			if val == "" || val == "dumb" {
				out = append(out, "TERM="+want)
			} else {
				out = append(out, kv)
			}
			set = true
			continue
		}
		out = append(out, kv)
	}
	if !set {
		out = append(out, "TERM="+want)
	}
	return out
}
