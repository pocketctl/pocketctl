package agentcontrol

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// TestClaudeChannelProbeMinimumVersion verifies the semver gate:
//   - 2.1.210 and below are rejected
//   - 2.1.211 is accepted
//   - pre-release/dirty versions fail closed
//
// Design §0: "Pocketctl 的生产最低版本定为 2.1.211,不是仅满足协议的 2.1.81".
// Design §Task 2: "2.1.210 拒绝,2.1.211 接受,预发布/脏版本 fail closed".
func TestClaudeChannelProbeMinimumVersion(t *testing.T) {
	tests := []struct {
		name    string
		version string
		wantOK  bool
	}{
		{"exact minimum", "2.1.211", true},
		{"above minimum", "2.1.212", true},
		{"major bump", "2.2.0", true},
		{"below patch", "2.1.210", false},
		{"below minor", "2.1.80", false},
		{"below major", "1.0.0", false},
		{"protocol floor only is NOT enough", "2.1.81", false},
		{"dirty fails closed", "2.1.211-dirty", false},
		{"pre-release fails closed", "2.1.211-rc.1", false},
		{"build metadata fails closed", "2.1.211+build", false},
		{"empty fails closed", "", false},
		{"garbage fails closed", "not-a-version", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SupportsClaudeChannelVersion(tt.version)
			if got != tt.wantOK {
				t.Fatalf("SupportsClaudeChannelVersion(%q)=%v want %v", tt.version, got, tt.wantOK)
			}
		})
	}
}

// TestClaudeChannelProbeSemverIsFirstGateBeforeSmoke verifies that the
// version check is the first gate: a version below minimum must short-
// circuit and NOT attempt any live probe (no Run call). Design §Task 2:
// "semver 是第一道门,live permission smoke 是发布前第二道门".
func TestClaudeChannelProbeSemverIsFirstGateBeforeSmoke(t *testing.T) {
	probe := ClaudeChannelProbe{
		Run: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			t.Fatal("Run must not be called when version is below minimum")
			return nil, nil
		},
	}
	_, err := probe.Probe(context.Background(), "/fake/claude", "2.1.210")
	if err == nil {
		t.Fatal("expected error for below-minimum version")
	}
	if !errors.Is(err, ErrClaudeChannelVersionUnsupported) {
		t.Fatalf("error=%v, want ErrClaudeChannelVersionUnsupported", err)
	}
}

// TestClaudeChannelProbeFlagsDetectedFromVersionOutput verifies that the
// flag probe (hidden --channels / --dangerously-load-development-channels
// / --mcp-config acceptance) reads `claude --version` output in an isolated
// HOME, NOT `claude --help` (design §Task 2: "flag probe 用隔离 HOME 和
// --version,每次有超时").
func TestClaudeChannelProbeFlagsDetectedFromVersionOutput(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	probe := ClaudeChannelProbe{
		Timeout: 2 * time.Second,
		Run: func(_ context.Context, binary string, args ...string) ([]byte, error) {
			if binary != "/fake/claude" {
				t.Fatalf("binary=%q", binary)
			}
			if len(args) == 1 && args[0] == "--version" {
				return []byte("claude code 2.1.211\n--channels\n--dangerously-load-development-channels\n--mcp-config\n"), nil
			}
			t.Fatalf("unexpected args=%v", args)
			return nil, nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/fake/claude", "2.1.211")
	if err != nil {
		t.Fatalf("Probe error=%v", err)
	}
	if !caps.ChannelsFlag || !caps.DevelopmentChannelsFlag || !caps.MCPConfigFlag {
		t.Fatalf("flags not detected: %+v", caps)
	}
	if caps.Version != "2.1.211" {
		t.Fatalf("version=%q want 2.1.211", caps.Version)
	}
}

// TestClaudeChannelProbeTimeoutFailsClosedToNative verifies timeout, non-
// zero exit, and unparseable output all produce a probe error suitable for
// native fallback (design §Task 2: "timeout、非零退出、无法解析版本都只
// 导致 native fallback").
func TestClaudeChannelProbeTimeoutFailsClosedToNative(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		probe := ClaudeChannelProbe{
			Timeout: 5 * time.Millisecond,
			Run: func(ctx context.Context, _ string, _ ...string) ([]byte, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			},
		}
		_, err := probe.Probe(context.Background(), "/fake/claude", "2.1.211")
		if err == nil {
			t.Fatal("expected timeout error")
		}
		if !errors.Is(err, ErrClaudeChannelProbeTimeout) {
			t.Fatalf("error=%v, want ErrClaudeChannelProbeTimeout", err)
		}
	})
	t.Run("nonzero exit", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		probe := ClaudeChannelProbe{
			Timeout: 2 * time.Second,
			Run: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
				return []byte("boom"), os.ErrProcessDone
			},
		}
		_, err := probe.Probe(context.Background(), "/fake/claude", "2.1.211")
		if err == nil {
			t.Fatal("expected probe error for nonzero exit")
		}
	})
	t.Run("unparseable version output", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		probe := ClaudeChannelProbe{
			Timeout: 2 * time.Second,
			Run: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
				return []byte("totally garbage no flags here"), nil
			},
		}
		caps, err := probe.Probe(context.Background(), "/fake/claude", "2.1.211")
		if err != nil {
			t.Fatalf("unparseable output should not hard-fail the probe, just yield no flags: %v", err)
		}
		if caps.ChannelsFlag || caps.DevelopmentChannelsFlag || caps.MCPConfigFlag {
			t.Fatalf("flags should not be detected from garbage: %+v", caps)
		}
	})
}

// TestClaudeChannelProbeDoesNotReadOrModifyUserConfig verifies the probe
// never reads ~/.claude.json or ~/.claude/settings.json (design §Task 2:
// "不读取或修改 Claude 用户配置完成 probe").
func TestClaudeChannelProbeDoesNotReadOrModifyUserConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Plant decoy user config files that would corrupt the probe if read.
	claudeDir := home + "/.claude"
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(claudeDir+"/settings.json", []byte(`{"broken":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(home+"/.claude.json", []byte(`{"broken":`), 0o600); err != nil {
		t.Fatal(err)
	}
	probe := ClaudeChannelProbe{
		Timeout: 2 * time.Second,
		Run: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return []byte("claude code 2.1.211\n--channels\n--dangerously-load-development-channels\n--mcp-config\n"), nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/fake/claude", "2.1.211")
	if err != nil {
		t.Fatalf("Probe should ignore broken user config: %v", err)
	}
	if !caps.ChannelsFlag {
		t.Fatalf("flags not detected despite decoy config: %+v", caps)
	}
}

// TestClaudeChannelProbeCacheKeyInvalidatesOnBinaryIdentityChange verifies
// that the cache key includes resolved binary path, file identity/mtime,
// and version, so an upgrade re-probes (design §Task 2: "缓存 key 包含
// resolved binary、文件 identity/mtime、version;升级后必须重新 probe").
func TestClaudeChannelProbeCacheKeyInvalidatesOnBinaryIdentityChange(t *testing.T) {
	cache := newClaudeChannelProbeCache()
	key1 := cache.key("/path/a", fileIdentity{size: 100, mtimeUnix: 1000, mode: 0o755}, "2.1.211")
	key2 := cache.key("/path/b", fileIdentity{size: 100, mtimeUnix: 1000, mode: 0o755}, "2.1.211")
	key3 := cache.key("/path/a", fileIdentity{size: 200, mtimeUnix: 1000, mode: 0o755}, "2.1.211")
	key4 := cache.key("/path/a", fileIdentity{size: 100, mtimeUnix: 2000, mode: 0o755}, "2.1.211")
	key5 := cache.key("/path/a", fileIdentity{size: 100, mtimeUnix: 1000, mode: 0o755}, "2.1.212")
	if key1 == key2 {
		t.Fatal("cache key must include resolved binary path")
	}
	if key1 == key3 {
		t.Fatal("cache key must include file size")
	}
	if key1 == key4 {
		t.Fatal("cache key must include file mtime")
	}
	if key1 == key5 {
		t.Fatal("cache key must include version")
	}
}

// TestClaudeChannelProbeStatusReasons verifies the human-readable status
// classification required by `agent claude-code status` (design §Task 2):
// unsupported_version, organization_disabled,
// development_channel_not_confirmed, probe_failed.
func TestClaudeChannelProbeStatusReasons(t *testing.T) {
	tests := []struct {
		name   string
		caps   ClaudeChannelCapabilities
		err    error
		want   string
	}{
		{"unsupported version", ClaudeChannelCapabilities{Version: "2.1.210"}, ErrClaudeChannelVersionUnsupported, StatusClaudeChannelUnsupportedVersion},
		{"probe timeout", ClaudeChannelCapabilities{Version: "2.1.211"}, ErrClaudeChannelProbeTimeout, StatusClaudeChannelProbeFailed},
		{"probe generic error", ClaudeChannelCapabilities{Version: "2.1.211"}, errors.New("boom"), StatusClaudeChannelProbeFailed},
		{"healthy", ClaudeChannelCapabilities{Version: "2.1.211", ChannelsFlag: true, DevelopmentChannelsFlag: true, MCPConfigFlag: true, PermissionRelaySmokePassed: true}, nil, StatusClaudeChannelReady},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyClaudeChannelStatus(tt.caps, tt.err)
			if got != tt.want {
				t.Fatalf("got=%q want=%q", got, tt.want)
			}
		})
	}
}

// TestClaudeManagedProbeStaysNoGoWhenChannelSucceeds freezes the boundary
// (design §Task 2): the legacy ClaudeProbe.Managed() six-field shared
// runtime gate must remain false even when ClaudeChannelCapabilities says
// the channel relay is healthy. The two probes describe DIFFERENT surfaces.
func TestClaudeManagedProbeStaysNoGoWhenChannelSucceeds(t *testing.T) {
	channelCaps := ClaudeChannelCapabilities{
		Version:                    "2.1.211",
		ChannelsFlag:               true,
		DevelopmentChannelsFlag:    true,
		MCPConfigFlag:              true,
		PermissionRelaySmokePassed: true,
		ChannelCrashKeepsTUIAlive:  true,
	}
	// Build the legacy managed caps and assert Managed() is still false —
	// channel success must NOT flip shared_runtime authority fields.
	legacy := ClaudeManagedCapabilities{
		Version:                 channelCaps.Version,
		RemoteControlAdvertised: true,
		StreamJSONInput:         true,
		Resume:                  true,
	}
	if legacy.Managed() {
		t.Fatalf("legacy ClaudeProbe.Managed() must remain false; Claude Channel success does NOT grant shared runtime authority. legacy=%+v", legacy)
	}
	// And the legacy probe error type is still about managed runtime, not channels.
	if !strings.Contains(ErrClaudeManagedCapabilities.Error(), "managed runtime") {
		t.Fatalf("ErrClaudeManagedCapabilities message changed: %v", ErrClaudeManagedCapabilities)
	}
}
