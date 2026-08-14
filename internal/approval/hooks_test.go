package approval

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
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
