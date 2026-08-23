// Package claudechannel implements the Pocketctl-owned Claude Code Channel
// permission relay. It is deliberately minimal: the package does NOT
// implement a general MCP framework. It only covers the JSON-RPC envelope
// and the handful of methods Claude Code's Channel permission relay needs:
//
//   - initialize / notifications/initialized (handshake)
//   - ping (liveness)
//   - notifications/claude/channel/permission_request (Claude → Channel; a
//     tool-use approval request from the native TUI)
//   - notifications/claude/channel/permission (Channel → Claude; the
//     verdict on the current request, allow/deny, current-call only)
//
// All other methods are ignored at the dispatch layer (debug-logged by
// method name only, never by params). The wire shapes recorded here come
// from the Claude Channels reference and the Task 4 contract spike
// (docs/test-reports/claude-channel-contract-2.1.211.md).
//
// Design §Task 4: "禁止实现通用 MCP 框架".
package claudechannel

import (
	"encoding/json"
	"fmt"
)

const (
	// MCPProtocolVersion is the protocol version string advertised in
	// initialize result. Claude Code expects "2025-06-18" for the current
	// generation of MCP support; Channels experimental capability rides on
	// the same envelope.
	MCPProtocolVersion = "2025-06-18"

	// JSONRPCVersion is the envelope version implemented here.
	JSONRPCVersion = "2.0"

	// MaxJSONRPCFrame is the upper bound on a single JSON-RPC message. The
	// Channel IPC inherits the agentcontrol.MaxFrameSize budget so a
	// malicious/buggy peer cannot exhaust daemon memory.
	MaxJSONRPCFrame = 64 << 10 // 64 KiB

	// MethodInitialize is the standard MCP handshake request.
	MethodInitialize = "initialize"
	// MethodInitialized is the standard MCP initialized notification.
	MethodInitialized = "notifications/initialized"
	// MethodPing is the standard MCP liveness probe.
	MethodPing = "ping"

	// MethodChannelPermissionRequest is emitted by Claude when native tool
	// approval becomes pending. MethodChannelPermission is the distinct verdict
	// notification emitted by the Channel back to Claude.
	MethodChannelPermissionRequest = "notifications/claude/channel/permission_request"
	MethodChannelPermission        = "notifications/claude/channel/permission"
)

// CapabilityKeyChannel and CapabilityKeyChannelPermission are the
// experimental capability keys a Channel server MUST advertise in its
// initialize result so Claude registers it as a permission relay.
//
// The exact wire shape (recorded by the Task 4 contract spike):
//
//	"capabilities": {
//	  "experimental": {
//	    "claude/channel": {},
//	    "claude/channel/permission": {}
//	  }
//	}
const (
	CapabilityKeyChannel           = "claude/channel"
	CapabilityKeyChannelPermission = "claude/channel/permission"
)

// BehaviorAllow / BehaviorDeny are the only verdicts a Channel may emit.
// Both apply to the current call only; there is no "always" / "session"
// variant in the Channels permission relay protocol.
const (
	BehaviorAllow = "allow"
	BehaviorDeny  = "deny"
)

// ValidBehavior reports whether b is one of the two permitted verdicts.
func ValidBehavior(b string) bool {
	return b == BehaviorAllow || b == BehaviorDeny
}

// --- wire types -----------------------------------------------------------

// Request is a JSON-RPC 2.0 request or notification. Notifications carry
// id = nil. The ID may be a string or a number; both are preserved.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response is a JSON-RPC 2.0 response. Exactly one of Result or Error is
// set on success/failure.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError is the standard JSON-RPC error object.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// InitializeParams is the standard MCP initialize request payload. Only the
// fields used by the Channel relay are surfaced; unknown fields are ignored.
type InitializeParams struct {
	ProtocolVersion string          `json:"protocolVersion"`
	ClientInfo      json.RawMessage `json:"clientInfo,omitempty"`
	Capabilities    json.RawMessage `json:"capabilities,omitempty"`
}

// InitializeResult is the Channel server's initialize response. It
// advertises ONLY the experimental Channel/permission capabilities — never
// tools, prompts or resources. The Channel is a permission relay, not a tool
// provider.
type InitializeResult struct {
	ProtocolVersion string          `json:"protocolVersion"`
	Capabilities    ChannelCapsJSON `json:"capabilities"`
	ServerInfo      json.RawMessage `json:"serverInfo,omitempty"`
}

// ChannelCapsJSON advertises ONLY the experimental Channel permission relay
// capability. It MUST NOT advertise tools/resources/prompts.
type ChannelCapsJSON struct {
	Experimental ExperimentalCaps `json:"experimental"`
}

// ExperimentalCaps carries the two Claude-defined experimental keys. The
// values are empty objects per the wire shape recorded by the Task 4
// contract spike.
type ExperimentalCaps struct {
	Channel           json.RawMessage `json:"claude/channel"`
	ChannelPermission json.RawMessage `json:"claude/channel/permission"`
}

// PermissionRequestParams is the payload Claude sends when a tool-use
// approval request surfaces in the native TUI. The short_request_id is
// Claude's 5-letter ID — it is NOT a global identifier or authorization
// credential (design §1.2).
type PermissionRequestParams struct {
	RequestID    string `json:"request_id"`
	ToolName     string `json:"tool_name"`
	Description  string `json:"description"`
	InputPreview string `json:"input_preview"`
}

// PermissionVerdictParams is the payload the Channel sends back to Claude
// with a verdict. behavior is allow|deny; request_id echoes the 5-letter ID
// of the request being answered.
type PermissionVerdictParams struct {
	RequestID string `json:"request_id"`
	Behavior  string `json:"behavior"`
}

// --- helpers --------------------------------------------------------------

// NewInitializeResult builds the canonical Channel initialize result with
// the experimental capabilities set to empty objects (the wire shape).
func NewInitializeResult() InitializeResult {
	return InitializeResult{
		ProtocolVersion: MCPProtocolVersion,
		Capabilities: ChannelCapsJSON{
			Experimental: ExperimentalCaps{
				Channel:           json.RawMessage(`{}`),
				ChannelPermission: json.RawMessage(`{}`),
			},
		},
	}
}

// IsVerdict reports whether params carries a verdict behavior. It is kept as
// a narrow validation/test helper; dispatch uses the two distinct official
// request and verdict method names.
func IsVerdict(params json.RawMessage) bool {
	var probe struct {
		Behavior string `json:"behavior"`
	}
	if err := json.Unmarshal(params, &probe); err != nil {
		return false
	}
	return probe.Behavior != ""
}

// ValidatePermissionRequest checks the four official string fields. Claude's
// request_id is exactly five lowercase letters and omits `l`.
// Description and InputPreview may contain secrets; the caller MUST NOT log
// them and MUST cap previews before any best-effort diagnostic.
func ValidatePermissionRequest(raw json.RawMessage) (PermissionRequestParams, error) {
	var params PermissionRequestParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return params, fmt.Errorf("permission request params: %w", err)
	}
	if !validClaudeRequestID(params.RequestID) || params.ToolName == "" ||
		params.Description == "" || params.InputPreview == "" {
		return params, fmt.Errorf("permission request missing required field")
	}
	return params, nil
}

func validClaudeRequestID(id string) bool {
	if len(id) != 5 {
		return false
	}
	for i := range id {
		if id[i] < 'a' || id[i] > 'z' || id[i] == 'l' {
			return false
		}
	}
	return true
}

// BuildVerdictNotification assembles the JSON-RPC notification the Channel
// sends to Claude with a verdict. Claude correlates it by request_id (the
// five-letter short id); the official verdict has no session_id field.
func BuildVerdictNotification(params PermissionVerdictParams) (Request, error) {
	if !ValidBehavior(params.Behavior) {
		return Request{}, fmt.Errorf("invalid behavior %q", params.Behavior)
	}
	if params.RequestID == "" {
		return Request{}, fmt.Errorf("verdict missing request id")
	}
	body, err := json.Marshal(params)
	if err != nil {
		return Request{}, err
	}
	return Request{
		JSONRPC: JSONRPCVersion,
		Method:  MethodChannelPermission,
		Params:  body,
	}, nil
}

// EncodeFrame marshals a Request/Response to a JSON-RPC frame terminated by
// a newline. The caller MUST enforce MaxJSONRPCFrame on the result.
func EncodeFrame(v any) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if len(body) > MaxJSONRPCFrame {
		return nil, fmt.Errorf("json-rpc frame exceeds %d bytes", MaxJSONRPCFrame)
	}
	return append(body, '\n'), nil
}
