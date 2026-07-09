package session

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// startPTYCli launches an interactive agent (claude, codex, …) under a PTY with
// a sanitized environment. extraEnv is appended after sanitization (e.g. the
// approval session id / socket path for non-bypass Claude sessions). agentType
// selects which inherited env markers to strip and ensures TERM is suitable for
// the agent's TUI. Returns the PTY master (*os.File, used for stdin writes —
// write "<msg>\r" to submit) and the running *exec.Cmd.
//
// interactive-web-session D1 (PTY interactive) + D3 (env sanitization).
func startPTYCli(provider platform.PTYProvider, cliPath string, args []string, cwd string, extraEnv []string, agentType string) (platform.PTY, *exec.Cmd, error) {
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
	if agentType == "codex" {
		env = ensureCodexTerminfo(env)
		env = ensureEnvDefault(env, "COLORTERM", "truecolor")
		env = ensureEnvDefault(env, "PAGER", "cat")
		env = ensureEnvDefault(env, "GIT_PAGER", "cat")
		env = ensureEnvDefault(env, "GH_PAGER", "cat")
		env = ensureEnvDefault(env, "TERM_PROGRAM", "pocketctl")
	}
	cmd.Env = env

	// PR2: PTY 启动走 platform.PTYProvider（Unix=creack/pty, Windows=stub），
	// 替代直接 pty.StartWithSize。env sanitize / TERM 仍是 session 业务逻辑。
	ptmx, err := provider.Start(cmd, &platform.Size{Rows: 24, Cols: 80})
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
// Codex: strips inherited CODEX_* runtime markers from the parent Codex process
// (CODEX_CI, sandbox flags, thread id, permission profile, npm shim metadata,
// etc.) while preserving user-configured CODEX_* values such as MCP token env
// vars. CODEX_HOME is preserved so rollout files land in the user's ~/.codex.
// It removes only Codex's temporary arg0 shim from PATH; Codex's bundled
// codex-path directory must stay because the native binary uses it for helper
// tools.
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
		if agentType == "codex" {
			if key == "PATH" {
				out = append(out, "PATH="+cleanCodexPath(kv[eq+1:]))
				continue
			}
			if isCodexRuntimeEnv(key) {
				continue
			}
		}
		out = append(out, kv)
	}
	return out
}

func isCodexRuntimeEnv(key string) bool {
	switch key {
	case "CODEX_CI",
		"CODEX_SANDBOX",
		"CODEX_SANDBOX_NETWORK_DISABLED",
		"CODEX_THREAD_ID",
		"CODEX_PERMISSION_PROFILE",
		"CODEX_MANAGED_BY_NPM",
		"CODEX_MANAGED_PACKAGE_ROOT":
		return true
	}
	return strings.HasPrefix(key, "CODEX_SANDBOX_") ||
		strings.HasPrefix(key, "CODEX_INTERNAL_") ||
		strings.HasPrefix(key, "CODEX_SESSION_")
}

func cleanCodexPath(pathValue string) string {
	parts := strings.Split(pathValue, ":")
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		if strings.Contains(p, "/.codex/tmp/arg0/") {
			continue
		}
		kept = append(kept, p)
	}
	return strings.Join(kept, ":")
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

func ensureCodexTerminfo(env []string) []string {
	for _, kv := range env {
		if strings.HasPrefix(kv, "TERMINFO_DIRS=") && strings.TrimSpace(kv[len("TERMINFO_DIRS="):]) != "" {
			return env
		}
	}
	dirs := []string{"/usr/share/terminfo"}
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat("/Applications/iTerm.app/Contents/Resources/terminfo"); err == nil {
			dirs = append([]string{"/Applications/iTerm.app/Contents/Resources/terminfo"}, dirs...)
		}
	}
	return append(env, "TERMINFO_DIRS="+strings.Join(dirs, ":"))
}

func ensureEnvDefault(env []string, key, value string) []string {
	prefix := key + "="
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			if strings.TrimSpace(kv[len(prefix):]) == "" {
				break
			}
			return env
		}
	}
	return append(env, prefix+value)
}
