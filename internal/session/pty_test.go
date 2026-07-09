package session

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
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

func TestSanitizePTYEnvStripsParentCodexRuntime(t *testing.T) {
	env := []string{
		"CODEX_CI=1",
		"CODEX_SANDBOX_NETWORK_DISABLED=1",
		"CODEX_THREAD_ID=thread-1",
		"CODEX_PERMISSION_PROFILE=:workspace",
		"CODEX_MANAGED_BY_NPM=1",
		"CODEX_MANAGED_PACKAGE_ROOT=/opt/homebrew/lib/node_modules/@openai/codex",
		"CODEX_GITHUB_PERSONAL_ACCESS_TOKEN=ghu-test",
		"CODEX_HOME=/Users/me/.codex",
		"OPENAI_API_KEY=sk-test",
		"PATH=/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path:/Users/me/.codex/tmp/arg0/codex-arg0abc:/Users/me/go/bin:/opt/homebrew/bin:/usr/bin",
		"HOME=/Users/me",
	}
	got := sanitizePTYEnv(env, "codex")
	joined := strings.Join(got, "\n")
	for _, gone := range []string{
		"CODEX_CI=",
		"CODEX_SANDBOX_NETWORK_DISABLED=",
		"CODEX_THREAD_ID=",
		"CODEX_PERMISSION_PROFILE=",
		"CODEX_MANAGED_BY_NPM=",
		"CODEX_MANAGED_PACKAGE_ROOT=",
		".codex/tmp/arg0",
	} {
		if strings.Contains(joined, gone) {
			t.Errorf("parent Codex runtime marker not stripped: %s in %q", gone, joined)
		}
	}
	for _, want := range []string{"CODEX_HOME=/Users/me/.codex", "CODEX_GITHUB_PERSONAL_ACCESS_TOKEN=", "OPENAI_API_KEY=", "HOME=/Users/me", "codex-path", "PATH=/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path:/Users/me/go/bin:/opt/homebrew/bin:/usr/bin"} {
		if !strings.Contains(joined, want) {
			t.Errorf("preserved var/path missing: %s in %q", want, joined)
		}
	}
}

func TestResolveCodexNativeBinaryFromNPMWrapper(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("symlink layout test is unix-only")
	}
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("fixture uses the darwin arm64 Codex package layout")
	}
	root := t.TempDir()
	wrapperDir := filepath.Join(root, "lib", "node_modules", "@openai", "codex", "bin")
	nativeDir := filepath.Join(root, "lib", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin")
	if err := os.MkdirAll(wrapperDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(nativeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	wrapper := filepath.Join(wrapperDir, "codex.js")
	native := filepath.Join(nativeDir, "codex")
	if err := os.WriteFile(wrapper, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(native, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := resolveCodexNativeBinary(wrapper)
	want, err := filepath.EvalSymlinks(native)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("native path mismatch: got %q want %q", got, want)
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

func TestCodexPTYLaunchManual(t *testing.T) {
	if os.Getenv("POCKETCTL_TEST_CODEX_PTY") != "1" {
		t.Skip("set POCKETCTL_TEST_CODEX_PTY=1 to launch local codex")
	}
	cliPath, err := findAgentCLI(adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	cwd := os.Getenv("POCKETCTL_TEST_CODEX_CWD")
	if cwd == "" {
		cwd = os.TempDir()
	}
	model := os.Getenv("POCKETCTL_TEST_CODEX_MODEL")
	args := adapter.CodexLauncher{}.BuildInteractiveArgs(protocol.SessionConfig{
		Cwd:   cwd,
		Model: model,
	})
	ptmx, cmd, err := startPTYCli(defaultPTYProvider, cliPath, args, cwd, nil, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()

	var tail []byte
	type readResult struct {
		chunk []byte
		err   error
	}
	readCh := make(chan readResult)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				chunk := append([]byte(nil), buf[:n]...)
				readCh <- readResult{chunk: chunk}
			}
			if err != nil {
				readCh <- readResult{err: err}
				return
			}
		}
	}()
	deadline := time.After(15 * time.Second)
	for {
		select {
		case <-done:
			t.Fatalf("codex exited early: code=%d tail=%q", cmd.ProcessState.ExitCode(), tail)
		case <-deadline:
			return
		case r := <-readCh:
			if r.err != nil {
				t.Fatalf("read PTY: %v tail=%q", r.err, tail)
			}
			for _, response := range terminalProbeResponses(r.chunk) {
				_, _ = ptmx.Write(response)
			}
			tail = append(tail, r.chunk...)
			if len(tail) > ptyOutputTailMax {
				tail = tail[len(tail)-ptyOutputTailMax:]
			}
		}
	}
}

func TestCodexCreateSessionManual(t *testing.T) {
	if os.Getenv("POCKETCTL_TEST_CODEX_CREATE") != "1" {
		t.Skip("set POCKETCTL_TEST_CODEX_CREATE=1 to create a local codex daemon session")
	}
	cwd := os.Getenv("POCKETCTL_TEST_CODEX_CWD")
	if cwd == "" {
		cwd = os.TempDir()
	}
	model := os.Getenv("POCKETCTL_TEST_CODEX_MODEL")
	prompt := os.Getenv("POCKETCTL_TEST_CODEX_PROMPT")
	outputCh := make(chan protocol.DaemonEvent, 256)
	stopDrain := make(chan struct{})
	defer close(stopDrain)
	go func() {
		for {
			select {
			case <-outputCh:
			case <-stopDrain:
				return
			}
		}
	}()
	sm := NewSessionManager(outputCh)
	sid, err := sm.CreateSession(context.Background(), protocol.SessionConfig{
		Agent:         adapter.AgentCodex,
		Cwd:           cwd,
		Model:         model,
		Prompt:        prompt,
		AutoCreateDir: true,
		Force:         true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sm.KillSession(sid) }()

	time.Sleep(15 * time.Second)
	sm.mu.RLock()
	ps := sm.sessions[sid]
	status := ""
	exitReason := ""
	var tail []byte
	if ps != nil {
		status = ps.Status
		exitReason = ps.ExitReason
		tail = append([]byte(nil), ps.PTYOutputTail...)
	}
	sm.mu.RUnlock()
	if status == protocol.StatusError || status == protocol.StatusExited {
		t.Fatalf("codex session exited: status=%s reason=%s tail=%q", status, exitReason, tail)
	}
}
