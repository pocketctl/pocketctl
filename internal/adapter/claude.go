package adapter

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type ClaudeStreamEvent struct {
	Type      string         `json:"type"`
	Subtype   string         `json:"subtype,omitempty"`
	Message   *ClaudeMessage `json:"message,omitempty"`
	SessionID string         `json:"session_id,omitempty"`
	IsError   bool           `json:"is_error,omitempty"`
	Result    string         `json:"result,omitempty"`
	NumTurns  int            `json:"num_turns,omitempty"`
	TotalCost float64        `json:"total_cost_usd,omitempty"`
	// SlashCommands is populated on the init event: the authoritative list of
	// slash commands the agent reports as available in the current environment.
	SlashCommands []string `json:"slash_commands,omitempty"`
}

type ClaudeMessage struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content []ClaudeContent `json:"content"`
}

type ClaudeContent struct {
	Type     string          `json:"type"`
	Text     string          `json:"text,omitempty"`
	Name     string          `json:"name,omitempty"`
	ID       string          `json:"id,omitempty"`
	Input    json.RawMessage `json:"input,omitempty"`
	ToolUseID string         `json:"tool_use_id,omitempty"`
	Thinking  string         `json:"thinking,omitempty"`
}

type ClaudeAdapter struct {
	sessionID     string
	slashCommands []string
}

func NewClaudeAdapter() *ClaudeAdapter {
	return &ClaudeAdapter{}
}

func (a *ClaudeAdapter) ParseStreamLine(line string) ([]protocol.DaemonEvent, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, nil
	}

	var raw ClaudeStreamEvent
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil, fmt.Errorf("parse json: %w", err)
	}

	if raw.Type == "system" && raw.Subtype == "init" && raw.SessionID != "" {
		a.sessionID = raw.SessionID
		a.slashCommands = raw.SlashCommands
	}

	return a.convertEvent(raw)
}

func (a *ClaudeAdapter) SessionID() string {
	return a.sessionID
}

// SlashCommands returns the slash commands reported by the agent in its init
// event — the authoritative list of commands available in the current (-p)
// environment. Empty before init is parsed, or for adapters that never saw one.
func (a *ClaudeAdapter) SlashCommands() []string {
	return a.slashCommands
}

func (a *ClaudeAdapter) convertEvent(raw ClaudeStreamEvent) ([]protocol.DaemonEvent, error) {
	sid := a.sessionID
	switch raw.Type {
	case "system":
		return nil, nil
	case "assistant":
		return a.convertAssistant(raw, sid)
	case "user":
		return a.convertUser(raw, sid)
	case "result":
		return a.convertResult(raw, sid)
	default:
		return nil, nil
	}
}

func (a *ClaudeAdapter) convertAssistant(raw ClaudeStreamEvent, sid string) ([]protocol.DaemonEvent, error) {
	if raw.Message == nil {
		return nil, nil
	}
	var events []protocol.DaemonEvent
	for _, c := range raw.Message.Content {
		switch c.Type {
		case "text":
			events = append(events, protocol.DaemonEvent{
				Type:      "agent_text",
				SessionID: sid,
				Text:      c.Text,
				Streaming: false,
			})
		case "tool_use":
			events = append(events, protocol.DaemonEvent{
				Type:      "tool_call",
				SessionID: sid,
				CallID:    c.ID,
				Tool:      c.Name,
				Input:     c.Input,
			})
		}
	}
	return events, nil
}

func (a *ClaudeAdapter) convertUser(raw ClaudeStreamEvent, sid string) ([]protocol.DaemonEvent, error) {
	if raw.Message == nil {
		return nil, nil
	}
	var events []protocol.DaemonEvent
	for _, c := range raw.Message.Content {
		if c.Type == "tool_result" {
			output := c.Text
			events = append(events, protocol.DaemonEvent{
				Type:      "tool_result",
				SessionID: sid,
				CallID:    c.ToolUseID,
				Output:    output,
			})
		}
	}
	return events, nil
}

func (a *ClaudeAdapter) convertResult(raw ClaudeStreamEvent, sid string) ([]protocol.DaemonEvent, error) {
	status := protocol.StatusCompleted
	if raw.IsError || raw.Subtype == "error" {
		status = protocol.StatusError
	}
	return []protocol.DaemonEvent{{
		Type:      "session_status",
		SessionID: sid,
		Status:    status,
		CostUSD:   raw.TotalCost,
		Turns:     raw.NumTurns,
	}}, nil
}

func BuildClaudeArgs(prompt string, sessionID string, config protocol.SessionConfig) []string {
	args := []string{"-p", prompt}

	if sessionID != "" {
		args = append(args, "--resume", sessionID)
	} else {
		args = append(args, "--session-id", uuid.New().String())
	}

	args = append(args, "--output-format", "stream-json", "--verbose")

	// Use resolved clean model name (cc switch may append invalid [...] suffix)
	if config.Model != "" {
		args = append(args, "--model", config.Model)
	}

	if len(config.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(config.AllowedTools, ","))
	}

	permMode := config.PermissionMode
	if permMode == "" {
		permMode = "acceptEdits"
	}
	args = append(args, "--permission-mode", permMode)

	return args
}
