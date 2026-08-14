package agentcontrol

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/claudechannel"
	appconfig "github.com/pocketctl/pocketctl/internal/config"
)

// fakeClaudeExec captures the last ExecSpec the launcher would have run.
type fakeClaudeExec struct {
	last     ExecSpec
	execCall int
}

func (f *fakeClaudeExec) exec(spec ExecSpec) error {
	f.execCall++
	f.last = spec
	return nil
}

func newFakeClaudeLauncher(t *testing.T) (ClaudeLauncher, *fakeClaudeExec) {
	t.Helper()
	exec := &fakeClaudeExec{}
	return ClaudeLauncher{
		Bootstrap:     claudeBootstrapUnavailable,
		ResolveBinary: func() (string, error) { return "/real/claude", nil },
		Execute:       exec.exec,
		Environ:       func() []string { return os.Environ() },
		Stderr:        &strings.Builder{},
		Timeout:       DefaultLauncherTimeout,
	}, exec
}

// goodBootstrap returns a successful bootstrap result for channel-injection
// tests.
func goodBootstrap(_ context.Context) (ClaudeBootstrapResult, error) {
	return ClaudeBootstrapResult{
		InstanceID:      "inst-1",
		CapabilityToken: "tok-1",
		MCPConfigPath:   "/home/u/.pocketctl/claude-channel/mcp.json",
		SocketPath:      "/home/u/.pocketctl/claude-channel.sock",
	}, nil
}

func TestNewClaudeLauncherUsesDaemonChannelBootstrap(t *testing.T) {
	home, err := os.MkdirTemp("/private/tmp", "ccl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("HOME", home)
	socketPath := appconfig.ClaudeChannelSocketPath()
	mcpPath := filepath.Join(filepath.Dir(socketPath), "claude-channel", "mcp.json")
	srv := claudechannel.NewServer(socketPath, mcpPath, nil)
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	launcher := NewClaudeLauncher()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := launcher.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.InstanceID == "" || result.CapabilityToken == "" {
		t.Fatalf("missing claim credentials: %+v", result)
	}
	if result.SocketPath != socketPath || result.MCPConfigPath != mcpPath {
		t.Fatalf("bootstrap paths=%+v", result)
	}
}

func TestClaudeLauncherProductionVersionGateUsesEnabledBinaryIdentityCache(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	binary := testExecutable(t, "cached-claude")
	info, err := os.Stat(binary)
	if err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	cfg.Claude = AgentConfig{
		State: StateEnabled, RealBinary: binary, DetectedVersion: MinimumClaudeChannelVersion,
		BinarySize: info.Size(), BinaryMTimeNS: info.ModTime().UnixNano(), BinaryMode: uint32(info.Mode()),
	}
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	version, err := claudeBinaryVersion(context.Background(), binary, ClaudeChannelProbe{})
	if err != nil || version != MinimumClaudeChannelVersion {
		t.Fatalf("cached version=(%q, %v)", version, err)
	}
	if err := os.Chtimes(binary, time.Now().Add(time.Second), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := claudeBinaryVersion(context.Background(), binary, ClaudeChannelProbe{}); !errors.Is(err, ErrClaudeChannelProbeFailed) {
		t.Fatalf("changed binary identity must fail closed, got %v", err)
	}
}

func TestResolveLauncherClaudeFallbackNeverExecutesCandidate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	binDir := t.TempDir()
	marker := filepath.Join(t.TempDir(), "executed")
	binary := filepath.Join(binDir, "claude")
	body := []byte("#!/bin/sh\ntouch '" + marker + "'\n")
	if err := os.WriteFile(binary, body, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	resolved, err := resolveLauncherClaude()
	if err != nil {
		t.Fatal(err)
	}
	if !sameResolvedPath(resolved, binary) {
		t.Fatalf("resolved=%q want %q", resolved, binary)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("launcher discovery executed Claude candidate: %v", err)
	}
}

// enableRollout temporarily sets the rollout flag for the duration of t.
func enableRollout(t *testing.T) {
	t.Helper()
	t.Setenv("POCKETCTL_CLAUDE_CHANNEL_APPROVAL", "1")
	t.Setenv("POCKETCTL_CLAUDE_CHANNEL_DEVELOPMENT", "1")
}

// TestClaudeLauncherNativeCommandsDontProbe verifies every native-only argv
// shape execs the real binary with NO probe, NO bootstrap, NO injection.
// The bootstrap function would fatal the test if called. Design §3.3/Task 3.
func TestClaudeLauncherNativeCommandsDontProbe(t *testing.T) {
	nativeArgs := [][]string{
		{"--native"},
		{"--native", "--resume", "X"},
		{"--help"},
		{"-h"},
		{"--version"},
		{"-v"},
		{"-p", "thing"},
		{"--print", "thing"},
		{"--bare"},
		{"--safe-mode"},
		{"--dangerously-skip-permissions"},
		{"--permission-mode", "bypassPermissions"},
		{"--permission-mode=bypassPermissions"},
		{"mcp"},
		{"auth"},
		{"doctor"},
	}
	for _, args := range nativeArgs {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			launcher, exec := newFakeClaudeLauncher(t)
			launcher.Bootstrap = func(_ context.Context) (ClaudeBootstrapResult, error) {
				t.Fatal("Bootstrap must not be called for native-only argv")
				return ClaudeBootstrapResult{}, nil
			}
			if err := launcher.Run(context.Background(), args, "/repo"); err != nil {
				t.Fatal(err)
			}
			if exec.last.Path != "/real/claude" {
				t.Fatalf("exec path=%q want /real/claude", exec.last.Path)
			}
			if exec.last.Dir != "/repo" {
				t.Fatalf("cwd=%q want /repo", exec.last.Dir)
			}
			// Injected args MUST be absent.
			for _, arg := range exec.last.Args {
				if arg == "--dangerously-load-development-channels" || arg == "--mcp-config" {
					t.Fatalf("native argv must not be injected: %v", exec.last.Args)
				}
			}
			for _, env := range exec.last.Env {
				if strings.HasPrefix(env, "POCKETCTL_CLAUDE_CHANNEL_TOKEN=") {
					t.Fatalf("native argv must not carry capability token env: %v", exec.last.Env)
				}
			}
		})
	}
}

// TestClaudeLauncherNativeEscapeStripsOnlyNativeFlag verifies
// `claude --native --resume X` execs the real binary with `--resume X`
// verbatim. Design §Task 3.
func TestClaudeLauncherNativeEscapeStripsOnlyNativeFlag(t *testing.T) {
	launcher, exec := newFakeClaudeLauncher(t)
	if err := launcher.Run(context.Background(), []string{"--native", "--resume", "X"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if exec.last.Path != "/real/claude" {
		t.Fatalf("path=%q", exec.last.Path)
	}
	wantArgs := []string{"--resume", "X"}
	if !equalStringSlicesAgent(exec.last.Args, wantArgs) {
		t.Fatalf("args=%v want %v", exec.last.Args, wantArgs)
	}
}

// TestClaudeLauncherChannelEligibleInjectsWhenBootstrapSucceeds verifies the
// happy path: channel-eligible argv + rollout on + version OK + bootstrap
// success → real Claude argv gets the MCP config and dev channel flags
// PREPENDED, and the token lands in env. Design §Task 3.
func TestClaudeLauncherChannelEligibleInjectsWhenBootstrapSucceeds(t *testing.T) {
	enableRollout(t)
	tests := [][]string{
		nil,                              // interactive new
		{"fix the bug"},                  // prompt
		{"--continue"},                   // continue
		{"--resume", "abc"},              // resume id
		{"--permission-mode", "default"}, // non-bypass permission mode
	}
	for _, args := range tests {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			launcher, exec := newFakeClaudeLauncher(t)
			launcher.Bootstrap = goodBootstrap
			launcher.Probe = ClaudeChannelProbe{
				Timeout: 2 * time.Second,
				Run: func(_ context.Context, _ string, a ...string) ([]byte, error) {
					if len(a) == 1 && a[0] == "--version" {
						return []byte("claude code 2.1.211\n--channels\n--dangerously-load-development-channels\n--mcp-config\n"), nil
					}
					return nil, nil
				},
			}
			if err := launcher.Run(context.Background(), args, "/repo"); err != nil {
				t.Fatal(err)
			}
			if exec.last.Path != "/real/claude" {
				t.Fatalf("path=%q", exec.last.Path)
			}
			// First two args are the equals-form MCP config injection.
			// Claude 2.1.227's Commander.js parser treats space-separated
			// --mcp-config as variadic, swallowing the prompt; the equals
			// form is non-variadic and safe.
			if len(exec.last.Args) < 2 ||
				exec.last.Args[0] != "--mcp-config=/home/u/.pocketctl/claude-channel/mcp.json" ||
				exec.last.Args[1] != "--dangerously-load-development-channels=server:pocketctl" {
				t.Fatalf("missing channel injection prefix: %v", exec.last.Args)
			}
			// User args follow verbatim.
			user := exec.last.Args[2:]
			if !equalStringSlicesAgent(user, args) {
				t.Fatalf("user args changed: got=%v want=%v", user, args)
			}
			wantEnv := map[string]bool{
				"POCKETCTL_CLAUDE_CHANNEL_INSTANCE=inst-1":                               false,
				"POCKETCTL_CLAUDE_CHANNEL_TOKEN=tok-1":                                   false,
				"POCKETCTL_CLAUDE_CHANNEL_SOCKET=/home/u/.pocketctl/claude-channel.sock": false,
			}
			for _, env := range exec.last.Env {
				if _, ok := wantEnv[env]; ok {
					wantEnv[env] = true
				}
			}
			for key, found := range wantEnv {
				if !found {
					t.Fatalf("claim env %q not set: %v", key, exec.last.Env)
				}
			}
		})
	}
}

func TestClaudeLauncherBindsSupervisorChildWithoutBlockingNativeClaude(t *testing.T) {
	enableRollout(t)
	launcher, _ := newFakeClaudeLauncher(t)
	launcher.Bootstrap = goodBootstrap
	launcher.Probe = ClaudeChannelProbe{Run: func(context.Context, string, ...string) ([]byte, error) {
		return []byte("claude code 2.1.211"), nil
	}}
	boundPID := 0
	launcher.BindChild = func(_ context.Context, result ClaudeBootstrapResult, pid int) error {
		if result.InstanceID != "inst-1" {
			t.Fatalf("bind result=%+v", result)
		}
		boundPID = pid
		return errors.New("daemon restarted")
	}
	launcher.Execute = func(spec ExecSpec) error {
		if spec.OnStart == nil {
			t.Fatal("Channel launch did not install child PID binder")
		}
		return spec.OnStart(4242)
	}
	if err := launcher.Run(context.Background(), nil, "/repo"); err != nil {
		t.Fatalf("bind failure must not stop native Claude: %v", err)
	}
	if boundPID != 4242 {
		t.Fatalf("bound pid=%d want 4242", boundPID)
	}
}

// TestClaudeLauncherBootstrapUnavailableFallsBackNative verifies the Task 3
// default: with the unavailable Bootstrap, every channel-eligible argv execs
// real Claude with NO injection, NO probe (well, version probe still runs to
// gate, but no Channel injection). Design §Task 3: "生产默认实现只返回
// unavailable;Task 6 再把它接到 Task 5 的 Claude-only client".
func TestClaudeLauncherBootstrapUnavailableFallsBackNative(t *testing.T) {
	enableRollout(t)
	launcher, exec := newFakeClaudeLauncher(t)
	// Default Bootstrap is claudeBootstrapUnavailable.
	launcher.Probe = ClaudeChannelProbe{
		Timeout: 2 * time.Second,
		Run: func(_ context.Context, _ string, a ...string) ([]byte, error) {
			return []byte("claude code 2.1.211\n--channels\n"), nil
		},
	}
	if err := launcher.Run(context.Background(), []string{"fix"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if exec.last.Path != "/real/claude" {
		t.Fatalf("path=%q", exec.last.Path)
	}
	for _, arg := range exec.last.Args {
		if arg == "--dangerously-load-development-channels" || arg == "--mcp-config" {
			t.Fatalf("unavailable bootstrap must not inject: %v", exec.last.Args)
		}
	}
}

// TestClaudeLauncherBootstrapTimeoutWithin200ms verifies the strict 200ms
// budget. A Bootstrap that sleeps longer must be canceled and fall back
// native. Design §1.1.3: "daemon 无法连接时必须在 200ms 内回退原生 Claude".
func TestClaudeLauncherBootstrapTimeoutWithin200ms(t *testing.T) {
	enableRollout(t)
	launcher, exec := newFakeClaudeLauncher(t)
	launcher.Timeout = 50 * time.Millisecond
	launcher.Bootstrap = func(ctx context.Context) (ClaudeBootstrapResult, error) {
		<-ctx.Done()
		return ClaudeBootstrapResult{}, ctx.Err()
	}
	launcher.Probe = ClaudeChannelProbe{
		Timeout: 2 * time.Second,
		Run: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return []byte("claude code 2.1.211\n--channels\n"), nil
		},
	}
	start := time.Now()
	if err := launcher.Run(context.Background(), []string{"fix"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(start)
	if elapsed > 500*time.Millisecond {
		t.Fatalf("bootstrap did not respect 200ms-class budget: elapsed=%v", elapsed)
	}
	if exec.last.Path != "/real/claude" {
		t.Fatalf("path=%q", exec.last.Path)
	}
	for _, arg := range exec.last.Args {
		if arg == "--dangerously-load-development-channels" {
			t.Fatalf("timeout must fall back native without injection: %v", exec.last.Args)
		}
	}
}

func TestClaudeLauncherTotalEnhancementBudgetIncludesVersionProbe(t *testing.T) {
	enableRollout(t)
	launcher, exec := newFakeClaudeLauncher(t)
	launcher.Timeout = 50 * time.Millisecond
	launcher.Probe = ClaudeChannelProbe{
		Run: func(ctx context.Context, _ string, _ ...string) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	launcher.Bootstrap = func(context.Context) (ClaudeBootstrapResult, error) {
		t.Fatal("bootstrap must not run after the total budget expires in probe")
		return ClaudeBootstrapResult{}, nil
	}
	start := time.Now()
	if err := launcher.Run(context.Background(), []string{"fix"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
		t.Fatalf("enhancement path exceeded terminal fallback budget: %v", elapsed)
	}
	if !equalStringSlicesAgent(exec.last.Args, []string{"fix"}) {
		t.Fatalf("fallback mutated argv: %v", exec.last.Args)
	}
}

// TestClaudeLauncherIncompatibleVersionFallsBackNative verifies a version
// below MinimumClaudeChannelVersion skips injection. Design §3.4/Task 3.
func TestClaudeLauncherIncompatibleVersionFallsBackNative(t *testing.T) {
	enableRollout(t)
	launcher, exec := newFakeClaudeLauncher(t)
	launcher.Bootstrap = func(_ context.Context) (ClaudeBootstrapResult, error) {
		t.Fatal("Bootstrap must not be called when version is below minimum")
		return ClaudeBootstrapResult{}, nil
	}
	launcher.Probe = ClaudeChannelProbe{
		Timeout: 2 * time.Second,
		Run: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return []byte("claude code 2.1.210\n"), nil
		},
	}
	if err := launcher.Run(context.Background(), []string{"fix"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	for _, arg := range exec.last.Args {
		if arg == "--dangerously-load-development-channels" {
			t.Fatalf("incompatible version must not inject: %v", exec.last.Args)
		}
	}
}

// TestClaudeLauncherRolloutOffFallsBackNative verifies the default-off
// rollout gate (design §Task 11).
func TestClaudeLauncherRolloutOffFallsBackNative(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_CHANNEL_APPROVAL", "0")
	launcher, exec := newFakeClaudeLauncher(t)
	launcher.Bootstrap = func(_ context.Context) (ClaudeBootstrapResult, error) {
		t.Fatal("Bootstrap must not be called when rollout is off")
		return ClaudeBootstrapResult{}, nil
	}
	if err := launcher.Run(context.Background(), []string{"fix"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	for _, arg := range exec.last.Args {
		if arg == "--dangerously-load-development-channels" {
			t.Fatalf("rollout off must not inject: %v", exec.last.Args)
		}
	}
}

func TestClaudeLauncherDevelopmentChannelFlagOffFallsBackNative(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_CHANNEL_APPROVAL", "1")
	t.Setenv("POCKETCTL_CLAUDE_CHANNEL_DEVELOPMENT", "0")
	launcher, exec := newFakeClaudeLauncher(t)
	launcher.Bootstrap = func(_ context.Context) (ClaudeBootstrapResult, error) {
		t.Fatal("Bootstrap must not run when the development Channel gate is off")
		return ClaudeBootstrapResult{}, nil
	}
	if err := launcher.Run(context.Background(), []string{"fix"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if !equalStringSlicesAgent(exec.last.Args, []string{"fix"}) {
		t.Fatalf("development gate fallback mutated argv: %v", exec.last.Args)
	}
}

// TestClaudeLauncherPreservesUserMCPConfig verifies that if the user already
// passes --mcp-config, --channels, or --strict-mcp-config, the launcher does
// NOT inject and falls back native to avoid clobbering. Design §3.3.
func TestClaudeLauncherPreservesUserMCPConfig(t *testing.T) {
	enableRollout(t)
	tests := [][]string{
		{"--mcp-config", "/user/mcp.json", "prompt"},
		{"--strict-mcp-config", "prompt"},
		{"--channels", "plugin:other@1", "prompt"},
		{"--mcp-config=/user/mcp.json", "prompt"},
	}
	for _, args := range tests {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			launcher, exec := newFakeClaudeLauncher(t)
			launcher.Bootstrap = goodBootstrap
			launcher.Probe = ClaudeChannelProbe{
				Timeout: 2 * time.Second,
				Run: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
					return []byte("claude code 2.1.211\n--channels\n"), nil
				},
			}
			if err := launcher.Run(context.Background(), args, "/repo"); err != nil {
				t.Fatal(err)
			}
			for _, arg := range exec.last.Args {
				if arg == "--dangerously-load-development-channels" {
					t.Fatalf("user MCP config must suppress injection: args=%v", exec.last.Args)
				}
			}
			// Real binary, user args verbatim.
			if exec.last.Path != "/real/claude" {
				t.Fatalf("path=%q", exec.last.Path)
			}
			if !equalStringSlicesAgent(exec.last.Args, args) {
				t.Fatalf("user args mutated: got=%v want=%v", exec.last.Args, args)
			}
		})
	}
}

// TestClaudeLauncherPreservesEnvCwdAndExitCode verifies the launcher passes
// the process environment, cwd and exit code through unchanged on native
// fallback. Design §Task 3: "fallback argv/env/cwd/stdin/stdout/stderr/退出
// 码不变".
func TestClaudeLauncherPreservesEnvCwdAndExitCode(t *testing.T) {
	customEnv := []string{"FOO=bar", "PATH=/usr/bin"}
	launcher := ClaudeLauncher{
		Bootstrap:     claudeBootstrapUnavailable,
		ResolveBinary: func() (string, error) { return "/real/claude", nil },
		Execute: func(spec ExecSpec) error {
			if spec.Dir != "/work" {
				t.Fatalf("cwd=%q want /work", spec.Dir)
			}
			if len(spec.Env) != 2 || spec.Env[0] != "FOO=bar" || spec.Env[1] != "PATH=/usr/bin" {
				t.Fatalf("env=%v want custom env", spec.Env)
			}
			return nil
		},
		Environ: func() []string { return customEnv },
		Stderr:  &strings.Builder{},
		Timeout: DefaultLauncherTimeout,
	}
	if err := launcher.Run(context.Background(), []string{"--native"}, "/work"); err != nil {
		t.Fatal(err)
	}
}

// TestClaudeLauncherExecutePassesExitCode verifies that an exec failure
// surfaces the underlying exit code (used by main to preserve Claude's
// exit status). We emulate via a fake exec returning a sentinel error.
func TestClaudeLauncherExecutePassesExitCode(t *testing.T) {
	sentinel := errors.New("exit status 42")
	launcher := ClaudeLauncher{
		Bootstrap:     claudeBootstrapUnavailable,
		ResolveBinary: func() (string, error) { return "/real/claude", nil },
		Execute:       func(ExecSpec) error { return sentinel },
		Environ:       func() []string { return nil },
		Stderr:        &strings.Builder{},
		Timeout:       DefaultLauncherTimeout,
	}
	if err := launcher.Run(context.Background(), nil, "/repo"); err != sentinel {
		t.Fatalf("error=%v want sentinel", err)
	}
}

func equalStringSlicesAgent(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
