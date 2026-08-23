package approval

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRemoveUserHookDeletesOnlyPocketctlMarkerAndCommand(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(claudeDir, "settings.json")
	exactCommand := "'/opt/pocketctl' __hook"
	settings := map[string]any{
		"custom": map[string]any{"preserve": true},
		"hooks": map[string]any{
			"PostToolUse": []any{map[string]any{"description": "third-party"}},
			"PreToolUse": []any{
				map[string]any{"description": "third-party", "hooks": []any{map[string]any{"type": "command", "command": "other hook"}}},
				map[string]any{"description": HookMarker, "hooks": []any{map[string]any{"type": "command", "command": "user-owned command"}}},
				map[string]any{"description": HookMarker, "hooks": []any{map[string]any{"type": "command", "command": exactCommand}}},
			},
		},
	}
	raw, _ := json.Marshal(settings)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveUserHook(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("settings permissions changed to %o", info.Mode().Perm())
	}
	updatedRaw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var updated map[string]any
	if err := json.Unmarshal(updatedRaw, &updated); err != nil {
		t.Fatal(err)
	}
	if _, ok := updated["custom"]; !ok {
		t.Fatal("unknown top-level field was removed")
	}
	hooks := updated["hooks"].(map[string]any)
	pre := hooks["PreToolUse"].([]any)
	if len(pre) != 2 {
		t.Fatalf("PreToolUse=%+v, want third-party and marker-with-user-command preserved", pre)
	}
	if _, ok := hooks["PostToolUse"]; !ok {
		t.Fatal("unrelated hook group was removed")
	}
}

func TestRemoveUserHookPreservesMalformedSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(claudeDir, "settings.json")
	original := []byte(`{"hooks": invalid user content`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveUserHook(); err == nil {
		t.Fatal("malformed settings must return an error so the caller can warn")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, original) {
		t.Fatalf("malformed settings were rewritten: %q", after)
	}
}

// --- H-7: hook installation must never write through symlinks ---

func TestEnsureHooksRejectsSymlinkedClaudeDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink fixture")
	}
	base := t.TempDir()
	target := filepath.Join(base, "target")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	cwd := filepath.Join(base, "repo")
	if err := os.Mkdir(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(cwd, ".claude")); err != nil {
		t.Fatal(err)
	}

	if err := EnsureHooks(cwd, "/usr/local/bin/pocketctl"); err == nil {
		t.Fatal("EnsureHooks must refuse a symlinked .claude directory")
	}
	if _, err := os.Stat(filepath.Join(target, "settings.local.json")); !os.IsNotExist(err) {
		t.Fatal("hook installation wrote through the symlink into the target")
	}
}

func TestEnsureHooksRejectsSymlinkedSettingsFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink fixture")
	}
	base := t.TempDir()
	cwd := filepath.Join(base, "repo")
	if err := os.MkdirAll(filepath.Join(cwd, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(base, "victim.json")
	if err := os.WriteFile(victim, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(cwd, ".claude", "settings.local.json")); err != nil {
		t.Fatal(err)
	}

	if err := EnsureHooks(cwd, "/usr/local/bin/pocketctl"); err == nil {
		t.Fatal("EnsureHooks must refuse a symlinked settings.local.json")
	}
	data, err := os.ReadFile(victim)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "pocketctl") {
		t.Fatal("hook installation overwrote the symlink target")
	}
}

func TestEnsureHooksWritesAtomicallyAndPreservesUserSettings(t *testing.T) {
	cwd := t.TempDir()
	settingsDir := filepath.Join(cwd, ".claude")
	if err := os.MkdirAll(settingsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(settingsDir, "settings.local.json")
	if err := os.WriteFile(settingsPath, []byte(`{"model":"opus"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureHooks(cwd, "/usr/local/bin/pocketctl"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["model"] != "opus" {
		t.Fatal("user settings must survive hook installation")
	}
	hooks, _ := parsed["hooks"].(map[string]any)
	arr, _ := hooks["PreToolUse"].([]any)
	if len(arr) != 1 {
		t.Fatalf("exactly one managed hook expected, got %d", len(arr))
	}
	// No temp files may linger next to the settings file.
	entries, err := os.ReadDir(settingsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("settings dir must contain only settings.local.json, got %d entries", len(entries))
	}
}

func TestRemoveHooksRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink fixture")
	}
	base := t.TempDir()
	cwd := filepath.Join(base, "repo")
	if err := os.MkdirAll(filepath.Join(cwd, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(base, "victim.json")
	if err := os.WriteFile(victim, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(cwd, ".claude", "settings.local.json")); err != nil {
		t.Fatal(err)
	}

	if err := RemoveHooks(cwd); err == nil {
		t.Fatal("RemoveHooks must refuse a symlinked settings file")
	}
}
