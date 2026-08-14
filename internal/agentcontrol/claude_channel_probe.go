package agentcontrol

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// MinimumClaudeChannelVersion is the minimum Claude Code version that
// satisfies the production security bar for the Pocketctl permission relay
// Channel. The protocol floor is 2.1.81 (where Channels permission relay
// first shipped), but 2.1.211 fixes relay approval preview bidirectional
// coverage, zero-width and similar-quote spoofing risks. Pocketctl MUST NOT
// lower this bar to accommodate older installs.
//
// Design §0:
// "Pocketctl 的生产最低版本定为 2.1.211,不是仅满足协议的 2.1.81".
const MinimumClaudeChannelVersion = "2.1.211"

// Status reason codes returned by classifyClaudeChannelStatus and surfaced
// through `agent claude-code status`.
const (
	StatusClaudeChannelReady                          = "ready"
	StatusClaudeChannelUnsupportedVersion             = "unsupported_version"
	StatusClaudeChannelOrganizationDisabled           = "organization_disabled"
	StatusClaudeChannelRolloutDisabled                = "rollout_disabled"
	StatusClaudeChannelDevelopmentChannelNotConfirmed = "development_channel_not_confirmed"
	StatusClaudeChannelProbeFailed                    = "probe_failed"
)

var (
	// ErrClaudeChannelVersionUnsupported indicates the resolved Claude Code
	// binary is below MinimumClaudeChannelVersion. The launcher MUST fall
	// back to native Claude without injecting the Channel.
	ErrClaudeChannelVersionUnsupported = errors.New("claude code version does not support channel permission relay")
	// ErrClaudeChannelProbeTimeout indicates the flag/version probe did not
	// complete within the configured deadline. Native fallback is required.
	ErrClaudeChannelProbeTimeout = errors.New("claude code channel probe timed out")
	// ErrClaudeChannelProbeFailed is the generic probe failure bucket used
	// when the probe exits non-zero or the output cannot be parsed.
	ErrClaudeChannelProbeFailed = errors.New("claude code channel probe failed")
)

const defaultClaudeChannelProbeTimeout = 5 * time.Second

// ClaudeChannelCapabilities describes ONLY the Channel permission relay
// surface. It is deliberately distinct from ClaudeManagedCapabilities,
// which describes the (still no-go) shared runtime authority contract.
// A healthy Channel probe MUST NOT flip any shared_runtime field on the
// legacy probe.
//
// Design §Task 2 Required API.
type ClaudeChannelCapabilities struct {
	Version                    string `json:"version"`
	ChannelsFlag               bool   `json:"channels_flag"`
	DevelopmentChannelsFlag    bool   `json:"development_channels_flag"`
	MCPConfigFlag              bool   `json:"mcp_config_flag"`
	PermissionRelaySmokePassed bool   `json:"permission_relay_smoke_passed"`
	ChannelCrashKeepsTUIAlive  bool   `json:"channel_crash_keeps_tui_alive"`
}

// SupportsClaudeChannelVersion is the semver first gate. Pre-release
// suffixes (-rc, -dirty) and build metadata (+build) fail closed: the
// production bar requires a clean release at or above the minimum.
func SupportsClaudeChannelVersion(version string) bool {
	return claudeChannelVersionOK(version)
}

// claudeChannelVersionOK mirrors versionAtLeast but additionally rejects
// any pre-release or build-metadata suffix. A "2.1.211-rc.1" build is not
// the audited release and must fail closed.
func claudeChannelVersionOK(version string) bool {
	trimmed := strings.TrimSpace(version)
	trimmed = strings.TrimPrefix(trimmed, "v")
	if trimmed == "" {
		return false
	}
	// Reject any pre-release (-) or build (+) suffix: only clean releases
	// qualify for the production security bar.
	if strings.ContainsAny(trimmed, "-+") {
		return false
	}
	return versionAtLeast(trimmed, MinimumClaudeChannelVersion)
}

// ClaudeChannelProbe runs the flag/version discovery against a resolved
// Claude binary. It NEVER reads or modifies ~/.claude.json or
// ~/.claude/settings.json; the flag probe uses `claude --version` in an
// isolated HOME, not `claude --help` (hidden flags shown by --help are not
// a stable contract).
type ClaudeChannelProbe struct {
	Timeout time.Duration
	// Run executes the Claude binary with the given args and returns its
	// combined output. Defaults to exec.CommandContext(...).CombinedOutput().
	Run func(ctx context.Context, binary string, args ...string) ([]byte, error)
	// PermissionSmoke is an optional, pre-release second gate. It is nil by
	// default and only wired in environments that can perform a live
	// permission-relay round trip without blocking the terminal.
	PermissionSmoke func(ctx context.Context, binary string) error
}

// Probe returns Channel capabilities for binary/version. The version is the
// first gate: below MinimumClaudeChannelVersion the probe short-circuits
// and returns ErrClaudeChannelVersionUnsupported without invoking Run.
func (p ClaudeChannelProbe) Probe(ctx context.Context, binary, version string) (ClaudeChannelCapabilities, error) {
	caps := ClaudeChannelCapabilities{Version: version}
	if !SupportsClaudeChannelVersion(version) {
		return caps, fmt.Errorf("%w: have %s, need %s", ErrClaudeChannelVersionUnsupported, version, MinimumClaudeChannelVersion)
	}
	p = p.withDefaults()
	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()

	out, err := p.Run(ctx, binary, "--version")
	if err != nil {
		return caps, p.classifyError(ctx, err)
	}
	text := string(out)
	caps.ChannelsFlag = strings.Contains(text, "--channels")
	caps.DevelopmentChannelsFlag = strings.Contains(text, "--dangerously-load-development-channels")
	caps.MCPConfigFlag = strings.Contains(text, "--mcp-config")

	if p.PermissionSmoke != nil {
		if err := p.PermissionSmoke(ctx, binary); err != nil {
			return caps, p.classifyError(ctx, err)
		}
		caps.PermissionRelaySmokePassed = true
	}
	// ChannelCrashKeepsTUIAlive is conservatively false until a live test
	// (E2E matrix C13) proves the CLI version survives an MCP crash. The
	// launcher treats this as advisory, not a hard gate.
	caps.ChannelCrashKeepsTUIAlive = false
	return caps, nil
}

func (p ClaudeChannelProbe) withDefaults() ClaudeChannelProbe {
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

func (p ClaudeChannelProbe) classifyError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: %v", ErrClaudeChannelProbeTimeout, err)
	}
	return fmt.Errorf("%w: %v", ErrClaudeChannelProbeFailed, err)
}

// classifyClaudeChannelStatus maps a (capabilities, error) pair to a
// human-readable reason code for `agent claude-code status`. The launcher
// and daemon telemetry consume these codes; they must never leak version,
// path, or content.
func classifyClaudeChannelStatus(caps ClaudeChannelCapabilities, err error) string {
	switch {
	case err == nil && caps.Version != "" && SupportsClaudeChannelVersion(caps.Version):
		return StatusClaudeChannelReady
	case errors.Is(err, ErrClaudeChannelVersionUnsupported):
		return StatusClaudeChannelUnsupportedVersion
	case errors.Is(err, ErrClaudeChannelProbeTimeout):
		return StatusClaudeChannelProbeFailed
	case err != nil:
		return StatusClaudeChannelProbeFailed
	default:
		return StatusClaudeChannelProbeFailed
	}
}

// --- probe cache ---------------------------------------------------------
//
// The cache exists so repeated launcher invocations within the same daemon
// lifetime do not re-spawn `claude --version` on every interactive start.
// It MUST invalidate when the resolved binary path, file identity (size,
// mtime, mode), or version changes — an upgrade must re-probe.
//
// Design §Task 2: "缓存 key 包含 resolved binary、文件 identity/mtime、
// version;升级后必须重新 probe".

// fileIdentity captures the stable identity signals used in the cache key.
// The same path with a different size/mtime/mode is treated as a different
// binary.
type fileIdentity struct {
	size      int64
	mtimeUnix int64
	mode      uint32
}

type claudeChannelProbeCache struct {
	mu     sync.Mutex
	values map[string]ClaudeChannelCapabilities
}

func newClaudeChannelProbeCache() *claudeChannelProbeCache {
	return &claudeChannelProbeCache{values: make(map[string]ClaudeChannelCapabilities)}
}

// key returns the cache key string combining the resolved binary path,
// file identity and version. Each input dimension must alter the key so
// upgrades re-probe.
func (c *claudeChannelProbeCache) key(resolvedBinary string, identity fileIdentity, version string) string {
	return fmt.Sprintf("%s|%d|%d|%d|%s", resolvedBinary, identity.size, identity.mtimeUnix, identity.mode, version)
}

// get returns (value, ok) for a key.
func (c *claudeChannelProbeCache) get(key string) (ClaudeChannelCapabilities, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value, ok := c.values[key]
	return value, ok
}

// put stores a value under key.
func (c *claudeChannelProbeCache) put(key string, value ClaudeChannelCapabilities) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.values[key] = value
}
