package approval

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
)

// HookMarker is the unique description tag stamped on every PreToolUse entry
// the daemon injects. It lets us find and remove only our own entries on
// cleanup (never touching a user's hand-written hooks).
const HookMarker = "pocketctl-managed-approval"

// EnsureHooks merges the daemon's PreToolUse hook into <cwd>/.claude/settings.local.json
// (creating it if absent). The hook invokes `pocketctl __hook`, which reads
// Claude's hook payload from stdin and blocks on the approval socket. The
// injected entry is tagged with HookMarker so RemoveHooks can strip only ours.
//
// H-7 safety: `.claude` must be a real directory inside cwd (never a symlink)
// and an existing settings file must be a plain regular file. The merged
// content is written to a private temp file in the same directory and renamed
// atomically, so a partial write can never corrupt user settings and no write
// ever follows a symlink. This is idempotent; existing user settings/hooks are
// preserved.
func EnsureHooks(cwd, pocketctlPath string) error {
	settingsDir := filepath.Join(cwd, ".claude")
	if info, err := os.Lstat(settingsDir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf(".claude is a symlink; refusing to write hooks through it")
		}
		if !info.IsDir() {
			return fmt.Errorf(".claude is not a directory")
		}
	} else if os.IsNotExist(err) {
		if err := os.Mkdir(settingsDir, 0o755); err != nil {
			return fmt.Errorf("create .claude dir: %w", err)
		}
	} else {
		return fmt.Errorf("inspect .claude dir: %w", err)
	}
	settingsPath := filepath.Join(settingsDir, "settings.local.json")
	if info, err := os.Lstat(settingsPath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("settings.local.json is a symlink; refusing to overwrite its target")
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("settings.local.json is not a regular file")
		}
	}
	if err := mergeHookEntry(settingsPath, pocketctlPath); err != nil {
		return err
	}
	// The settings file carries a hook command and lives in the user's tree;
	// keep it private to the owner.
	if info, err := os.Lstat(settingsPath); err == nil && info.Mode().IsRegular() {
		_ = os.Chmod(settingsPath, 0o600)
	}
	return nil
}

// EnsureUserHook is retained only for backwards-compatible tooling/tests. New
// daemon and Channel startup paths MUST NOT call it. It merges a PreToolUse
// hook into the USER-GLOBAL
// ~/.claude/settings.json. Unlike EnsureHooks (which is per-project and only
// covers daemon-spawned sessions), this installs a single hook that fires for
// EVERY `claude` invocation the user starts in any terminal — including
// sessions pocketctl didn't spawn. That's how a manually-launched `claude` in
// `default` permission mode can surface its "do you want to proceed?" prompts
// to web/iOS clients: the hook reads `session_id` straight from Claude's
// payload and connects to the user-global approval socket.
//
// The active migration path only calls RemoveUserHook once during explicit
// Claude enable, preserving native fallback when the daemon is absent.
func EnsureUserHook(pocketctlPath string) error {
	home, err := config.HomeDir()
	if err != nil {
		return fmt.Errorf("get home dir: %w", err)
	}
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		return fmt.Errorf("create ~/.claude dir: %w", err)
	}
	settingsPath := filepath.Join(claudeDir, "settings.json")
	return mergeHookEntry(settingsPath, pocketctlPath)
}

// RemoveUserHook strips the daemon-injected PreToolUse entry from the
// USER-GLOBAL ~/.claude/settings.json, leaving any user-authored hooks intact.
// Called during explicit Claude enable to remove entries left by older
// releases; daemon lifecycle no longer mutates this file.
func RemoveUserHook() error {
	home, err := config.HomeDir()
	if err != nil {
		return fmt.Errorf("get home dir: %w", err)
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if _, err := os.Stat(settingsPath); err != nil {
		return nil // nothing to clean
	}
	return stripHookEntry(settingsPath)
}

// mergeHookEntry loads the settings file at path, ensures exactly one
// pocketctl-managed PreToolUse entry exists (dropping any stale copy first),
// and writes it back. Shared by the per-project and user-global installers.
func mergeHookEntry(settingsPath, pocketctlPath string) error {
	settings := loadSettings(settingsPath)

	// Claude Code's hook "command" is a single shell command STRING, not an argv
	// array. Passing an array makes Claude reject the whole settings file
	// ("hooks.PreToolUse.0.hooks.0.command: Expected string, but received array")
	// and pop a blocking startup menu. Quote the binary path so paths containing
	// spaces still execute as one argument; append the hidden __hook subcommand.
	command := quoteCommandPath(pocketctlPath) + " __hook"

	// The entry tags itself via "description" (a legitimate Claude settings
	// field) with HookMarker so RemoveHooks can strip only our entries and
	// never a user's hand-written hook.
	entry := map[string]any{
		"matcher":     "", // all tools
		"description": HookMarker,
		"hooks":       []any{map[string]any{"type": "command", "command": command}},
	}

	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	rawArr, _ := hooks["PreToolUse"].([]any)

	// Drop any pre-existing pocketctl-managed entry, then append the fresh one.
	filtered := make([]any, 0, len(rawArr)+1)
	for _, e := range rawArr {
		if isPocketctlManagedHook(e) {
			continue
		}
		filtered = append(filtered, e)
	}
	filtered = append(filtered, entry)
	hooks["PreToolUse"] = filtered
	settings["hooks"] = hooks

	return saveSettings(settingsPath, settings)
}

// stripHookEntry removes every pocketctl-managed PreToolUse entry from the
// settings file at path. If no hooks remain, the hooks key is dropped for
// tidiness. Shared by the per-project and user-global cleaners.
func stripHookEntry(settingsPath string) error {
	settings, err := loadSettingsStrict(settingsPath)
	if err != nil {
		return err
	}

	hooks, _ := settings["hooks"].(map[string]any)
	arr, _ := hooks["PreToolUse"].([]any)
	if arr == nil {
		return nil
	}

	filtered := make([]any, 0, len(arr))
	for _, e := range arr {
		if isPocketctlManagedHook(e) {
			continue
		}
		filtered = append(filtered, e)
	}

	if len(filtered) == 0 {
		delete(hooks, "PreToolUse")
		if len(hooks) == 0 {
			delete(settings, "hooks")
		}
	} else {
		hooks["PreToolUse"] = filtered
		settings["hooks"] = hooks
	}
	return saveSettings(settingsPath, settings)
}

// isPocketctlManagedHook requires both our marker and the exact legacy
// command shape. A user entry that happens to reuse the description is not
// ours and must survive migration cleanup.
func isPocketctlManagedHook(entry any) bool {
	m, ok := entry.(map[string]any)
	if !ok || m["description"] != HookMarker {
		return false
	}
	hooks, ok := m["hooks"].([]any)
	if !ok || len(hooks) != 1 {
		return false
	}
	hook, ok := hooks[0].(map[string]any)
	if !ok || hook["type"] != "command" {
		return false
	}
	command, ok := hook["command"].(string)
	if !ok || !strings.HasSuffix(strings.TrimSpace(command), " __hook") {
		return false
	}
	path := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(command), " __hook"))
	path = strings.Trim(path, "\"'")
	base := strings.ToLower(filepath.Base(path))
	return base == "pocketctl" || base == "pocketctl.exe"
}

// RemoveHooks strips the daemon-injected PreToolUse entry from <cwd>/.claude/
// settings.local.json, leaving any user-authored hooks intact. If the file
// would end up empty of hooks, the hooks key is removed for tidiness. A
// symlinked settings file is refused — cleanup must not touch its target.
func RemoveHooks(cwd string) error {
	settingsPath := filepath.Join(cwd, ".claude", "settings.local.json")
	info, err := os.Lstat(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // nothing to clean
		}
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("settings.local.json is a symlink; refusing to modify its target")
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("settings.local.json is not a regular file")
	}
	return stripHookEntry(settingsPath)
}

// quoteCommandPath quotes an executable path for embedding in a hook command
// string so paths containing spaces are treated as a single argument by the
// shell Claude Code uses to run hooks. POSIX shells get single-quote wrapping
// (with embedded single quotes escaped); Windows gets double-quote wrapping.
func quoteCommandPath(path string) string {
	if runtime.GOOS == "windows" {
		return `"` + path + `"`
	}
	// POSIX: 'foo'\''bar' style escaping for any embedded single quotes.
	return "'" + strings.ReplaceAll(path, "'", `'\''`) + "'"
}

// loadSettings reads settings.local.json (if present) into a generic map. A
// missing or malformed file yields an empty map (so EnsureHooks can create it).
func loadSettings(path string) map[string]any {
	settings := map[string]any{}
	data, err := os.ReadFile(path)
	if err != nil {
		return settings
	}
	// Best-effort: preserve whatever the user has, even if not an object.
	_ = json.Unmarshal(data, &settings)
	return settings
}

func loadSettingsStrict(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read settings: %w", err)
	}
	settings := map[string]any{}
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, fmt.Errorf("parse settings without modifying it: %w", err)
	}
	return settings, nil
}

// saveSettings writes settings through a same-directory private temp file and
// an atomic rename (H-7): readers observe either the old or the new file, and
// a symlinked destination can never be followed because rename replaces the
// link itself — callers additionally reject symlinks before getting here.
func saveSettings(path string, settings map[string]any) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".settings-*")
	if err != nil {
		return fmt.Errorf("create temp settings: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() {
		if err != nil {
			_ = os.Remove(tmpPath)
		}
	}()
	if err = tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temp settings: %w", err)
	}
	if _, err = tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp settings: %w", err)
	}
	if err = tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync temp settings: %w", err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("close temp settings: %w", err)
	}
	if err = os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("replace settings atomically: %w", err)
	}
	return nil
}
