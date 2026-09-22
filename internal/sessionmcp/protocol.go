// Package sessionmcp implements the local read-only Session History MCP
// server, its user-private daemon IPC, and the correlated Relay broker.
package sessionmcp

import "github.com/pocketctl/pocketctl/internal/protocol"

const (
	maxMCPFrameBytes = 64 * 1024
	maxIPCFrameBytes = 384 * 1024
)

const ToolName = protocol.SessionHistoryToolName

type IpcReadRequest struct {
	Type            string `json:"type,omitempty"`
	SourceSessionID string `json:"source_session_id"`
	TargetSessionID string `json:"target_session_id"`
	Cursor          string `json:"cursor,omitempty"`
}

type IpcReadResponse struct {
	Result *protocol.SessionHistoryReadResult `json:"result,omitempty"`
	Error  string                             `json:"error,omitempty"`
}

func boundedCode(code string) string {
	switch code {
	case "unauthenticated", "invalid_request", "invalid_cursor",
		"not_found_or_not_owned", "feature_disabled", "tool_not_allowed", "timeout":
		return code
	default:
		return "internal_error"
	}
}
