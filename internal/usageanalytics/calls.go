package usageanalytics

import (
	"github.com/pocketctl/pocketctl/internal/protocol"
	"strings"
)

// Claude's native tool namespace is mcp__SERVER__TOOL. Other providers must
// provide structured native types; slashes alone convey no classification.
func ClaudeCall(id, name, at string, outcome string) *protocol.CallMetadata {
	if id == "" {
		return nil
	}
	kind := "builtin"
	server := ""
	if strings.HasPrefix(name, "mcp__") {
		parts := strings.SplitN(strings.TrimPrefix(name, "mcp__"), "__", 2)
		if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
			kind = "mcp"
			server = parts[0]
		} else {
			kind = "unknown"
		}
	}
	if name == "" {
		kind = "unknown"
	}
	if outcome == "" {
		outcome = "unknown"
	}
	return &protocol.CallMetadata{Version: 1, InvocationID: id, ToolKind: kind, ToolName: name, MCPServer: server, OccurredAt: at, Outcome: outcome, EvidenceKind: "claude_native_tool"}
}
