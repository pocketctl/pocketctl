package approval

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
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

	settings := loadSettings(settingsPath)

	// Build the command array. On Windows the binary runs directly; elsewhere
	// the same binary handles the hidden __hook subcommand.
	var command []string
	if runtime.GOOS == "windows" {
		command = []string{pocketctlPath, "__hook"}
	} else {
		command = []string{pocketctlPath, "__hook"}
	}

	// The entry tags itself via "description" (a legitimate Claude settings
	// field) with HookMarker so RemoveHooks can strip only our entries and
	// never a user's hand-written hook.
	entry := map[string]any{
		"matcher":     "", // all tools
		"description": HookMarker,
		"hooks":       []any{map[string]any{"type": "command", "command": command}},
	}

	preToolUse, _ := settings["hooks"].(map[string]any)
	if preToolUse == nil {
		preToolUse = map[string]any{}
	}
	rawArr, _ := preToolUse["PreToolUse"].([]any)

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
	preToolUse["PreToolUse"] = filtered

	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	hooks["PreToolUse"] = filtered
	settings["hooks"] = hooks

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
