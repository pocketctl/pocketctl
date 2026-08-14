package agentcontrol

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/pocketctl/pocketctl/internal/claudechannel"
	appconfig "github.com/pocketctl/pocketctl/internal/config"
)

// ClaudeBootstrapResult is returned by the Claude-only Bootstrap function.
// When Bootstrap succeeds it yields the instance id, capability token and
// the Pocketctl-owned MCP config path the shim must hand to real Claude.
//
// All fields are opaque to the launcher itself; they are forwarded to the
// real Claude argv/env. The token MUST NOT be logged or written to disk.
type ClaudeBootstrapResult struct {
	InstanceID      string
	CapabilityToken string
	MCPConfigPath   string
	SocketPath      string
	// ExpiresAt is the bootstrap deadline by which the Channel process must
	// register with the daemon. Zero means "no explicit expiry"; the daemon
	// enforces its own 60s default.
	ExpiresAt time.Time
}

// ClaudeBootstrapFunc is the narrow, injectable bootstrap seam. The
// production implementation connects to the daemon-owned Claude Channel IPC
// socket. Tests replace it to exercise timeout and fallback behavior.
type ClaudeBootstrapFunc func(ctx context.Context) (ClaudeBootstrapResult, error)

// ErrClaudeBootstrapUnavailable is returned by the default Bootstrap seam.
// It signals "no daemon-owned Claude channel broker attached" and the
// launcher MUST fall back to native within the 200ms bootstrap budget.
var ErrClaudeBootstrapUnavailable = errors.New("claude channel bootstrap is not available")

// ErrClaudeChannelDisabled is returned when the rollout flag
// POCKETCTL_CLAUDE_CHANNEL_APPROVAL disables the feature. Native fallback
// still applies.
var ErrClaudeChannelDisabled = errors.New("claude channel approval is disabled by rollout flag")

// ClaudeLauncher is the entry point invoked when the user types `claude`
// through the Pocketctl-owned shim. It is NOT a RuntimeProvider: it does
// not register with the daemon's runtime socket, does not acquire a lease,
// and does not expose a managed runtime. It only optionally injects the
// Pocketctl Channel MCP config for the permission relay, and always execs
// the real Claude binary with stdin/stdout/stderr/cwd/signals preserved.
type ClaudeLauncher struct {
	// Bootstrap is the narrow seam that connects to the daemon's Claude-
	// channel broker. Defaults to claudeBootstrapUnavailable.
	Bootstrap ClaudeBootstrapFunc
	// BindChild updates a reservation to the real child PID on supervisor
	// platforms (Windows). Failure is diagnostic only; native Claude continues.
	BindChild func(context.Context, ClaudeBootstrapResult, int) error
	// ResolveBinary returns the real Claude binary path. Defaults to
	// resolveLauncherClaude (which reads the launcher config then falls back
	// to discovery, always excluding the Pocketctl shim).
	ResolveBinary func() (string, error)
	// Execute runs the prepared ExecSpec. Defaults to executeClaudeNative
	// which execs preserving stdio/cwd/exit.
	Execute func(ExecSpec) error
	// Environ returns the current environment. Defaults to os.Environ.
	Environ func() []string
	// Stderr is the diagnostic stream. Defaults to io.Discard.
	Stderr io.Writer
	// Timeout is the total bootstrap budget. Defaults to
	// DefaultLauncherTimeout (200ms). MUST NOT exceed it in production.
	Timeout time.Duration
	// Probe is the Claude Channel capability probe. Defaults to
	// ClaudeChannelProbe{}.
	Probe ClaudeChannelProbe
}

// NewClaudeLauncher builds the production launcher with daemon bootstrap,
// real-binary resolution, native exec, and a 200ms total enhancement budget.
func NewClaudeLauncher() ClaudeLauncher {
	return ClaudeLauncher{
		Bootstrap:     bootstrapClaudeChannel,
		BindChild:     bindClaudeChannelChild,
		ResolveBinary: resolveLauncherClaude,
		Execute:       executeClaudeNative,
		Environ:       os.Environ,
		Stderr:        io.Discard,
		Timeout:       DefaultLauncherTimeout,
		Probe:         ClaudeChannelProbe{},
	}
}

func bindClaudeChannelChild(ctx context.Context, result ClaudeBootstrapResult, pid int) error {
	client := claudechannel.NewClient(result.SocketPath, DefaultLauncherTimeout)
	return client.BindReservation(ctx, result.InstanceID, result.CapabilityToken, pid)
}

func bootstrapClaudeChannel(ctx context.Context) (ClaudeBootstrapResult, error) {
	socketPath := appconfig.ClaudeChannelSocketPath()
	if socketPath == "" {
		return ClaudeBootstrapResult{}, ErrClaudeBootstrapUnavailable
	}
	client := claudechannel.NewClient(socketPath, DefaultLauncherTimeout)
	boot, conn, _, err := client.Bootstrap(ctx, os.Getpid(), claudechannel.MCPProtocolVersion)
	if err != nil {
		return ClaudeBootstrapResult{}, err
	}
	_ = conn.Close()
	return ClaudeBootstrapResult{
		InstanceID: boot.InstanceID, CapabilityToken: boot.CapabilityToken,
		MCPConfigPath: boot.MCPConfigPath, SocketPath: socketPath, ExpiresAt: boot.ExpiresAt,
	}, nil
}

// claudeBootstrapUnavailable is the default Bootstrap implementation for
// Task 3. Every Claude launch falls back to native; the commit is fully
// functional and reversible.
func claudeBootstrapUnavailable(_ context.Context) (ClaudeBootstrapResult, error) {
	return ClaudeBootstrapResult{}, ErrClaudeBootstrapUnavailable
}

// Run executes the plan. The route is:
//  1. PlanClaude classifies argv.
//  2. LaunchNative: exec real Claude with NativeArgs unchanged.
//  3. LaunchChannel: probe version; if ineligible or org-disabled, native
//     fallback. Otherwise Bootstrap within Timeout; on any failure native
//     fallback. On success, prepend Channel flags + set token env, then exec.
//
// The terminal invariant (design §1.1) is preserved at every step: the real
// Claude native TUI remains the runtime authority, and no daemon/channel
// failure may block it.
func (l ClaudeLauncher) Run(ctx context.Context, args []string, cwd string) error {
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	plan := PlanClaude(args, cwd)
	l = l.withDefaults()

	if plan.Mode == LaunchNative {
		binary, err := l.ResolveBinary()
		if err != nil {
			return err
		}
		return l.Execute(ExecSpec{Path: binary, Args: plan.NativeArgs, Env: l.Environ(), Dir: plan.CWD})
	}

	// LaunchChannel: probe the resolved binary's version before anything else.
	binary, err := l.ResolveBinary()
	if err != nil {
		// Cannot resolve real Claude — there is nothing to fall back to.
		return err
	}

	// Rollout flag gate (design §Task 11). Default off in the first release;
	// explicit enable still must pass version/org/capability gates.
	if !claudeChannelRolloutEnabled() {
		fmt.Fprintf(l.Stderr, "pocketctl: Claude Channel approval is disabled; starting native Claude\n")
		return l.Execute(ExecSpec{Path: binary, Args: args, Env: l.Environ(), Dir: plan.CWD})
	}
	if !claudeChannelDevelopmentEnabled() {
		fmt.Fprintf(l.Stderr, "pocketctl: Claude development Channel is not enabled; starting native Claude\n")
		return l.Execute(ExecSpec{Path: binary, Args: args, Env: l.Environ(), Dir: plan.CWD})
	}

	// One total budget covers every optional enhancement step. Native binary
	// resolution happens before it because fallback also needs that path.
	enhanceCtx, cancel := context.WithTimeout(ctx, l.Timeout)
	defer cancel()
	version, versionErr := claudeBinaryVersion(enhanceCtx, binary, l.Probe)
	if versionErr != nil || !SupportsClaudeChannelVersion(version) {
		fmt.Fprintf(l.Stderr, "pocketctl: Claude version does not support channel relay; starting native Claude\n")
		return l.Execute(ExecSpec{Path: binary, Args: args, Env: l.Environ(), Dir: plan.CWD})
	}

	// Bootstrap within the strict 200ms budget. Any error → native fallback.
	result, err := l.Bootstrap(enhanceCtx)
	if err != nil {
		fmt.Fprintf(l.Stderr, "pocketctl: Claude Channel bootstrap unavailable; starting native Claude (%s)\n", oneLine(err.Error()))
		return l.Execute(ExecSpec{Path: binary, Args: args, Env: l.Environ(), Dir: plan.CWD})
	}

	// Inject: Channel flags PREPENDED to user args (Claude's argv parser
	// accepts MCP config before the prompt). Never overwrite a user-supplied
	// --mcp-config; if present, fall back native rather than clobbering.
	for _, arg := range args {
		if arg == "--mcp-config" || arg == "--channels" || arg == "--strict-mcp-config" ||
			len(arg) >= 11 && arg[:11] == "--mcp-config" {
			fmt.Fprintf(l.Stderr, "pocketctl: user --mcp-config/--channels present; starting native Claude\n")
			return l.Execute(ExecSpec{Path: binary, Args: args, Env: l.Environ(), Dir: plan.CWD})
		}
	}
	injected := claudeInjectChannelArgs(args, result)
	env := claudeInjectClaimEnv(l.Environ(), result)
	spec := ExecSpec{Path: binary, Args: injected, Env: env, Dir: plan.CWD}
	if l.BindChild != nil {
		spec.OnStart = func(pid int) error {
			bindCtx, bindCancel := context.WithTimeout(context.Background(), DefaultLauncherTimeout)
			defer bindCancel()
			if err := l.BindChild(bindCtx, result, pid); err != nil {
				fmt.Fprintf(l.Stderr, "pocketctl: Claude Channel child bind failed; native terminal remains active (%s)\n", oneLine(err.Error()))
			}
			return nil
		}
	}
	return l.Execute(spec)
}

func (l ClaudeLauncher) withDefaults() ClaudeLauncher {
	if l.Bootstrap == nil {
		l.Bootstrap = claudeBootstrapUnavailable
	}
	if l.ResolveBinary == nil {
		l.ResolveBinary = resolveLauncherClaude
	}
	if l.Execute == nil {
		l.Execute = executeClaudeNative
	}
	if l.Environ == nil {
		l.Environ = os.Environ
	}
	if l.Stderr == nil {
		l.Stderr = io.Discard
	}
	if l.Timeout <= 0 {
		l.Timeout = DefaultLauncherTimeout
	}
	return l
}

// claudeBinaryVersion runs the resolver's version probe using the launcher's
// ClaudeChannelProbe. The version string is parsed out of `claude --version`
// combined output.
func claudeBinaryVersion(ctx context.Context, binary string, probe ClaudeChannelProbe) (string, error) {
	// Tests and explicit callers may inject a bounded probe. Production shim
	// launches use the identity-bound value captured by `agent claude-code
	// enable`; they never spawn `claude --version` on the terminal hot path.
	if probe.Run == nil {
		if version, ok := cachedClaudeChannelVersion(binary); ok {
			return version, nil
		}
		return "", ErrClaudeChannelProbeFailed
	}
	probe = probe.withDefaultsIfTimeoutZero()
	out, err := probe.Run(ctx, binary, "--version")
	if err != nil {
		return "", err
	}
	return parseClaudeVersion(string(out)), nil
}

func cachedClaudeChannelVersion(binary string) (string, bool) {
	cfg, err := LoadConfig()
	if err != nil || cfg.Claude.State != StateEnabled || cfg.Claude.DetectedVersion == "" ||
		!SupportsClaudeChannelVersion(cfg.Claude.DetectedVersion) {
		return "", false
	}
	configured, err := os.Stat(cfg.Claude.RealBinary)
	if err != nil {
		return "", false
	}
	resolved, err := os.Stat(binary)
	if err != nil || !os.SameFile(configured, resolved) {
		return "", false
	}
	if cfg.Claude.BinarySize != resolved.Size() ||
		cfg.Claude.BinaryMTimeNS != resolved.ModTime().UnixNano() ||
		cfg.Claude.BinaryMode != uint32(resolved.Mode()) {
		return "", false
	}
	return cfg.Claude.DetectedVersion, true
}

// parseClaudeVersion extracts the first `N.N.N` sequence from Claude's
// --version output. Returns "" if none found.
func parseClaudeVersion(out string) string {
	return openCodeVersionRE.FindString(out)
}

// claudeInjectChannelArgs prepends the research-preview Channel flags to the
// user's argv. Design §3.3:
//
//	--mcp-config=~/.pocketctl/claude-channel/mcp.json
//	--dangerously-load-development-channels=server:pocketctl
//
// IMPORTANT: Claude 2.1.227's Commander.js parser treats `--mcp-config <path>`
// (space-separated) as a VARIADIC flag (`<configs...>`) that consumes every
// subsequent positional arg until the next `--flag`. This silently swallows
// the user's prompt. The equals form `--mcp-config=<path>` is non-variadic and
// safe. The same applies to `--dangerously-load-development-channels`.
//
// Do NOT add --strict-mcp-config, do NOT overwrite the user's --mcp-config.
// The development-channel startup confirmation is left to the user in the
// terminal; Pocketctl MUST NOT auto-accept it.
func claudeInjectChannelArgs(userArgs []string, result ClaudeBootstrapResult) []string {
	out := make([]string, 0, len(userArgs)+2)
	out = append(out, "--mcp-config="+result.MCPConfigPath)
	out = append(out, "--dangerously-load-development-channels=server:pocketctl")
	return append(out, userArgs...)
}

// claudeInjectClaimEnv passes the in-memory claim tuple to Claude and its
// Channel child. None of these values are persisted or logged.
func claudeInjectClaimEnv(env []string, result ClaudeBootstrapResult) []string {
	env = setEnv(env, "POCKETCTL_CLAUDE_CHANNEL_INSTANCE", result.InstanceID)
	env = setEnv(env, "POCKETCTL_CLAUDE_CHANNEL_TOKEN", result.CapabilityToken)
	return setEnv(env, "POCKETCTL_CLAUDE_CHANNEL_SOCKET", result.SocketPath)
}

// claudeChannelRolloutEnabled reports whether the Claude Channel approval
// feature is enabled via the rollout flag. Design §Task 11: default off in
// the first release; explicit enable still must pass version/org/capability
// gates.
func claudeChannelRolloutEnabled() bool {
	return envFlagEnabled("POCKETCTL_CLAUDE_CHANNEL_APPROVAL")
}

func claudeChannelDevelopmentEnabled() bool {
	return envFlagEnabled("POCKETCTL_CLAUDE_CHANNEL_DEVELOPMENT")
}

// envFlagEnabled parses a 0/1 boolean env flag.
func envFlagEnabled(name string) bool {
	v := os.Getenv(name)
	switch v {
	case "1", "true", "TRUE", "True", "yes", "on":
		return true
	default:
		return false
	}
}

// withDefaultsIfTimeoutZero ensures a probe has a timeout before its Run is
// invoked, without clobbering a caller-supplied timeout.
func (p ClaudeChannelProbe) withDefaultsIfTimeoutZero() ClaudeChannelProbe {
	if p.Timeout <= 0 {
		p.Timeout = defaultClaudeChannelProbeTimeout
	}
	if p.Run == nil {
		p.Run = func(ctx context.Context, binary string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, binary, args...).CombinedOutput()
		}
	}
	return p
}

// executeClaudeNative execs the real Claude binary preserving stdio, cwd and
// exit code. It reuses the OpenCode exec implementation since the contract
// is identical: the child replaces this process.
func executeClaudeNative(spec ExecSpec) error {
	return executeOpenCode(spec)
}

// resolveLauncherClaude reads the launcher config and falls back to
// discovery, always excluding the Pocketctl-owned claude shim path.
func resolveLauncherClaude() (string, error) {
	cfg, err := LoadConfig()
	if err == nil && cfg.Claude.RealBinary != "" {
		resolved, _, inspectErr := inspectExecutable(cfg.Claude.RealBinary)
		if inspectErr == nil && !sameResolvedPath(resolved, cfg.Claude.ShimPath) && !sameResolvedPath(resolved, defaultClaudeShimPath()) {
			return resolved, nil
		}
	}
	return ResolveClaudeExecutableFast()
}
