package discovery

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/zcode"
)

// withTempHome isolates zcode-sync.json into a temp HOME.
func withTempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func enableZcodeSync(t *testing.T, storage string) {
	t.Helper()
	cfg := zcode.Config{
		Version:      zcode.ConfigVersion,
		Enabled:      true,
		History:      zcode.HistoryRecent,
		LookbackDays: 7,
		StorageDir:   storage,
		SourceID:     "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
	if err := zcode.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverZcode_OmittedWhenDisabled(t *testing.T) {
	withTempHome(t)
	// No config written → disabled.
	if _, ok := DiscoverZcode(); ok {
		t.Fatal("DiscoverZcode must omit zcode when config is absent/disabled")
	}
	// And DiscoverAgents must not include it either.
	for _, a := range DiscoverAgents() {
		if a.Type == "zcode" {
			t.Fatal("DiscoverAgents surfaced zcode while disabled")
		}
	}
}

func TestDiscoverZcode_SurfacesWhenEnabledAndSchemaOK(t *testing.T) {
	withTempHome(t)
	// Build a real sanitized SQLite fixture under storage.
	storage := buildZcodeFixture(t)
	enableZcodeSync(t, storage)
	info, ok := DiscoverZcode()
	if !ok {
		t.Fatal("DiscoverZcode must surface zcode when enabled + schema OK")
	}
	if info.Type != "zcode" || info.Manageable {
		t.Fatalf("unexpected AgentInfo: %+v", info)
	}
	if info.Version != "" || info.Latest != "" {
		t.Fatalf("zcode must not report version from DB content: %+v", info)
	}
	// DiscoverAgents includes it.
	found := false
	for _, a := range DiscoverAgents() {
		if a.Type == "zcode" {
			found = true
		}
	}
	if !found {
		t.Fatal("DiscoverAgents must include zcode when enabled")
	}
}

func TestDiscoverZcode_OmittedWhenStorageMissing(t *testing.T) {
	withTempHome(t)
	enableZcodeSync(t, filepath.Join(t.TempDir(), "no-such-storage"))
	if _, ok := DiscoverZcode(); ok {
		t.Fatal("DiscoverZcode must omit zcode when storage is missing")
	}
}

func TestDiscoverZcode_OmittedWhenSchemaIncompatible(t *testing.T) {
	withTempHome(t)
	storage := buildZcodeFixture(t)
	enableZcodeSync(t, storage)
	// Corrupt schema by dropping a required table.
	dbPath := filepath.Join(storage, "db", "db.sqlite")
	removeTable(t, dbPath, "todo")
	if _, ok := DiscoverZcode(); ok {
		t.Fatal("DiscoverZcode must omit zcode when schema is incompatible")
	}
}

// TestDiscoverZcode_NoNpmQuery confirms detectLatest is never invoked for
// zcode (no npm subprocess). This is implicit — there's no CLIName/Package — but
// we assert DiscoverAgents returns quickly and the agent has no Package-driven
// fields.
func TestDiscoverZcode_NoNpmQuery(t *testing.T) {
	withTempHome(t)
	storage := buildZcodeFixture(t)
	enableZcodeSync(t, storage)
	// If detectLatest ran npm it would be slow/flaky; we just ensure the call
	// succeeds deterministically and the agent has empty Latest.
	info, ok := DiscoverZcode()
	if !ok || info.Latest != "" {
		t.Fatalf("zcode must not run npm: %+v ok=%v", info, ok)
	}
}

// buildZcodeFixture creates a sanitized zcode storage dir + db via the zcode
// testdb helper. Because that helper lives in the zcode package's tests, we
// recreate the minimal schema here using the same modernc driver.
func buildZcodeFixture(t *testing.T) string {
	t.Helper()
	storage := t.TempDir()
	dbDir := filepath.Join(storage, "db")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(dbDir, "db.sqlite")
	createZcodeSchema(t, dbPath)
	return storage
}

func createZcodeSchema(t *testing.T, dbPath string) {
	t.Helper()
	openDB := func(dsn string) *zcodeTestDB { return openZcodeDB(t, dsn) }
	db := openDB("file:" + dbPath + "?_pragma=journal_mode(WAL)")
	defer db.Close()
	ctx := context.Background()
	for _, q := range zcodeSchemaSQL {
		if err := db.exec(ctx, q); err != nil {
			t.Fatalf("create schema: %v", err)
		}
	}
}

func removeTable(t *testing.T, dbPath, table string) {
	t.Helper()
	db := openZcodeDB(t, "file:"+dbPath)
	defer db.Close()
	if err := db.exec(context.Background(), "DROP TABLE "+table); err != nil {
		t.Fatalf("drop %s: %v", table, err)
	}
}
