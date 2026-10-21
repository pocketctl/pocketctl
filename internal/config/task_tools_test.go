package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTaskToolsPersistenceAndValidation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, agent := range []string{"codex", "claude-code"} {
		v, err := LoadTaskTools(agent)
		if err != nil || v != nil {
			t.Fatalf("default %s: %v %v", agent, v, err)
		}
		for _, enabled := range []bool{true, false} {
			if err := SaveTaskTools(agent, &enabled); err != nil {
				t.Fatal(err)
			}
			got, err := LoadTaskTools(agent)
			if err != nil || got == nil || *got != enabled {
				t.Fatalf("roundtrip %s: %v %v", agent, got, err)
			}
		}
	}
	if err := SaveTaskTools("claude", nil); err != nil {
		t.Fatal(err)
	}
	if v, _ := LoadTaskTools("claude-code"); v != nil {
		t.Fatal("reset did not restore inherit")
	}
	if v, _ := LoadTaskTools("codex"); v == nil || *v {
		t.Fatal("reset changed another agent")
	}
	if _, err := TaskToolsPath("../codex"); err == nil {
		t.Fatal("accepted invalid agent")
	}
	path, _ := TaskToolsPath("codex")
	for _, invalid := range []string{`{`, `{"version":2,"enabled":true}`, `{"version":1}`, `{"version":1,"enabled":"false"}`, `{"version":1,"enabled":true,"typo":1}`, `{"version":1,"enabled":true} {}`} {
		if err := os.WriteFile(path, []byte(invalid), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadTaskTools("codex"); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
		if _, _, err := ApplyTaskTools("codex", []string{"app-server"}, nil); err == nil {
			t.Fatal("invalid policy silently bypassed")
		}
	}
}

func TestTaskToolsLaunchOverridesAreScopedAndReloaded(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	args := []string{"-p", "--resume", "test", "prompt"}
	env := []string{"KEEP=yes", "CLAUDE_CODE_ENABLE_TODO_TOOLS=0", "CLAUDE_CODE_ENABLE_TODO_TOOLS=1"}
	gotArgs, gotEnv, err := ApplyTaskTools("claude-code", args, env)
	if err != nil || !reflect.DeepEqual(args, gotArgs) || !reflect.DeepEqual(env, gotEnv) {
		t.Fatal("inherit changed launch")
	}
	for _, enabled := range []bool{true, false} {
		for _, agent := range []string{"codex", "claude-code"} {
			if err := SaveTaskTools(agent, &enabled); err != nil {
				t.Fatal(err)
			}
		}
		a, e, err := ApplyTaskTools("claude-code", args, env)
		want := "0"
		if enabled {
			want = "1"
		}
		if err != nil || a[0] != "--settings" || !strings.Contains(a[1], `"CLAUDE_CODE_ENABLE_TODO_TOOLS":"`+want+`"`) || !reflect.DeepEqual(a[2:], args) {
			t.Fatalf("Claude args: %v %v", a, err)
		}
		if !reflect.DeepEqual(e, []string{"KEEP=yes", "CLAUDE_CODE_ENABLE_TODO_TOOLS=" + want}) {
			t.Fatalf("env: %v", e)
		}
		a, _, err = ApplyTaskTools("codex", []string{"app-server", "--listen", "unix://test"}, nil)
		wantBool := "false"
		if enabled {
			wantBool = "true"
		}
		if err != nil || !reflect.DeepEqual(a, []string{"app-server", "-c", "tools.update_plan.enabled=" + wantBool, "--listen", "unix://test"}) {
			t.Fatalf("Codex args: %v %v", a, err)
		}
	}
	if _, _, err := ApplyTaskTools("claude-code", []string{"--settings", "user.json"}, env); err == nil {
		t.Fatal("silently clobbered existing settings")
	}
	a, e, err := ApplyTaskTools("opencode", args, env)
	if err != nil || !reflect.DeepEqual(a, args) || !reflect.DeepEqual(e, env) {
		t.Fatal("unrelated agent changed")
	}
	for _, dir := range []string{".codex", ".claude"} {
		if _, err := os.Stat(filepath.Join(home, dir)); !os.IsNotExist(err) {
			t.Fatal("wrote native global configuration")
		}
	}
}
