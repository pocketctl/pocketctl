// Package zcode implements the read-only ZCode session content sync. It is
// intentionally isolated from internal/adapter/opencode.go and the SessionManager
// (see docs/adr/0001-zcode-independent-read-only-observer.md): the daemon only
// reads ZCode's local SQLite store and never drives a ZCode session.
//
// config.go holds the explicit opt-in configuration for the sync
// (~/.pocketctl/zcode-sync.json). The daemon does not open the ZCode DB, discover
// ZCode sessions, or upload any ZCode content until the user runs
// `pocketctl agent zcode sync enable`.
package zcode

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
)

// ConfigVersion is the on-disk schema version for zcode-sync.json.
const ConfigVersion = 1

// History scopes.
const (
	HistoryRecent = "recent"
	HistoryAll    = "all"
)

// DefaultLookbackDays is the lookback window used when history=recent and the
// user does not specify one.
const DefaultLookbackDays = 7

const (
	zcodeConfigName        = "zcode-sync.json"
	zcodeStorageEnvVar     = "ZCODE_STORAGE_DIR"
	defaultZcodeStorageDir = ".zcode/cli" // relative to home; db lives at <storage>/db/db.sqlite
	lookbackMin            = 1
	lookbackMax            = 3650
)

// Config is the persisted opt-in state for ZCode session content sync.
type Config struct {
	Version      int    `json:"version"`
	Enabled      bool   `json:"enabled"`
	History      string `json:"history"`
	LookbackDays int    `json:"lookback_days"`
	StorageDir   string `json:"storage_dir"`
	SourceID     string `json:"source_id"`
}

// Validate checks the user-facing fields. It does NOT touch the filesystem.
func (c Config) Validate() error {
	if c.History != HistoryRecent && c.History != HistoryAll {
		return fmt.Errorf("invalid history %q: must be %q or %q", c.History, HistoryRecent, HistoryAll)
	}
	if c.LookbackDays < lookbackMin || c.LookbackDays > lookbackMax {
		return fmt.Errorf("invalid lookback_days %d: must be in [%d, %d]", c.LookbackDays, lookbackMin, lookbackMax)
	}
	return nil
}

// configHomeOverride lets tests point the config dir at a temp directory without
// depending on HOME. Empty → use the real ~/.pocketctl via config.ConfigDir().
var configHomeOverride string

// configDir returns the active config directory (test override or ~/.pocketctl).
func configDir() (string, error) {
	if configHomeOverride != "" {
		if err := os.MkdirAll(configHomeOverride, 0o700); err != nil {
			return "", err
		}
		return configHomeOverride, nil
	}
	return config.ConfigDir()
}

// ConfigPath returns the absolute path to zcode-sync.json.
func ConfigPath() string {
	dir, err := configDir()
	if err != nil || dir == "" {
		// Fall back to a best-effort path; callers of Save/Load will surface the
		// real error from configDir().
		home, herr := config.HomeDir()
		if herr != nil {
			return zcodeConfigName
		}
		return filepath.Join(home, ".pocketctl", zcodeConfigName)
	}
	return filepath.Join(dir, zcodeConfigName)
}

// LoadConfig reads the persisted config. A missing file is equivalent to a
// disabled config (no error). A corrupt file is renamed to
// zcode-sync.json.corrupt-<ts> and a fail-closed disabled config + error are
// returned, so a malformed file can never be treated as enabled.
func LoadConfig() (Config, error) {
	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return disabledDefaults(), nil
		}
		return disabledDefaults(), err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		quarantineCorrupt(path, data)
		return disabledDefaults(), fmt.Errorf("zcode sync config corrupt: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		quarantineCorrupt(path, data)
		return disabledDefaults(), fmt.Errorf("zcode sync config invalid: %w", err)
	}
	return cfg, nil
}

// SaveConfig atomically writes the config with 0600 permissions. It writes to a
// temp file in the same directory and renames, so a crash mid-write never leaves
// a truncated zcode-sync.json.
func SaveConfig(cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".zcode-sync.*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	final := filepath.Join(dir, zcodeConfigName)
	if err := os.Rename(tmpName, final); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// disabledDefaults is the canonical "not enabled" config with safe defaults.
func disabledDefaults() Config {
	return Config{
		Version:      ConfigVersion,
		Enabled:      false,
		History:      HistoryRecent,
		LookbackDays: DefaultLookbackDays,
	}
}

// quarantineCorrupt renames a corrupt config file aside (preserving it as
// evidence) with a timestamp suffix, then best-effort writes a disabled default
// so the next LoadConfig sees a clean disabled state.
func quarantineCorrupt(path string, original []byte) {
	dir := filepath.Dir(path)
	ts := time.Now().Format("20060102-150405")
	_ = os.WriteFile(filepath.Join(dir, zcodeConfigName+".corrupt-"+ts), original, 0o600)
	_ = os.Rename(path, filepath.Join(dir, zcodeConfigName+".corrupt-renamed-"+ts))
	_ = SaveConfig(disabledDefaults())
}

// newSourceID generates a fresh 128-bit source id as 32 lowercase hex chars.
func newSourceID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand should not fail in practice; fall back to time-based entropy
		// rather than panicking, which would take down the daemon.
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (i % 8 * 8))
		}
	}
	return hex.EncodeToString(b[:])
}

// normalizedStorageRoot canonicalizes a storage directory for source-id binding.
// Source ids are bound to the storage root (not the schema), so a schema upgrade
// never regenerates the id, while pointing at a different DB does.
func normalizedStorageRoot(storageDir string) string {
	if storageDir == "" {
		storageDir = resolveDefaultStorageDir()
	}
	abs, err := filepath.Abs(storageDir)
	if err != nil {
		abs = storageDir
	}
	// Lexicographic, stable form. Symlinks are intentionally NOT resolved here:
	// the user points at a logical storage dir, and resolving symlinks would make
	// the binding brittle across system updates.
	return filepath.Clean(abs)
}

// resolveDefaultStorageDir returns the default ZCode storage directory:
// ~/.zcode/cli (the db lives at <storage>/db/db.sqlite).
func resolveDefaultStorageDir() string {
	home, err := config.HomeDir()
	if err != nil || home == "" {
		return defaultZcodeStorageDir
	}
	return filepath.Join(home, defaultZcodeStorageDir)
}

// ResolveStorageDir applies the precedence: explicit config value > env var >
// default ~/.zcode/cli. It does not validate that the dir exists.
func ResolveStorageDir(cfg Config) string {
	if cfg.StorageDir != "" {
		return cfg.StorageDir
	}
	if env := os.Getenv(zcodeStorageEnvVar); env != "" {
		return env
	}
	return resolveDefaultStorageDir()
}

// EnsureSourceID returns the source id bound to the config's storage root,
// generating and persisting a new one the first time a storage root is seen.
// The same normalized storage root always yields the same id; a different
// storage root yields a different id. Schema changes never regenerate the id.
func EnsureSourceID(cfg Config) string {
	existing, err := LoadConfig()
	if err == nil && existing.SourceID != "" && normalizedStorageRoot(existing.StorageDir) == normalizedStorageRoot(ResolveStorageDir(cfg)) {
		return existing.SourceID
	}
	id := newSourceID()
	persist := cfg
	persist.SourceID = id
	// Best-effort persistence; callers that need the id at enable time proceed
	// with the in-memory value if the write fails (SaveConfig validates first).
	_ = SaveConfig(persist)
	return id
}

// corruptEvidenceExists reports whether any .corrupt-* evidence file exists in
// dir (used by tests as a lenient check).
func corruptEvidenceExists(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".corrupt") {
			return true
		}
	}
	return false
}
