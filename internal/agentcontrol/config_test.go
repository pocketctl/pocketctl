package agentcontrol

import (
	"errors"
	"os"
	"path/filepath"
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
	if info.Mode().Perm() != 0o600 {
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
