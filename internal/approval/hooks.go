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
// This is idempotent: repeated calls do not duplicate the entry. Existing user
// settings/hooks are preserved.
func EnsureHooks(cwd, pocketctlPath string) error {
	settingsDir := filepath.Join(cwd, ".claude")
	if err := os.MkdirAll(settingsDir, 0755); err != nil {
		return fmt.Errorf("create .claude dir: %w", err)
	}
	settingsPath := filepath.Join(settingsDir, "settings.local.json")
	return mergeHookEntry(settingsPath, pocketctlPath)
}

// EnsureUserHook merges the daemon's PreToolUse hook into the USER-GLOBAL
// ~/.claude/settings.json. Unlike EnsureHooks (which is per-project and only
// covers daemon-spawned sessions), this installs a single hook that fires for
// EVERY `claude` invocation the user starts in any terminal — including
// sessions pocketctl didn't spawn. That's how a manually-launched `claude` in
// `default` permission mode can surface its "do you want to proceed?" prompts
// to web/iOS clients: the hook reads `session_id` straight from Claude's
// payload and connects to the user-global approval socket.
//
// Safe to call on every daemon start: idempotent (deduped by HookMarker) and
// preserves any user-authored hooks. Pair with RemoveUserHook on shutdown.
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
// Called on daemon shutdown so we don't leave a dangling hook pointing at a
// daemon that's no longer running.
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
		if m, ok := e.(map[string]any); ok {
			if d, _ := m["description"].(string); d == HookMarker {
				continue
			}
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
	settings := loadSettings(settingsPath)

	hooks, _ := settings["hooks"].(map[string]any)
	arr, _ := hooks["PreToolUse"].([]any)
	if arr == nil {
		return nil
	}

	filtered := make([]any, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(map[string]any); ok {
			if d, _ := m["description"].(string); d == HookMarker {
				continue
			}
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

// RemoveHooks strips the daemon-injected PreToolUse entry from <cwd>/.claude/
// settings.local.json, leaving any user-authored hooks intact. If the file
// would end up empty of hooks, the hooks key is removed for tidiness.
func RemoveHooks(cwd string) error {
	settingsPath := filepath.Join(cwd, ".claude", "settings.local.json")
	if _, err := os.Stat(settingsPath); err != nil {
		return nil // nothing to clean
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

func saveSettings(path string, settings map[string]any) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}
