package adapter

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// JSONL entry structures — Claude Code's session history format
type JSONLEntry struct {
	Type           string        `json:"type"`
	Subtype        string        `json:"subtype,omitempty"`
	SessionID      string        `json:"sessionId"`
	Message        *JSONLMessage `json:"message,omitempty"`
	Content        string        `json:"content,omitempty"`
	PermissionMode string        `json:"permissionMode,omitempty"`
	IsMeta         bool          `json:"isMeta,omitempty"`         // true for meta messages (e.g. local-command-caveat) — filtered from replay
	IsSidechain    bool          `json:"isSidechain,omitempty"`    // true for sub-agent (sidechain) records
	ParentUuid     string        `json:"parentUuid,omitempty"`     // message-level parent UUID (NOT session id; not used for relation)
	CompactResult  string        `json:"compact_result,omitempty"` // /compact outcome: "success" or "failed"
	CompactError   string        `json:"compact_error,omitempty"`  // /compact failure reason
	TotalCost      float64       `json:"total_cost_usd,omitempty"` // result event: aggregated cost
	NumTurns       int           `json:"num_turns,omitempty"`      // result event: turn count
}

type JSONLMessage struct {
	Role    string          `json:"role"`
	Model   string          `json:"model,omitempty"` // "<synthetic>" marks local-command replies
	Content json.RawMessage `json:"content"`
	Usage   *TokenUsage     `json:"usage,omitempty"`
}

// For assistant messages: content is an array of blocks
type JSONLContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	Content   string          `json:"content,omitempty"` // tool_result output
	Name      string          `json:"name,omitempty"`
	ID        string          `json:"id,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
}

// computeTurnCost estimates per-turn cost from usage tokens.
// Uses Sonnet-class pricing (most common model): input $3/M, output $15/M,
// cache read $0.30/M, cache write $3.75/M. Approximate but far better than 0.
func computeTurnCost(u *TokenUsage) float64 {
	if u == nil {
		return 0
	}
	const (
		inputPerM   = 3.0
		outputPerM  = 15.0
		cacheReadM  = 0.30
		cacheWriteM = 3.75
	)
	return (float64(u.InputTokens)*inputPerM +
		float64(u.OutputTokens)*outputPerM +
		float64(u.CacheRead)*cacheReadM +
		float64(u.CacheCreation)*cacheWriteM) / 1_000_000
}

// ParseJSONLLine converts a single JSONL line to DaemonEvents.
func ParseJSONLLine(line string) ([]protocol.DaemonEvent, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, nil
	}

	var entry JSONLEntry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		return nil, fmt.Errorf("parse jsonl: %w", err)
	}

	sid := entry.SessionID

	switch entry.Type {
	case "assistant":
		return parseAssistantJSONL(entry, sid)
	case "user":
		// Filter meta user messages (e.g. <local-command-caveat> injected by
		// local commands) — they are not real user input and shouldn't reach web.
		if entry.IsMeta {
			return nil, nil
		}
		return parseUserJSONL(entry, sid)
	case "system":
		// Local command feedback in history arrives as system subtype "local_command"
		// with content <local-command-stdout>...</local-command-stdout>.
		if entry.Subtype == "local_command" && entry.Content != "" {
			if msg := extractLocalCommandOutput(entry.Content); msg != "" {
				return []protocol.DaemonEvent{{
					Type:          "command_receipt",
					SessionID:     sid,
					ReceiptStatus: inferReceiptStatus(msg, ""),
					Message:       msg,
				}}, nil
			}
		}
		return nil, nil
	case "result":
		// End-of-turn summary with aggregated cost/turns.
		return []protocol.DaemonEvent{{
			Type:      "session_status",
			SessionID: sid,
			Status:    protocol.StatusCompleted,
			CostUSD:   entry.TotalCost,
			Turns:     entry.NumTurns,
		}}, nil
	default:
		// Skip: mode, permission-mode, file-history-snapshot, attachment, etc.
		return nil, nil
	}
}

func parseAssistantJSONL(entry JSONLEntry, sid string) ([]protocol.DaemonEvent, error) {
	if entry.Message == nil {
		return nil, nil
	}

	var blocks []JSONLContentBlock
	if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
		// Content might be a string, not an array — skip
		return nil, nil
	}

	var events []protocol.DaemonEvent
	for _, b := range blocks {
		switch b.Type {
		case "text":
			ev := protocol.DaemonEvent{
				Type:      "agent_text",
				SessionID: sid,
				Text:      b.Text,
				Streaming: false,
				Model:     CleanModelName(entry.Message.Model),
			}
			if u := entry.Message.Usage; u != nil {
				ev.Usage = &protocol.ContextUsage{
					InputTokens:  u.InputTokens,
					OutputTokens: u.OutputTokens,
					CacheRead:    u.CacheRead,
					CacheCreate:  u.CacheCreation,
				}
				// Compute per-turn cost delta from usage tokens (Sonnet pricing)
				ev.CostUSD = computeTurnCost(u)
			}
			events = append(events, ev)
		case "tool_use":
			events = append(events, protocol.DaemonEvent{
				Type:      "tool_call",
				SessionID: sid,
				CallID:    b.ID,
				Tool:      b.Name,
				Input:     b.Input,
			})
		case "thinking":
			// Skip thinking blocks
		}
	}
	return events, nil
}

func parseUserJSONL(entry JSONLEntry, sid string) ([]protocol.DaemonEvent, error) {
	if entry.Message == nil {
		return nil, nil
	}

	// Content might be a string (plain user message) or array (tool_result + text)
	var blocks []JSONLContentBlock
	if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
		// Plain string content — this is a user text message
		var textStr string
		if err2 := json.Unmarshal(entry.Message.Content, &textStr); err2 == nil && textStr != "" {
			return []protocol.DaemonEvent{{
				Type:      "user_text",
				SessionID: sid,
				Text:      textStr,
			}}, nil
		}
		return nil, nil
	}

	var events []protocol.DaemonEvent
	for _, b := range blocks {
		switch b.Type {
		case "text":
			// User text message
			if b.Text != "" {
				events = append(events, protocol.DaemonEvent{
					Type:      "user_text",
					SessionID: sid,
					Text:      b.Text,
				})
			}
		case "tool_result":
			output := b.Content
			if output == "" {
				output = b.Text
			}
			events = append(events, protocol.DaemonEvent{
				Type:      "tool_result",
				SessionID: sid,
				CallID:    b.ToolUseID,
				Output:    output,
			})
		}
	}
	return events, nil
}

// ExtractFirstAssistantMessage returns the text of the first assistant message from JSONL lines.
// Filters out tool_use, tool_result, thinking, and empty responses.
// Truncated to maxLen characters. Returns empty string if no assistant response found.
func ExtractFirstAssistantMessage(lines []string, maxLen int) string {
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry JSONLEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Type != "assistant" || entry.Message == nil || entry.Message.Role != "assistant" {
			continue
		}

		var blocks []JSONLContentBlock
		if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
			continue
		}
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				return truncate(b.Text, maxLen)
			}
		}
	}
	return ""
}

// CleanModelName normalises a raw model identifier from an assistant message:
// trims whitespace and strips a trailing "[...]" suffix (e.g. "GLM-5.2[1M]" →
// "GLM-5.2"). Returns "" for synthetic/empty markers. Shared by the replay,
// PTY-tailer, and --resume paths so agent_text events carry a consistent model.
func CleanModelName(m string) string {
	m = strings.TrimSpace(m)
	if m == "" || m == "<synthetic>" {
		return ""
	}
	if idx := strings.Index(m, "["); idx > 0 { // strip [1M]-style suffix for clean display
		m = strings.TrimSpace(m[:idx])
	}
	return m
}

// ExtractLastAssistantModel returns the model name from the last real (non-synthetic)
// assistant message in the JSONL lines. Used to surface the active model for terminal
// sessions, whose model isn't known at process-discovery time. Returns "" if none.
func ExtractLastAssistantModel(lines []string) string {
	model := ""
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry JSONLEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Type != "assistant" || entry.Message == nil || entry.Message.Role != "assistant" {
			continue
		}
		if m := CleanModelName(entry.Message.Model); m != "" {
			model = m // keep updating → ends as the last real assistant message's model
		}
	}
	return model
}

// ExtractFirstUserMessage returns the text of the first user message from JSONL lines.
// Truncated to maxLen characters.
func ExtractFirstUserMessage(lines []string, maxLen int) string {
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry JSONLEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Type != "user" || entry.Message == nil || entry.Message.Role != "user" {
			continue
		}

		// Try array content first
		var blocks []JSONLContentBlock
		if err := json.Unmarshal(entry.Message.Content, &blocks); err == nil {
			for _, b := range blocks {
				if b.Type == "text" && b.Text != "" {
					if isUserMessage(b.Text) {
						return truncate(b.Text, maxLen)
					}
				}
			}
		}

		// Try string content
		var textStr string
		if err := json.Unmarshal(entry.Message.Content, &textStr); err == nil && textStr != "" {
			if isUserMessage(textStr) {
				return truncate(textStr, maxLen)
			}
		}
	}
	return ""
}

// isUserMessage returns true if the text looks like a real user message
// (not a system command, skill instruction, or meta content).
func isUserMessage(text string) bool {
	// Skip Claude Code internal commands
	if strings.Contains(text, "<command-message>") || strings.Contains(text, "<command-name>") {
		return false
	}
	// Skip local command output
	if strings.Contains(text, "<local-command-") {
		return false
	}
	// Skip interruptions
	if strings.HasPrefix(text, "[Request interrupted") {
		return false
	}
	// Skip skill/tool instructions (very long, structured content)
	if len(text) > 2000 {
		return false
	}
	// Skip very short/empty messages
	if len(strings.TrimSpace(text)) < 2 {
		return false
	}
	return true
}

func truncate(s string, maxLen int) string {
	if maxLen <= 0 {
		maxLen = 60
	}
	// Clean up newlines for title display
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.TrimSpace(s)
	if len(s) > maxLen {
		return s[:maxLen-3] + "..."
	}
	return s
}

// JSONLStreamParser is a stateful wrapper around JSONL parsing that tracks the
// pending slash command (pendingCmd) and /compact outcome, so that synthetic
// assistant replies and local-command feedback can be converted into
// command_receipt events with the correct command name and status — mirroring
// what ClaudeAdapter does for the -p (stream-json) path.
//
// It is held by the PTY session's JSONL tailer; SetPendingCmd is called from
// SessionManager.SendMessage whenever the user sends a slash command via PTY.
type JSONLStreamParser struct {
	pendingCmd    string
	compactStatus string
	compactError  string
}

// NewJSONLStreamParser creates a parser with empty state.
func NewJSONLStreamParser() *JSONLStreamParser {
	return &JSONLStreamParser{}
}

// SetPendingCmd extracts the slash command name from a user message and stores
// it for the next command_receipt. Pass the raw user content (e.g. "/compact"
// or "/model sonnet"). Non-slash content clears the pending command.
func (p *JSONLStreamParser) SetPendingCmd(content string) {
	p.pendingCmd = extractSlashCommand(content)
}

// Parse converts a single JSONL line to DaemonEvents, applying the same
// synthetic→receipt and compact-status logic as ClaudeAdapter.
func (p *JSONLStreamParser) Parse(line string) ([]protocol.DaemonEvent, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, nil
	}

	var entry JSONLEntry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		return nil, fmt.Errorf("parse jsonl: %w", err)
	}

	sid := entry.SessionID

	switch entry.Type {
	case "assistant":
		return p.parseAssistant(entry, sid)
	case "user":
		if entry.IsMeta {
			return nil, nil
		}
		return parseUserJSONL(entry, sid)
	case "system":
		return p.parseSystem(entry, sid)
	case "result":
		// End-of-turn summary with aggregated cost/turns. Previously the PTY
		// path dropped this — forwarding it lets daemon sessions report cost.
		return []protocol.DaemonEvent{{
			Type:      "session_status",
			SessionID: sid,
			Status:    protocol.StatusCompleted,
			CostUSD:   entry.TotalCost,
			Turns:     entry.NumTurns,
		}}, nil
	case "permission-mode":
		// Claude writes this when the user cycles modes via Shift+Tab.
		// Emit a feedback event so the daemon updates ProcessState and web UI syncs.
		mode := strings.TrimSpace(entry.PermissionMode)
		if mode == "" { // tolerate histories produced by older Claude versions
			mode = strings.TrimSpace(entry.Content)
		}
		if mode == "" {
			return nil, nil
		}
		return []protocol.DaemonEvent{{
			Type:                "permission_config_changed",
			SessionID:           sid,
			Permission:          &protocol.PermissionConfig{Agent: AgentClaude, Mode: mode},
			PermissionEffective: "immediate",
		}}, nil
	default:
		return nil, nil
	}
}

// parseAssistant mirrors ClaudeAdapter.convertAssistant: synthetic text blocks
// (model "<synthetic>") become command_receipt, real text becomes agent_text.
func (p *JSONLStreamParser) parseAssistant(entry JSONLEntry, sid string) ([]protocol.DaemonEvent, error) {
	if entry.Message == nil {
		return nil, nil
	}

	isSynthetic := entry.Message.Model == "<synthetic>"

	var blocks []JSONLContentBlock
	if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
		return nil, nil
	}

	var events []protocol.DaemonEvent
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if isSynthetic {
				// Local command reply → receipt (not a confusing plain bubble)
				events = append(events, p.makeReceipt(sid, b.Text))
			} else {
				ev := protocol.DaemonEvent{
					Type:      "agent_text",
					SessionID: sid,
					Text:      b.Text,
					Streaming: false,
					Model:     CleanModelName(entry.Message.Model),
				}
				if u := entry.Message.Usage; u != nil {
					ev.Usage = &protocol.ContextUsage{
						InputTokens:  u.InputTokens,
						OutputTokens: u.OutputTokens,
						CacheRead:    u.CacheRead,
						CacheCreate:  u.CacheCreation,
					}
					// Compute per-turn cost delta from usage tokens (Sonnet pricing)
					ev.CostUSD = computeTurnCost(u)
				}
				events = append(events, ev)
			}
		case "tool_use":
			events = append(events, protocol.DaemonEvent{
				Type:      "tool_call",
				SessionID: sid,
				CallID:    b.ID,
				Tool:      b.Name,
				Input:     b.Input,
			})
		case "thinking":
			// Skip thinking blocks
		}
	}
	return events, nil
}

// parseSystem caches /compact status and turns local_command feedback into a
// command_receipt (mirrors ClaudeAdapter.convertSystem).
func (p *JSONLStreamParser) parseSystem(entry JSONLEntry, sid string) ([]protocol.DaemonEvent, error) {
	if entry.CompactResult != "" {
		p.compactStatus = entry.CompactResult
		p.compactError = entry.CompactError
	}
	if entry.Subtype == "local_command" && entry.Content != "" {
		if msg := extractLocalCommandOutput(entry.Content); msg != "" {
			return []protocol.DaemonEvent{p.makeReceipt(sid, msg)}, nil
		}
	}
	return nil, nil
}

// makeReceipt builds a command_receipt from synthetic/local-command text,
// inferring status from the text + cached compact status. Mirrors
// ClaudeAdapter.makeReceipt but uses the parser's own pendingCmd.
func (p *JSONLStreamParser) makeReceipt(sid, text string) protocol.DaemonEvent {
	status := inferReceiptStatus(text, p.compactStatus)
	msg := text
	if status == "failed" && p.compactError != "" {
		msg = p.compactError
	}
	cmd := ""
	if p.pendingCmd != "" {
		cmd = "/" + p.pendingCmd
	}
	// Consume the pending command — one receipt per slash invocation.
	p.pendingCmd = ""
	p.compactStatus = ""
	p.compactError = ""
	return protocol.DaemonEvent{
		Type:          "command_receipt",
		SessionID:     sid,
		Command:       cmd,
		ReceiptStatus: status,
		Message:       msg,
	}
}
