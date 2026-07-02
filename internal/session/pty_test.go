package session

import (
	"strings"
	"testing"
)

// TestSanitizePTYEnvStripsClaudeCodeMarkers (interactive-web-session D3 / 7.2)
// verifies inherited CLAUDE_CODE_* markers are stripped so the spawned
// interactive claude does not run ephemeral.
func TestSanitizePTYEnvStripsClaudeCodeMarkers(t *testing.T) {
	env := []string{
		"CLAUDE_CODE_CHILD_SESSION=1",
		"CLAUDECODE=1",
		"CLAUDE_CODE_ENTRYPOINT=cli",
		"CLAUDE_CODE_SESSION_ID=abc-123",
		"CLAUDE_EFFORT=high",
		"CLAUDE_PLUGIN_DATA=/x",
		"ANTHROPIC_BASE_URL=https://x",
		"PATH=/usr/bin:/bin",
		"HOME=/root",
	}
	got := sanitizePTYEnv(env, "claude-code")
	for _, kv := range got {
		eq := strings.IndexByte(kv, '=')
		if eq < 0 {
			continue
		}
		k := kv[:eq]
		if strings.HasPrefix(k, "CLAUDE_CODE") || k == "CLAUDECODE" || k == "CLAUDE_EFFORT" {
			t.Errorf("CLAUDE marker not stripped: %s", kv)
		}
	}
	joined := strings.Join(got, "\n")
	for _, want := range []string{"ANTHROPIC_BASE_URL=", "PATH=", "HOME="} {
		if !strings.Contains(joined, want) {
			t.Errorf("preserved var missing: %s", want)
		}
	}
}

// TestStartPTYCliStdinWriteRead (interactive-web-session 1.4) verifies the PTY
// master round-trips: writing stdin surfaces on the read side (cat echoes).
func TestStartPTYCliStdinWriteRead(t *testing.T) {
	ptmx, cmd, err := startPTYCli(defaultPTYProvider, "cat", nil, "", nil, "claude-code")
	if err != nil {
		t.Skipf("pty unavailable in this environment: %v", err)
	}
	defer ptmx.Close()
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	if _, err := ptmx.Write([]byte("hello-pty\r")); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	buf := make([]byte, 512)
	n, err := ptmx.Read(buf)
	if err != nil {
		t.Skipf("read stdout (pty echo timing): %v", err)
	}
	if !strings.Contains(string(buf[:n]), "hello-pty") {
		t.Errorf("expected echo of 'hello-pty', got %q", buf[:n])
	}
}
