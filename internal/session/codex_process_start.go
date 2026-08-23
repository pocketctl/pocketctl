package session

func codexInitializeParams() map[string]any {
	// Standard MCP form and URL elicitations need no opt-in. Do not advertise
	// mcpServerOpenaiFormElicitation: that capability enables a provider-specific
	// schema which Pocketctl intentionally leaves to the official Codex TUI.
	return map[string]any{
		"clientInfo":   map[string]string{"name": "pocketctl", "title": "Pocketctl", "version": "0.3"},
		"capabilities": map[string]any{"experimentalApi": true},
	}
}
