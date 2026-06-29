package commands

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", p, err)
	}
}

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
}

// 7.1 frontmatter parsing
func TestParseFrontmatter(t *testing.T) {
	fm := parseFrontmatter("---\nname: foo\ndescription: do a thing\nargument-hint: <file>\n---\nbody")
	if fm.name != "foo" || fm.description != "do a thing" || fm.argHint != "<file>" {
		t.Fatalf("unexpected frontmatter: %+v", fm)
	}

	// no frontmatter
	if got := parseFrontmatter("just body text"); got.name != "" || got.description != "" {
		t.Fatalf("expected empty frontmatter, got %+v", got)
	}

	// quoted values are unquoted
	fm3 := parseFrontmatter("---\nname: \"bar\"\ndescription: 'quoted desc'\n---\n")
	if fm3.name != "bar" || fm3.description != "quoted desc" {
		t.Fatalf("quoted parse failed: %+v", fm3)
	}

	// missing optional fields
	fm4 := parseFrontmatter("---\nname: baz\n---\n")
	if fm4.name != "baz" || fm4.description != "" || fm4.argHint != "" {
		t.Fatalf("missing-field parse failed: %+v", fm4)
	}
}

// 7.2 skills scanning — case-insensitive SKILL.md + name from frontmatter
func TestScanSkillsCaseInsensitive(t *testing.T) {
	dir := t.TempDir()

	// uppercase SKILL.md
	mustMkdir(t, filepath.Join(dir, "skillA"))
	writeFile(t, filepath.Join(dir, "skillA", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\n")

	// lowercase skill.md — the real-world pitfall (pocket-release uses this)
	mustMkdir(t, filepath.Join(dir, "skillB"))
	writeFile(t, filepath.Join(dir, "skillB", "skill.md"), "---\nname: beta\ndescription: B\n---\n")

	// directory without a skill file — must be skipped
	mustMkdir(t, filepath.Join(dir, "noSkill"))

	items := scanSkills(dir, "project", "")
	if len(items) != 2 {
		t.Fatalf("expected 2 skills (case-insensitive), got %d: %+v", len(items), items)
	}
	names := map[string]protocol.CommandItem{}
	for _, it := range items {
		names[it.Name] = it
	}
	if _, ok := names["alpha"]; !ok {
		t.Fatalf("missing alpha (uppercase SKILL.md): %+v", names)
	}
	if _, ok := names["beta"]; !ok {
		t.Fatalf("missing beta (lowercase skill.md): %+v", names)
	}
	for _, it := range items {
		if it.Kind != "skill" {
			t.Fatalf("expected kind=skill, got %s", it.Kind)
		}
	}
}

// 7.2b skill name falls back to directory name when frontmatter lacks "name"
func TestScanSkillNameFallbackToDir(t *testing.T) {
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, "no-frontmatter-name"))
	writeFile(t, filepath.Join(dir, "no-frontmatter-name", "SKILL.md"), "---\ndescription: d\n---\n")
	items := scanSkills(dir, "project", "")
	if len(items) != 1 || items[0].Name != "no-frontmatter-name" {
		t.Fatalf("expected fallback to dir name, got %+v", items)
	}
}

// 7.3 enabledPlugins merge — project overrides user, local.json ignored
func TestMergeEnabledPlugins(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	mustMkdir(t, filepath.Join(home, ".claude"))
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"enabledPlugins":{"a@mp":true,"b@mp":true}}`)

	mustMkdir(t, filepath.Join(cwd, ".claude"))
	// project disables b (override) and enables c
	writeFile(t, filepath.Join(cwd, ".claude", "settings.json"),
		`{"enabledPlugins":{"b@mp":false,"c@mp":true}}`)
	// settings.local.json is intentionally ignored — putting an entry here must have no effect
	writeFile(t, filepath.Join(cwd, ".claude", "settings.local.json"),
		`{"enabledPlugins":{"localonly@mp":true}}`)

	enabled := mergeEnabledPlugins(cwd, home)

	if !enabled["a@mp"] {
		t.Fatal("user-enabled a@mp should remain enabled")
	}
	if enabled["b@mp"] {
		t.Fatal("project should override and disable b@mp")
	}
	if !enabled["c@mp"] {
		t.Fatal("project-enabled c@mp should be enabled")
	}
	if enabled["localonly@mp"] {
		t.Fatal("settings.local.json must be ignored")
	}
}

// 7.4 ListCommands integration — four sources, plugin namespace, dedup
func TestListCommandsIntegration(t *testing.T) {
	cwd := t.TempDir()
	home := t.TempDir()

	// project command
	mustMkdir(t, filepath.Join(cwd, ".claude", "commands"))
	writeFile(t, filepath.Join(cwd, ".claude", "commands", "optimize.md"),
		"---\ndescription: optimize code\nargument-hint: <file>\n---\n")

	// project skill
	mustMkdir(t, filepath.Join(cwd, ".claude", "skills", "my-skill"))
	writeFile(t, filepath.Join(cwd, ".claude", "skills", "my-skill", "SKILL.md"),
		"---\nname: my-skill\ndescription: a skill\n---\n")

	// plugin: installPath + enabled
	pluginPath := filepath.Join(home, ".claude", "plugins", "cache", "mp", "myplug", "1.0")
	mustMkdir(t, filepath.Join(pluginPath, "commands"))
	writeFile(t, filepath.Join(pluginPath, "commands", "deploy.md"),
		"---\ndescription: deploy\n---\n")
	mustMkdir(t, filepath.Join(home, ".claude", "plugins"))
	writeFile(t, filepath.Join(home, ".claude", "plugins", "installed_plugins.json"),
		`{"plugins":{"myplug@mp":[{"installPath":"`+pluginPath+`"}]}}`)
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"enabledPlugins":{"myplug@mp":true}}`)

	items := listCommands(cwd, home, "")
	got := map[string]protocol.CommandItem{}
	for _, it := range items {
		got[it.Name] = it
	}

	// builtin
	if it, ok := got["clear"]; !ok {
		t.Fatal("missing builtin /clear")
	} else if it.Source != "builtin" || it.Kind != "command" {
		t.Fatalf("builtin wrong source/kind: %+v", it)
	}

	// project command
	if it, ok := got["optimize"]; !ok {
		t.Fatal("missing project command optimize")
	} else if it.Source != "project" || it.Kind != "command" || it.ArgHint != "<file>" {
		t.Fatalf("project command wrong: %+v", it)
	}

	// project skill
	if it, ok := got["my-skill"]; !ok {
		t.Fatal("missing project skill my-skill")
	} else if it.Kind != "skill" {
		t.Fatalf("skill wrong kind: %+v", it)
	}

	// plugin namespaced command
	it, ok := got["myplug:deploy"]
	if !ok {
		t.Fatalf("missing plugin command myplug:deploy, got: %+v", got)
	}
	if it.Source != "plugin" || it.Namespace != "myplug" {
		t.Fatalf("plugin wrong source/namespace: %+v", it)
	}
}

// 7.4b disabled plugin is excluded
func TestDisabledPluginExcluded(t *testing.T) {
	home := t.TempDir()
	pluginPath := filepath.Join(home, ".claude", "plugins", "cache", "mp", "offplug", "1.0")
	mustMkdir(t, filepath.Join(pluginPath, "commands"))
	writeFile(t, filepath.Join(pluginPath, "commands", "secret.md"), "---\ndescription: s\n---\n")
	mustMkdir(t, filepath.Join(home, ".claude", "plugins"))
	writeFile(t, filepath.Join(home, ".claude", "plugins", "installed_plugins.json"),
		`{"plugins":{"offplug@mp":[{"installPath":"`+pluginPath+`"}]}}`)
	// NOT enabled
	writeFile(t, filepath.Join(home, ".claude", "settings.json"), `{}`)

	for _, it := range listCommands("", home, "") {
		if it.Name == "offplug:secret" {
			t.Fatal("disabled plugin command should not appear")
		}
	}
}

// ListCommands uses the agent's available list as the authoritative name set,
// so commands not in it (e.g. /model, /config — unavailable in -p mode) are
// excluded even though they exist in the static builtin table.
func TestListCommandsFiltersByAvailable(t *testing.T) {
	cwd := t.TempDir()
	// project command + skill (provide descriptions via scan)
	mustMkdir(t, filepath.Join(cwd, ".claude", "commands"))
	writeFile(t, filepath.Join(cwd, ".claude", "commands", "optimize.md"),
		"---\ndescription: optimize code\n---\n")
	mustMkdir(t, filepath.Join(cwd, ".claude", "skills", "my-skill"))
	writeFile(t, filepath.Join(cwd, ".claude", "skills", "my-skill", "SKILL.md"),
		"---\nname: my-skill\ndescription: a skill\n---\n")

	// available mimics the agent's init slash_commands: clear/compact present,
	// but model/config ABSENT (not available in -p mode), plus our project items.
	available := []string{"clear", "compact", "my-skill", "optimize"}

	items := ListCommands(cwd, "", available)
	got := map[string]protocol.CommandItem{}
	for _, it := range items {
		got[it.Name] = it
	}

	// builtin clear/compact surfaced (from available)
	if _, ok := got["clear"]; !ok {
		t.Fatal("clear should be present (in agent's available list)")
	}
	if _, ok := got["compact"]; !ok {
		t.Fatal("compact should be present")
	}
	// project skill/command get description/kind from scan
	if got["my-skill"].Kind != "skill" || got["my-skill"].Description != "a skill" {
		t.Fatalf("my-skill wrong: %+v", got["my-skill"])
	}
	if got["optimize"].Kind != "command" || got["optimize"].Description != "optimize code" {
		t.Fatalf("optimize wrong: %+v", got["optimize"])
	}

	// /model, /config are in the static builtin table but NOT in available -> excluded
	if _, ok := got["model"]; ok {
		t.Fatal("model must be excluded: agent reports it unavailable in -p mode")
	}
	if _, ok := got["config"]; ok {
		t.Fatal("config must be excluded: not in agent's available list")
	}
}

// ListCommands falls back to the full scan when no available list is provided
// (e.g. terminal session that never emitted an init event).
func TestListCommandsFallbackWithoutAvailable(t *testing.T) {
	cwd := t.TempDir()
	items := ListCommands(cwd, "", nil)
	got := map[string]bool{}
	for _, it := range items {
		got[it.Name] = true
	}
	// fallback includes the static builtin table (model etc.)
	if !got["clear"] {
		t.Fatal("fallback should include builtin clear")
	}
}

// ListCommands excludes Claude-specific builtins for non-Claude agents. Codex
// and opencode have no slash-command surface, so when their init never reports
// available commands the fallback must NOT surface Claude builtins like
// /clear, /model, /config — only project/user/plugin disk-scanned commands.
func TestListCommandsExcludesClaudeBuiltinsForCodex(t *testing.T) {
	cwd := t.TempDir()
	// a real project command should still appear
	mustMkdir(t, filepath.Join(cwd, ".claude", "commands"))
	writeFile(t, filepath.Join(cwd, ".claude", "commands", "optimize.md"),
		"---\ndescription: optimize code\n---\n")

	items := ListCommands(cwd, "codex", nil)
	got := map[string]bool{}
	for _, it := range items {
		got[it.Name] = true
	}

	// Claude builtins must be absent for codex
	for _, name := range []string{"clear", "compact", "model", "config", "agents", "help", "cost", "init", "resume", "status"} {
		if got[name] {
			t.Fatalf("Claude builtin /%s must be excluded for codex agent", name)
		}
	}
	// project command survives
	if !got["optimize"] {
		t.Fatal("project command optimize should still appear for codex")
	}
}

// opencode likewise must not receive Claude builtins.
func TestListCommandsExcludesClaudeBuiltinsForOpencode(t *testing.T) {
	items := ListCommands("", "opencode", nil)
	for _, it := range items {
		if it.Source == "builtin" {
			t.Fatalf("opencode must not receive Claude builtins, got %+v", it)
		}
	}
}
