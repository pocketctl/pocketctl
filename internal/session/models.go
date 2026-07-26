package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func indexOfString(slice []string, val string) int {
	for i, v := range slice {
		if v == val {
			return i
		}
	}
	return -1
}

// stripModelSuffix removes any trailing "[...]" suffix that some config tools
// (e.g. cc switch) append to model names (like "GLM-5.2[1M]"). Such suffixes
// are not valid model identifiers and cause provider API errors.
func stripModelSuffix(s string) string {
	if idx := strings.Index(s, "["); idx > 0 {
		return strings.TrimSpace(s[:idx])
	}
	return s
}

// resolveCleanModel reads ~/.claude/settings.json, resolves the active model
// alias (opus/sonnet/haiku) to its concrete model name via the
// ANTHROPIC_DEFAULT_*_MODEL env mapping, and strips any invalid [...] suffix.
// Returns "" if settings.json is missing or unparseable (claude falls back to
// its own defaults).
func resolveCleanModel() string {
	home, err := config.HomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Model string            `json:"model"`
		Env   map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return ""
	}

	switch strings.ToLower(strings.TrimSpace(cfg.Model)) {
	case "opus":
		return stripModelSuffix(cfg.Env["ANTHROPIC_DEFAULT_OPUS_MODEL"])
	case "sonnet":
		return stripModelSuffix(cfg.Env["ANTHROPIC_DEFAULT_SONNET_MODEL"])
	case "haiku":
		return stripModelSuffix(cfg.Env["ANTHROPIC_DEFAULT_HAIKU_MODEL"])
	default:
		if cfg.Model == "" {
			return ""
		}
		return stripModelSuffix(cfg.Model)
	}
}

// ListAvailableModels reads ~/.claude/settings.json and returns the opus/sonnet/haiku
// alias→concrete-model mapping so the web client can populate its model picker with
// the host's actual available models (not hardcoded aliases). Returns nil if
// settings.json is missing/unparseable.
func ListAvailableModels() []protocol.ModelOption {
	home, err := config.HomeDir()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return nil
	}
	var cfg struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	type slot struct{ alias, nameKey, modelKey string }
	slots := []slot{
		{"opus", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", "ANTHROPIC_DEFAULT_OPUS_MODEL"},
		{"sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", "ANTHROPIC_DEFAULT_SONNET_MODEL"},
		{"haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", "ANTHROPIC_DEFAULT_HAIKU_MODEL"},
	}
	var out []protocol.ModelOption
	for _, s := range slots {
		name := strings.TrimSpace(cfg.Env[s.nameKey])
		if name == "" {
			name = stripModelSuffix(cfg.Env[s.modelKey]) // fall back to raw key, strip any [...] suffix
		}
		if name == "" {
			continue
		}
		out = append(out, protocol.ModelOption{Alias: s.alias, Name: name})
	}
	return out
}

// ListModelsForAgent dispatches model-listing to the right agent source.
// Claude reads ~/.claude/settings.json; codex returns its default model list.
func ListModelsForAgent(agentType string) []protocol.ModelOption {
	switch agentType {
	case adapter.AgentCodex:
		return listCodexModels()
	case adapter.AgentOpencode:
		// opencode models are provider/model and come from its serve API
		// (GET /api/model); surfacing them through this stateless helper needs a
		// running server, so it's deferred. Empty = the client shows no picker and
		// opencode uses its own configured default. NOT the Claude list (which the
		// default branch would wrongly return).
		return nil
	default:
		return ListAvailableModels()
	}
}

// listCodexModels returns the model options for the Codex agent.
//
// Codex's interactive /model picker is backed by ~/.codex/models_cache.json
// (falling back to models_catalog.json). Reading that catalog keeps iOS/web in
// sync with the local Codex install instead of maintaining a version-coupled
// hard-coded list.
func listCodexModels() []protocol.ModelOption {
	preferred := codexConfigModel()
	if out := readCodexModelCatalog(preferred); len(out) > 0 {
		return out
	}
	return codexFallbackModels(preferred)
}

func codexFallbackModels(preferred string) []protocol.ModelOption {
	var out []protocol.ModelOption
	for _, m := range []string{"gpt-5.5", "gpt-5.4", "gpt-5.4-mini"} {
		out = appendModelOption(out, m)
	}
	out = movePreferredFirst(out, preferred)
	return out
}

func readCodexModelCatalog(preferred string) []protocol.ModelOption {
	home, err := config.HomeDir()
	if err != nil {
		return nil
	}
	for _, name := range []string{"models_cache.json", "models_catalog.json"} {
		models := readCodexModelCatalogFile(filepath.Join(home, ".codex", name))
		if len(models) > 0 {
			return movePreferredFirst(models, preferred)
		}
	}
	return nil
}

func readCodexModelCatalogFile(path string) []protocol.ModelOption {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var catalog struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		return nil
	}
	var out []protocol.ModelOption
	for _, m := range catalog.Models {
		if m.Visibility != "list" {
			continue
		}
		out = appendModelOption(out, m.Slug)
	}
	return out
}

func appendModelOption(out []protocol.ModelOption, slug string) []protocol.ModelOption {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return out
	}
	for _, existing := range out {
		if existing.Alias == slug {
			return out
		}
	}
	return append(out, protocol.ModelOption{Alias: slug, Name: slug})
}

func movePreferredFirst(models []protocol.ModelOption, preferred string) []protocol.ModelOption {
	preferred = strings.TrimSpace(preferred)
	if preferred == "" {
		return models
	}
	out := make([]protocol.ModelOption, 0, len(models)+1)
	out = appendModelOption(out, preferred)
	for _, model := range models {
		out = appendModelOption(out, model.Alias)
	}
	return out
}

// codexConfigModel reads the model set in ~/.codex/config.toml (line `model = "x"`),
// returning "" if not set or unreadable. Codex uses TOML, not JSON; we do a
// lightweight scan rather than pulling a TOML dependency for one field.
func codexConfigModel() string {
	home, err := config.HomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "model") {
			continue
		}
		// match: model = "gpt-5.5"  (top-level key)
		if idx := strings.Index(line, "="); idx > 0 {
			val := strings.TrimSpace(line[idx+1:])
			val = strings.Trim(val, `"'`)
			if val != "" && !strings.Contains(val, " ") {
				return val
			}
		}
	}
	return ""
}

// resolveModelAlias maps a claude alias (opus/sonnet/haiku) to its concrete model name
// from ~/.claude/settings.json (e.g. haiku → glm-4.7). Used so /model shows the real
// model, while the alias is still passed to claude's --model (which resolves via
// ANTHROPIC_DEFAULT_*_MODEL, preserving e.g. [1M] context). Non-alias input is returned as-is.
func resolveModelAlias(alias string) string {
	for _, m := range ListAvailableModels() {
		if m.Alias == alias {
			return m.Name
		}
	}
	return alias
}
