package main

import (
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func newTerminalHydrationTailer(path, sessionID, parserAgent string) (*watcher.JSONLTailer, error) {
	if parserAgent == adapter.AgentClaude && watcher.ClaudeJSONLV2Enabled() {
		return watcher.NewClaudeJSONLTailerFromStart(path, sessionID)
	}
	if parserAgent == adapter.AgentCodex {
		return watcher.NewCodexObserverJSONLTailerFromStart(path)
	}
	return watcher.NewJSONLTailerFromStart(path, parserAgent)
}
