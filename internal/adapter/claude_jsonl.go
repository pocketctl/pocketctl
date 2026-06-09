package adapter

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// JSONL entry structures — Claude Code's session history format
type JSONLEntry struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"`
	Message   *JSONLMessage   `json:"message,omitempty"`
}

type JSONLMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// For assistant messages: content is an array of blocks
type JSONLContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	Content   string          `json:"content,omitempty"`   // tool_result output
	Name      string          `json:"name,omitempty"`
	ID        string          `json:"id,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
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
		return parseUserJSONL(entry, sid)
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
			events = append(events, protocol.DaemonEvent{
				Type:      "agent_text",
				SessionID: sid,
				Text:      b.Text,
				Streaming: false,
			})
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
