package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/zcode"
)

// zcodeAgentType is the canonical agent type for ZCode. It mirrors
// adapter.AgentZcode without importing internal/adapter (cmd/pocketctl already
// depends on it transitively, but the CLI layer keeps its own string to avoid a
// direct adapter import here).
const zcodeAgentType = "zcode"

// runZcodeSyncCommand dispatches `pocketctl agent zcode sync <enable|disable|
// status|help>`. It never touches the agentcontrol launcher manager: ZCode is a
// read-only observer and has no managed launcher, PATH shim, or upgrade path.
func runZcodeSyncCommand(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(stdout, i18n.T("agent.zcode_sync_help"))
		return nil
	}
	if args[0] != "sync" {
		// `pocketctl agent zcode help` is also valid.
		fmt.Fprintln(stdout, i18n.T("agent.zcode_sync_help"))
		return nil
	}
	if len(args) == 1 || args[1] == "help" || args[1] == "--help" || args[1] == "-h" {
		fmt.Fprintln(stdout, i18n.T("agent.zcode_sync_help"))
		return nil
	}
	switch args[1] {
	case "enable":
		return zcodeSyncEnable(args[2:], stdout, stderr)
	case "disable":
		return zcodeSyncDisable(stdout, stderr)
	case "status":
		return zcodeSyncStatus(stdout)
	default:
		return fmt.Errorf("%s", i18n.T("agent.zcode_unknown_action", args[1]))
	}
}

func zcodeSyncEnable(rest []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("agent zcode sync enable", flag.ContinueOnError)
	fs.SetOutput(stderr)
	history := fs.String("history", zcode.HistoryRecent, i18n.T("agent.zcode_sync_help"))
	lookback := fs.Int("lookback-days", zcode.DefaultLookbackDays, "lookback window in days (1..3650), used when history=recent")
	storageDir := fs.String("storage-dir", "", "ZCode storage directory (defaults to ZCODE_STORAGE_DIR or ~/.zcode/cli)")
	if err := fs.Parse(rest); err != nil {
		return err
	}

	cfg := zcode.Config{
		Version:      zcode.ConfigVersion,
		Enabled:      true,
		History:      *history,
		LookbackDays: *lookback,
		StorageDir:   *storageDir,
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("%s", i18n.T("agent.zcode_enable_failed", err.Error()))
	}

	resolved := zcode.ResolveStorageDir(cfg)
	if err := probeZcodeStorage(resolved); err != nil {
		// probe failure must NOT write enabled=true (fail-closed).
		return fmt.Errorf("%s", i18n.T("agent.zcode_enable_failed", err.Error()))
	}

	cfg.SourceID = zcode.EnsureSourceID(cfg)
	if err := zcode.SaveConfig(cfg); err != nil {
		return fmt.Errorf("%s", i18n.T("agent.zcode_enable_failed", err.Error()))
	}

	fmt.Fprintln(stdout, i18n.T("agent.zcode_enabled_restart", cfg.History, cfg.LookbackDays))
	return nil
}

func zcodeSyncDisable(stdout, stderr io.Writer) error {
	existing, _ := zcode.LoadConfig()
	existing.Enabled = false
	if existing.History == "" {
		existing.History = zcode.HistoryRecent
	}
	if existing.LookbackDays == 0 {
		existing.LookbackDays = zcode.DefaultLookbackDays
	}
	// Preserve source_id/storage_dir so a later enable on the same storage root
	// keeps the same wire session ids (disable does not delete identity).
	if err := zcode.SaveConfig(existing); err != nil {
		return fmt.Errorf("%s", i18n.T("agent.zcode_disable_failed", err.Error()))
	}
	fmt.Fprintln(stdout, i18n.T("agent.zcode_disabled"))
	return nil
}

func zcodeSyncStatus(stdout io.Writer) error {
	cfg, _ := zcode.LoadConfig()
	resolved := zcode.ResolveStorageDir(cfg)
	schemaState := i18n.T("agent.zcode_schema_unknown")
	if cfg.Enabled {
		if err := probeZcodeStorage(resolved); err != nil {
			schemaState = i18n.T("agent.zcode_schema_incompatible")
		} else {
			schemaState = i18n.T("agent.zcode_schema_ok")
		}
	}
	sourceID := cfg.SourceID
	if sourceID == "" {
		sourceID = "-"
	}
	fmt.Fprintln(stdout, i18n.T("agent.zcode_status_header"))
	fmt.Fprintln(stdout, i18n.T("agent.zcode_status_enabled", yesNo(cfg.Enabled)))
	fmt.Fprintln(stdout, i18n.T("agent.zcode_status_history", displayValue(cfg.History)))
	fmt.Fprintln(stdout, i18n.T("agent.zcode_status_lookback", cfg.LookbackDays))
	fmt.Fprintln(stdout, i18n.T("agent.zcode_status_storage", resolved))
	fmt.Fprintln(stdout, i18n.T("agent.zcode_status_schema", schemaState))
	fmt.Fprintln(stdout, i18n.T("agent.zcode_status_source", sourceID))
	fmt.Fprintln(stdout, i18n.T("agent.zcode_status_no_session_info"))
	return nil
}

// probeZcodeStorage validates that the storage directory exists, is a directory,
// is readable, and contains a db/db.sqlite file. It performs NO schema probe
// here (the full SQLite probe lives in internal/zcode.Store, wired in a later
// task); it only guards against enabling sync against a missing/inaccessible
// storage root. It never opens the DB and never writes anything.
func probeZcodeStorage(storageDir string) error {
	abs, err := filepath.Abs(storageDir)
	if err != nil {
		return fmt.Errorf("resolve storage dir: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return fmt.Errorf("storage dir not accessible: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("storage path is not a directory: %s", abs)
	}
	dbPath := filepath.Join(abs, "db", "db.sqlite")
	if _, err := os.Stat(dbPath); err != nil {
		return fmt.Errorf("zcode db not found at db/db.sqlite: %w", err)
	}
	return nil
}
