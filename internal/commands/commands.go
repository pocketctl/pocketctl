// Package commands enumerates slash commands and skills available for an agent
// session, merging four sources: builtin constants, project (.claude under cwd),
// user (~/.claude), and enabled plugins. The result is surfaced to web clients
// for input autocompletion.
package commands

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// agentClaudeCode is the agent-type string for Claude Code sessions. It mirrors
// adapter.AgentClaude; duplicated here to keep this package free of an adapter
// dependency. The builtin slash-command table (clear/compact/model/…) is Claude
// specific, so it is only injected for this agent type (and unknown/legacy
// types, which default to the Claude code path). Codex and opencode have no
// slash-command surface of their own and must not receive Claude's builtins.
const agentClaudeCode = "claude-code"

// useClaudeBuiltins reports whether the builtin Claude command table applies to
// agentType. Unknown/empty agent types keep the legacy Claude behaviour so
// terminal sessions without a resolved agent (and existing callers) are
// unaffected; codex/opencode opt out.
func useClaudeBuiltins(agentType string) bool {
	switch agentType {
	case "", agentClaudeCode:
		return true
	default:
		return false
	}
}

// ListCommands enumerates slash commands and skills available for a session
// running in cwd, merging builtin + project + user + plugin sources. Results
// are deduplicated by name (first source wins, in builtin > project > user >
// plugin order) and sorted by name.
//
// agentType selects the builtin command set: Claude Code (and unknown/legacy
// types) get the Claude builtins; codex/opencode get none, since their CLIs
// have no slash-command surface and surfacing Claude's would mislead.
func ListCommands(cwd, agentType string, available []string) []protocol.CommandItem {
	home, _ := os.UserHomeDir()
	scanned := listCommands(cwd, home, agentType)

	// No authoritative list from the agent (e.g. terminal session without an
	// init event): fall back to the full filesystem scan.
	if len(available) == 0 {
		return scanned
	}

	// Use the agent's init-reported slash_commands as the authoritative name
	// set — it reflects what's actually available in the -p environment (so
	// /model, /config etc. are correctly absent). Join descriptions/sources
	// from the filesystem scan where available.
	byName := make(map[string]protocol.CommandItem, len(scanned))
	for _, c := range scanned {
		byName[c.Name] = c
	}

	result := make([]protocol.CommandItem, 0, len(available))
	for _, name := range available {
		item := protocol.CommandItem{Name: name}
		if s, ok := byName[name]; ok {
			item.Source = s.Source
			item.Kind = s.Kind
			item.Description = s.Description
			item.ArgHint = s.ArgHint
			item.Namespace = s.Namespace
		} else if i := strings.Index(name, ":"); i > 0 {
			// namespaced command the scan didn't resolve (e.g. a plugin command
			// whose installPath we missed) — still surface it from the agent's list.
			item.Source = "plugin"
			item.Kind = "command"
			item.Namespace = name[:i]
		} else {
			// builtin reported by the agent but not in our static table.
			item.Source = "builtin"
			item.Kind = "command"
		}
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

// listCommands is the testable core of ListCommands, taking an explicit home
// directory so tests can inject a temp directory instead of reading the real one.
func listCommands(cwd, home, agentType string) []protocol.CommandItem {
	var all []protocol.CommandItem
	if useClaudeBuiltins(agentType) {
		all = append(all, builtinCommands()...)
		if cwd != "" {
			all = append(all, scanCommandsAndSkills(filepath.Join(cwd, ".claude"), "project", "")...)
		}
		if home != "" {
			all = append(all, scanCommandsAndSkills(filepath.Join(home, ".claude"), "user", "")...)
		}
		all = append(all, scanPlugins(cwd, home)...)
	}

	seen := make(map[string]bool)
	var result []protocol.CommandItem
	for _, c := range all {
		if c.Name == "" || seen[c.Name] {
			continue
		}
		seen[c.Name] = true
		result = append(result, c)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

// scanCommandsAndSkills scans <base>/commands/**/*.md and <base>/skills/*/SKILL.md.
func scanCommandsAndSkills(base, source, namespace string) []protocol.CommandItem {
	var result []protocol.CommandItem
	result = append(result, scanCommands(filepath.Join(base, "commands"), source, namespace)...)
	result = append(result, scanSkills(filepath.Join(base, "skills"), source, namespace)...)
	return result
}

// scanCommands recursively collects .md files under commandsDir. The command
// name is the file path relative to commandsDir (without .md), with path
// separators turned into ":" (Claude Code convention: fe/lint.md -> fe:lint).
func scanCommands(commandsDir, source, namespace string) []protocol.CommandItem {
	var result []protocol.CommandItem
	_ = filepath.WalkDir(commandsDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		rel, err := filepath.Rel(commandsDir, path)
		if err != nil {
			return nil
		}
		name := strings.TrimSuffix(rel, ".md")
		name = strings.ReplaceAll(name, string(filepath.Separator), ":")
		fm := parseFrontmatter(readFile(path))
		result = append(result, protocol.CommandItem{
			Name:        prefixedName(name, namespace),
			Source:      source,
			Kind:        "command",
			Description: fm.description,
			ArgHint:     fm.argHint,
			Namespace:   namespace,
		})
		return nil
	})
	return result
}

// scanSkills scans each subdirectory of skillsDir for a SKILL.md (matched
// case-insensitively, so both SKILL.md and skill.md are recognised). The
// command name is the frontmatter "name", falling back to the directory name.
func scanSkills(skillsDir, source, namespace string) []protocol.CommandItem {
	var result []protocol.CommandItem
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		skillFile := findSkillFile(filepath.Join(skillsDir, e.Name()))
		if skillFile == "" {
			continue
		}
		fm := parseFrontmatter(readFile(skillFile))
		name := fm.name
		if name == "" {
			name = e.Name() // fallback to directory name
		}
		result = append(result, protocol.CommandItem{
			Name:        prefixedName(name, namespace),
			Source:      source,
			Kind:        "skill",
			Description: fm.description,
			Namespace:   namespace,
		})
	}
	return result
}

// findSkillFile locates the skill definition file inside dir, matching
// "SKILL.md" case-insensitively (handles both SKILL.md and skill.md).
func findSkillFile(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.EqualFold(e.Name(), "SKILL.md") {
			return filepath.Join(dir, e.Name())
		}
	}
	return ""
}

// scanPlugins enumerates commands/skills from enabled plugins, using
// ~/.claude/plugins/installed_plugins.json (installPath) as the source of truth
// and merging enabledPlugins from user + project settings (project overrides
// user; settings.local.json is intentionally ignored). Plugin commands are
// namespaced as <plugin>:<name>.
func scanPlugins(cwd, home string) []protocol.CommandItem {
	if home == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "plugins", "installed_plugins.json"))
	if err != nil {
		return nil
	}
	var installed struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(data, &installed); err != nil {
		return nil
	}

	enabled := mergeEnabledPlugins(cwd, home)

	var result []protocol.CommandItem
	for key, instances := range installed.Plugins {
		if !enabled[key] {
			continue
		}
		pluginName := key
		if i := strings.Index(key, "@"); i > 0 {
			pluginName = key[:i]
		}
		if len(instances) == 0 || instances[0].InstallPath == "" {
			continue
		}
		result = append(result, scanCommandsAndSkills(instances[0].InstallPath, "plugin", pluginName)...)
	}
	return result
}

// mergeEnabledPlugins merges enabledPlugins from user settings
// (~/.claude/settings.json) and project settings (<cwd>/.claude/settings.json),
// with project overriding user. settings.local.json is deliberately ignored
// to match Claude Code's known behavior.
func mergeEnabledPlugins(cwd, home string) map[string]bool {
	enabled := make(map[string]bool)
	if home != "" {
		readEnabledPlugins(filepath.Join(home, ".claude", "settings.json"), enabled)
	}
	if cwd != "" {
		readEnabledPlugins(filepath.Join(cwd, ".claude", "settings.json"), enabled)
	}
	return enabled
}

func readEnabledPlugins(path string, enabled map[string]bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var cfg struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return
	}
	for k, v := range cfg.EnabledPlugins {
		enabled[k] = v
	}
}

// frontmatter holds the subset of YAML frontmatter fields we care about.
type frontmatter struct {
	name        string
	description string
	argHint     string
}

// parseFrontmatter extracts name / description / argument-hint from a simple
// YAML frontmatter block (a leading "---"-delimited section). Only single-line
// scalar values are recognised; nested mappings are skipped. No YAML dependency.
func parseFrontmatter(content string) frontmatter {
	var fm frontmatter
	content = strings.TrimSpace(content)
	const sep = "---"
	if !strings.HasPrefix(content, sep) {
		return fm
	}
	rest := strings.TrimLeft(content[len(sep):], "\r\n")
	// find the closing "---" on its own line
	closeIdx := strings.Index(rest, "\n"+sep)
	if closeIdx < 0 {
		return fm
	}
	block := rest[:closeIdx]
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])
		val = strings.Trim(val, "\"'")
		switch key {
		case "name":
			fm.name = val
		case "description":
			fm.description = val
		case "argument-hint":
			fm.argHint = val
		}
	}
	return fm
}

func prefixedName(name, namespace string) string {
	if namespace == "" {
		return name
	}
	return namespace + ":" + name
}

func readFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

// builtinCommands returns the v1 set of Claude Code built-in slash commands.
// These are compiled into the claude binary and cannot be scanned from disk;
// the list is maintained manually and should be reconciled against the current
// CLI version periodically.
func builtinCommands() []protocol.CommandItem {
	defs := []struct{ name, desc string }{
		{"clear", "清空当前对话上下文"},
		{"compact", "压缩对话历史以释放上下文"},
		{"model", "切换或查看当前模型"},
		{"help", "查看可用命令与帮助"},
		{"resume", "恢复一个已有会话"},
		{"cost", "查看 token 用量与花费"},
		{"config", "打开配置界面"},
		{"agents", "管理子智能体"},
		{"init", "初始化项目的 CLAUDE.md"},
		{"status", "查看账户与登录状态"},
	}
	result := make([]protocol.CommandItem, 0, len(defs))
	for _, d := range defs {
		result = append(result, protocol.CommandItem{
			Name:        d.name,
			Source:      "builtin",
			Kind:        "command",
			Description: d.desc,
		})
	}
	return result
}
