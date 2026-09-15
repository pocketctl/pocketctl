package session

import (
	"strings"

	"github.com/pocketctl/pocketctl/internal/adapter"
)

func codexAppServerEnv(env []string) []string {
	return sanitizePTYEnv(env, adapter.AgentCodex)
}

func codexCommandEnvironment(base, selected []string) []string {
	overridden := make(map[string]struct{}, len(selected))
	for _, item := range selected {
		if index := strings.IndexByte(item, '='); index > 0 {
			overridden[item[:index]] = struct{}{}
		}
	}
	out := make([]string, 0, len(base)+len(selected))
	for _, item := range base {
		index := strings.IndexByte(item, '=')
		if index <= 0 {
			continue
		}
		if _, exists := overridden[item[:index]]; exists {
			continue
		}
		out = append(out, item)
	}
	return append(out, selected...)
}

func codexInitializeParams() map[string]any {
	// Standard MCP form and URL elicitations need no opt-in. Do not advertise
	// mcpServerOpenaiFormElicitation: that capability enables a provider-specific
	// schema which Pocketctl intentionally leaves to the official Codex TUI.
	return map[string]any{
		"clientInfo":   map[string]string{"name": "pocketctl", "title": "Pocketctl", "version": "0.3"},
		"capabilities": map[string]any{"experimentalApi": true},
	}
}
