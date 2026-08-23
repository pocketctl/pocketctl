package zcode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newConfigDir returns a fresh temp dir acting as ~/.pocketctl.
func newConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() { configHomeOverride = "" })
	configHomeOverride = dir
	return dir
}

func TestLoadConfig_MissingEqualsDisabled(t *testing.T) {
	newConfigDir(t)
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig missing config err = %v", err)
	}
	if cfg.Enabled {
		t.Fatal("missing config should be equivalent to enabled=false")
	}
	// Defaults for an absent config.
	if cfg.History != HistoryRecent || cfg.LookbackDays != DefaultLookbackDays {
		t.Fatalf("absent config defaults = %+v", cfg)
	}
}

func TestSaveConfig_AtomicAndPermission0600(t *testing.T) {
	newConfigDir(t)
	cfg := Config{
		Version:      ConfigVersion,
		Enabled:      true,
		History:      HistoryAll,
		LookbackDays: 90,
		StorageDir:   "/tmp/zcode",
		SourceID:     newSourceID(),
	}
	if err := SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig err = %v", err)
	}
	path := ConfigPath()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config perm = %o, want 0600", perm)
	}
	// No leftover temp file.
	entries, _ := os.ReadDir(filepath.Dir(path))
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp") || strings.Contains(e.Name(), ".temp") {
			t.Fatalf("leftover temp file: %s", e.Name())
		}
	}
}

func TestLoadConfig_RoundTrip(t *testing.T) {
	newConfigDir(t)
	orig := Config{
		Version:      ConfigVersion,
		Enabled:      true,
		History:      HistoryAll,
		LookbackDays: 7,
		StorageDir:   "/var/zcode",
		SourceID:     "abcdef0123456789abcdef0123456789",
	}
	if err := SaveConfig(orig); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	got, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if got.Enabled != orig.Enabled || got.History != orig.History ||
		got.LookbackDays != orig.LookbackDays || got.StorageDir != orig.StorageDir ||
		got.SourceID != orig.SourceID {
		t.Fatalf("round-trip mismatch:\n got=%+v\nwant=%+v", got, orig)
	}
}

func TestCorruptConfig_FailClosed(t *testing.T) {
	dir := newConfigDir(t)
	if err := os.WriteFile(ConfigPath(), []byte("{not valid json"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig()
	if err == nil {
		t.Fatalf("LoadConfig corrupt should error, got cfg=%+v", cfg)
	}
	if cfg.Enabled {
		t.Fatal("corrupt config must not be treated as enabled")
	}
	// Evidence preserved.
	if _, statErr := os.Stat(filepath.Join(dir, zcodeConfigName+".corrupt-"+strings.Split(filepath.Base(ConfigPath()), ".corrupt")[0])); statErr != nil && !corruptEvidenceExists(dir) {
		// At minimum a .corrupt-* file must exist somewhere in the config dir.
		t.Fatalf("corrupt config evidence not preserved in %s", dir)
	}
}

func TestValidate_HistoryAndLookbackBounds(t *testing.T) {
	tests := []struct {
		name     string
		history  string
		lookback int
		wantErr  bool
	}{
		{"recent ok", HistoryRecent, 30, false},
		{"all ok", HistoryAll, 1, false},
		{"bad history", "yesterday", 30, true},
		{"empty history", "", 30, true},
		{"lookback too small", HistoryRecent, 0, true},
		{"lookback too large", HistoryRecent, 3651, true},
		{"lookback max ok", HistoryRecent, 3650, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{History: tt.history, LookbackDays: tt.lookback}
			err := cfg.Validate()
			if (err != nil) != tt.wantErr {
				t.Fatalf("Validate() err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestNewSourceID_IsValid32Hex(t *testing.T) {
	id := newSourceID()
	if len(id) != 32 {
		t.Fatalf("source id len = %d, want 32", len(id))
	}
	for _, c := range id {
		if !strings.ContainsRune("0123456789abcdef", c) {
			t.Fatalf("source id %q has non-hex rune %q", id, c)
		}
	}
	// Two calls produce different ids (random).
	if newSourceID() == id {
		t.Fatal("newSourceID produced duplicate ids")
	}
}

func TestSourceIDStableForSameStorage_RegeneratedOnStorageChange_UnchangedOnSchemaChange(t *testing.T) {
	newConfigDir(t)
	store := "/tmp/zcode-a"

	// First enable on store A.
	id1 := EnsureSourceID(Config{Enabled: true, History: HistoryRecent, LookbackDays: 30, StorageDir: store})
	if id1 == "" {
		t.Fatal("first EnsureSourceID returned empty")
	}

	// Re-enable on the same storage root → same id (schema fingerprint is not
	// part of the binding, so this also covers "schema change keeps id").
	id2 := EnsureSourceID(Config{Enabled: true, History: HistoryRecent, LookbackDays: 30, StorageDir: store})
	if id2 != id1 {
		t.Fatalf("same storage must keep source id: got %q want %q", id2, id1)
	}

	// Different storage root → new id.
	id3 := EnsureSourceID(Config{Enabled: true, History: HistoryRecent, LookbackDays: 30, StorageDir: "/tmp/zcode-b"})
	if id3 == id1 {
		t.Fatal("different storage must regenerate source id")
	}
}
