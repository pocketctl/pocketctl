package agentcontrol

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLauncherConfigMissingIsUndecided(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Version != ConfigVersion || cfg.OpenCode.State != StateUndecided || cfg.Codex.State != StateUndecided {
		t.Fatalf("unexpected default config: %+v", cfg)
	}
}

func TestLauncherConfigOpenCodeOnlyFileMigratesCodexToUndecided(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, err := ConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"version":1,"opencode":{"state":"enabled","real_binary":"/opt/opencode"}}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OpenCode.State != StateEnabled || cfg.Codex.State != StateUndecided {
		t.Fatalf("unexpected migrated config: %+v", cfg)
	}
}

func TestLauncherConfigAtomicPrivateRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	want := Config{
		Version: ConfigVersion,
		OpenCode: AgentConfig{
			State:          StateEnabled,
			DecisionSource: SourceCommand,
			RealBinary:     "/opt/opencode",
			ShimPath:       filepath.Join(home, ".pocketctl", "bin", "opencode"),
			DecidedAt:      time.Unix(100, 0).UTC(),
			InstalledAt:    time.Unix(101, 0).UTC(),
		},
		Codex: AgentConfig{
			State:          StateEnabled,
			DecisionSource: SourceCommand,
			RealBinary:     "/opt/codex",
			ShimPath:       filepath.Join(home, ".pocketctl", "bin", "codex"),
			DecidedAt:      time.Unix(102, 0).UTC(),
			InstalledAt:    time.Unix(103, 0).UTC(),
		},
		Claude: AgentConfig{State: StateUndecided},
	}
	if err := SaveConfig(want); err != nil {
		t.Fatal(err)
	}
	path, err := ConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%o, want 600", info.Mode().Perm())
	}
	if matches, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".agent-launchers-*")); err != nil || len(matches) != 0 {
		t.Fatalf("temp residue=%v err=%v", matches, err)
	}
	got, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.OpenCode.State != StateEnabled || got.OpenCode.RealBinary != "/opt/opencode" || !got.OpenCode.InstalledAt.Equal(want.OpenCode.InstalledAt) {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	if got.Codex.State != StateEnabled || got.Codex.RealBinary != "/opt/codex" || !got.Codex.InstalledAt.Equal(want.Codex.InstalledAt) {
		t.Fatalf("codex round trip mismatch: %+v", got)
	}
}

func TestLauncherConfigCorruptFailsClosed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, err := ConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig()
	if err == nil {
		t.Fatal("expected parse error")
	}
	if cfg.OpenCode.State != StateUndecided {
		t.Fatalf("corrupt config did not fail closed: %+v", cfg)
	}
}

func TestLauncherConfigFutureVersionIsNotOverwritten(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, err := ConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"version":99,"opencode":{"state":"enabled"}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveConfig(DefaultConfig()); !errors.Is(err, ErrConfigVersion) {
		t.Fatalf("SaveConfig error=%v, want ErrConfigVersion", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(original) {
		t.Fatalf("future config overwritten: %s", got)
	}
}

// TestLauncherConfigPreservesOpenCodeCodexOnClaudeUpgrade freezes the
// non-regression boundary: adding the optional `claude` field under the
// legacy v1 header MUST leave OpenCode/Codex structures equivalent, and
// re-saving with a Claude entry MUST NOT alter the OpenCode/Codex golden
// JSON. Older binaries ignore the optional field and can still read v1.
func TestLauncherConfigPreservesOpenCodeCodexOnClaudeUpgrade(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path, err := ConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"version":1,"opencode":{"state":"enabled","real_binary":"/opt/opencode","shim_path":"/home/o/.pocketctl/bin/opencode"},"codex":{"state":"disabled","real_binary":"/opt/codex"}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	// The dedicated Claude field exists without changing the v1 header.
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig failed on v1 file: %v", err)
	}
	if !claudeAgentConfigPresent(cfg) {
		t.Fatalf("Config must expose a dedicated Claude AgentConfig field after v2 upgrade (design §Task 3); got %+v", cfg)
	}

	// Mutate only the Claude entry and re-save. OpenCode/Codex state, real
	// binary and shim path MUST be preserved verbatim (the Claude enable
	// path must not touch the other agents' fields).
	setClaudeAgentConfigForTest(t, &cfg, AgentConfig{State: StateEnabled, RealBinary: "/opt/claude"})
	if err := SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig with Claude entry failed: %v", err)
	}
	got, err := LoadConfig()
	if err != nil {
		t.Fatalf("reload failed: %v", err)
	}
	if got.OpenCode.State != StateEnabled || got.OpenCode.RealBinary != "/opt/opencode" ||
		got.OpenCode.ShimPath != "/home/o/.pocketctl/bin/opencode" {
		t.Fatalf("OpenCode altered by Claude upgrade: %+v", got.OpenCode)
	}
	if got.Codex.State != StateDisabled || got.Codex.RealBinary != "/opt/codex" {
		t.Fatalf("Codex altered by Claude upgrade: %+v", got.Codex)
	}
	if got.Claude.State != StateEnabled || got.Claude.RealBinary != "/opt/claude" {
		t.Fatalf("Claude entry not persisted: %+v", got.Claude)
	}
	if got.Version != ConfigVersion {
		t.Fatalf("version=%d want %d", got.Version, ConfigVersion)
	}
}

// TestLauncherConfigV2RejectsDowngradeAndUnknownHigherVersion freezes the
// forward-compatibility guard: saving the current v1 config over an unknown
// higher on-disk header MUST be refused.
func TestLauncherConfigV2RejectsDowngradeAndUnknownHigherVersion(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, err := ConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"version":99,"opencode":{"state":"enabled"}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveConfig(DefaultConfig()); !errors.Is(err, ErrConfigVersion) {
		t.Fatalf("SaveConfig error=%v, want ErrConfigVersion", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(original) {
		t.Fatalf("future config overwritten: %s", got)
	}
}

func TestLauncherConfigClaudeFieldKeepsLegacyV1Header(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := DefaultConfig()
	cfg.Claude = AgentConfig{State: StateEnabled, RealBinary: "/opt/claude"}
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	path, err := ConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var legacy struct {
		Version  int         `json:"version"`
		OpenCode AgentConfig `json:"opencode"`
		Codex    AgentConfig `json:"codex"`
	}
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.Version != 1 {
		t.Fatalf("legacy Pocketctl would reject launcher config version %d", legacy.Version)
	}
}

// claudeAgentConfigPresent reports whether the Config struct exposes a
// dedicated Claude AgentConfig field (JSON key "claude").
func claudeAgentConfigPresent(cfg Config) bool {
	return claudeAgentConfigFieldReflectionPresent()
}

// setClaudeAgentConfigForTest mutates the Claude AgentConfig field on cfg.
func setClaudeAgentConfigForTest(t *testing.T, cfg *Config, value AgentConfig) {
	t.Helper()
	if !claudeAgentConfigFieldReflectionPresent() {
		t.Fatalf("Config.Claude field must exist before it can be set (design §Task 3)")
	}
	setClaudeAgentConfigViaReflection(cfg, value)
}

// opencodeCodexGoldenJSON extracts the OpenCode and Codex AgentConfig JSON
// from the on-disk file so the test can assert Claude additions don't leak
// into the other agents' fields.
func opencodeCodexGoldenJSON(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var probe struct {
		OpenCode AgentConfig `json:"opencode"`
		Codex    AgentConfig `json:"codex"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatal(err)
	}
	oc, _ := json.Marshal(probe.OpenCode)
	cx, _ := json.Marshal(probe.Codex)
	return string(oc) + "\n" + string(cx)
}
