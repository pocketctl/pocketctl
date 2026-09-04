package adapter

import (
	"github.com/pocketctl/pocketctl/internal/memorycontext"
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
	IsMeta    bool           `json:"isMeta,omitempty"`
	Result    string         `json:"result,omitempty"`
	NumTurns  int            `json:"num_turns,omitempty"`
	TotalCost float64        `json:"total_cost_usd,omitempty"`
	// SlashCommands is populated on the init event: the authoritative list of
	// slash commands the agent reports as available in the current environment.
	SlashCommands []string `json:"slash_commands,omitempty"`
	// System status fields (e.g. /compact progress and result).
	Status        string `json:"status,omitempty"`
	CompactResult string `json:"compact_result,omitempty"`
	CompactError  string `json:"compact_error,omitempty"`
	// Content carries the payload of system local_command events
	// (<local-command-stdout>...</local-command-stdout>) — the real format of
	// local command feedback on --resume sessions.
	Content string `json:"content,omitempty"`
}

type ClaudeMessage struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Model   string          `json:"model,omitempty"` // "<synthetic>" marks local command output (not real LLM)
	Content []ClaudeContent `json:"content"`
	Usage   *TokenUsage     `json:"usage,omitempty"`
}

// TokenUsage mirrors Anthropic API's usage object (present on every assistant
// message in both stream-json and JSONL output).
type TokenUsage struct {
	InputTokens   int `json:"input_tokens,omitempty"`
	OutputTokens  int `json:"output_tokens,omitempty"`
	CacheCreation int `json:"cache_creation_input_tokens,omitempty"`
	CacheRead     int `json:"cache_read_input_tokens,omitempty"`
}

type ClaudeContent struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	Name      string          `json:"name,omitempty"`
	ID        string          `json:"id,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Thinking  string          `json:"thinking,omitempty"`
}

type ClaudeAdapter struct {
	sessionID     string
	slashCommands []string
	// pendingCmd is the slash command being executed this spawn (e.g. "compact"),
	// without the leading "/". Empty when the prompt is not a slash command.
	pendingCmd string
	// compactStatus caches /compact's compact_result (success/failed) seen in
	// system events, so the synthetic reply can be mapped to the right status.
	compactStatus string
	compactError  string
}

// NewClaudeAdapter creates an adapter for a single `claude -p` spawn. prompt is
// the user message sent to the agent; if it starts with "/", the adapter tracks
// it as a pending slash command so the agent's synthetic reply can be turned
// into a command_receipt instead of a confusing agent_text bubble.
func NewClaudeAdapter(prompt string) *ClaudeAdapter {
	return &ClaudeAdapter{pendingCmd: extractSlashCommand(prompt)}
}

// extractSlashCommand returns the command name (no leading "/", no args) when
// the prompt is a slash command, else "".
func extractSlashCommand(prompt string) string {
	s := strings.TrimSpace(prompt)
	if !strings.HasPrefix(s, "/") {
		return ""
	}
	rest := s[1:]
	for i, c := range rest {
		if c == ' ' || c == '\t' || c == '\n' {
			return rest[:i]
		}
	}
	return rest
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
		return a.convertSystem(raw, sid)
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

// convertSystem caches /compact's compact_result and turns local command feedback
// (system subtype "local_command", content <local-command-stdout>...) into a
// command_receipt. Other system events (status/init/etc.) produce no forwarded events.
func (a *ClaudeAdapter) convertSystem(raw ClaudeStreamEvent, sid string) ([]protocol.DaemonEvent, error) {
	if raw.CompactResult != "" {
		a.compactStatus = raw.CompactResult
		a.compactError = raw.CompactError
	}
	// Local command feedback on --resume sessions arrives as a system event with
	// subtype "local_command" and content wrapped in <local-command-stdout>.
	if raw.Subtype == "local_command" && raw.Content != "" {
		if msg := extractLocalCommandOutput(raw.Content); msg != "" {
			return []protocol.DaemonEvent{a.makeReceipt(sid, msg)}, nil
		}
	}
	return nil, nil
}

func (a *ClaudeAdapter) convertAssistant(raw ClaudeStreamEvent, sid string) ([]protocol.DaemonEvent, error) {
	if raw.Message == nil {
		return nil, nil
	}
	isSynthetic := raw.Message.Model == "<synthetic>"
	var events []protocol.DaemonEvent
	for _, c := range raw.Message.Content {
		switch c.Type {
		case "text":
			if isSynthetic {
				// Local command feedback → command_receipt (not agent_text), so the
				// web shows a receipt card instead of a confusing plain bubble.
				events = append(events, a.makeReceipt(sid, c.Text))
			} else {
				ev := protocol.DaemonEvent{
					Type:      "agent_text",
					SessionID: sid,
					Text:      c.Text,
					Streaming: false,
					Model:     CleanModelName(raw.Message.Model),
				}
				if u := raw.Message.Usage; u != nil {
					ev.Usage = &protocol.ContextUsage{
						InputTokens:  u.InputTokens,
						OutputTokens: u.OutputTokens,
						CacheRead:    u.CacheRead,
						CacheCreate:  u.CacheCreation,
					}
				}
				events = append(events, ev)
			}
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

// makeReceipt builds a command_receipt event from a synthetic assistant text,
// inferring status from the text + cached /compact status (design D3).
func (a *ClaudeAdapter) makeReceipt(sid, text string) protocol.DaemonEvent {
	status := inferReceiptStatus(text, a.compactStatus)
	msg := text
	if status == "failed" && a.compactError != "" {
		msg = a.compactError
	}
	cmd := ""
	if a.pendingCmd != "" {
		cmd = "/" + a.pendingCmd
	}
	return protocol.DaemonEvent{
		Type:          "command_receipt",
		SessionID:     sid,
		Command:       cmd,
		ReceiptStatus: status,
		Message:       msg,
	}
}

// inferReceiptStatus maps a command's reply text to success/failed/unavailable.
// compactStatus is the /compact result ("success"/"failed") if known, else "".
func inferReceiptStatus(text, compactStatus string) string {
	if strings.Contains(text, "isn't available in this environment") {
		return "unavailable"
	}
	if compactStatus == "failed" {
		// "Not enough messages to compact" is not a real failure — the command
		// ran successfully, there was simply nothing to compact. Treat it as
		// success so the receipt shows a neutral/success visual, not an error.
		if strings.Contains(text, "Not enough messages") {
			return "success"
		}
		return "failed"
	}
	return "success"
}

// extractLocalCommandOutput unwraps <local-command-stdout>text</local-command-stdout>
// from a system local_command event's content field. Returns "" if not present.
func extractLocalCommandOutput(content string) string {
	const open = "<local-command-stdout>"
	i := strings.Index(content, open)
	if i < 0 {
		return ""
	}
	i += len(open)
	if j := strings.Index(content[i:], "</local-command-stdout>"); j >= 0 {
		return content[i : i+j]
	}
	return content[i:]
}

func (a *ClaudeAdapter) convertUser(raw ClaudeStreamEvent, sid string) ([]protocol.DaemonEvent, error) {
	// Filter meta user messages (e.g. local-command-caveat) — not real user input.
	if raw.IsMeta {
		return nil, nil
	}
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
	return BuildClaudeArgsWithContext(prompt, sessionID, config, nil)
}

// BuildClaudeArgsWithContext appends the hidden system prompt ONLY when a
// probed runtime supplied a pack; the visible prompt stays byte-identical.
func BuildClaudeArgsWithContext(prompt string, sessionID string, config protocol.SessionConfig, hidden *memorycontext.PreparedContext) []string {
	args := []string{"-p", prompt}
	if hidden != nil {
		args = memorycontext.AppendClaudeSystemPrompt(args, hidden)
	}

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

	permMode := ""
	if config.Permission != nil {
		permMode = config.Permission.Mode
	}
	if permMode == "" {
		permMode = "acceptEdits"
	}
	args = append(args, "--permission-mode", permMode)

	return args
}

// BuildInteractiveArgs builds args for an interactive (non -p) claude session
// driven via PTY stdin (interactive-web-session D1). No -p, no --output-format —
// structured output is obtained via JSONL tailer, not stream-json stdout.
func BuildInteractiveArgs(config protocol.SessionConfig) []string {
	permMode := ""
	if config.Permission != nil {
		permMode = config.Permission.Mode
	}
	if permMode == "" {
		// Unattended daemon sessions: bypass all permission checks (see the
		// matching default in CreateSession). acceptEdits would stall Bash
		// tools on an unsurfaced approval prompt.
		permMode = "bypassPermissions"
	}
	args := []string{"--permission-mode", permMode}
	if config.Model != "" {
		args = append(args, "--model", config.Model)
	}
	if len(config.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(config.AllowedTools, ","))
	}
	return args
}
