package adapter

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// CodexHome returns Codex's home directory, honoring the CODEX_HOME environment
// variable (set e.g. by launch proxies like moonbridge) and falling back to
// ~/.codex. Returns "" only if the user home can't be resolved.
func CodexHome() string {
	if h := strings.TrimSpace(os.Getenv("CODEX_HOME")); h != "" {
		return h
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// CodexSessionsDir returns the rollout sessions directory ($CODEX_HOME/sessions).
func CodexSessionsDir() string {
	h := CodexHome()
	if h == "" {
		return ""
	}
	return filepath.Join(h, "sessions")
}

// CodexRolloutMeta reads the head of a codex rollout file and returns the
// session id and cwd from its session_meta record. ok is false if no usable
// session_meta is found in the leading lines (e.g. the file was just created
// and the record hasn't been flushed yet).
func CodexRolloutMeta(path string) (sessionID, cwd string, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for i := 0; sc.Scan() && i < 40; i++ {
		var raw codexLine
		if json.Unmarshal(sc.Bytes(), &raw) != nil || raw.Type != "session_meta" {
			continue
		}
		var p codexPayload
		if json.Unmarshal(raw.Payload, &p) != nil {
			continue
		}
		if p.ID != "" {
			return p.ID, p.Cwd, true
		}
	}
	return "", "", false
}

// Codex adapter — parses OpenAI Codex CLI output.
//
// Two output channels:
//  1. Streaming stdout (codex exec --json) — parsed by CodexAdapter.
//  2. Persisted JSONL history (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) —
//     parsed by CodexJSONLParser, tailed for live PTY sessions.
//
// Both share the same event schema. Each line is a JSON object with a top-level
// "type" field. The richest lines are:
//   - {"type":"session_meta","payload":{"id","cwd","cli_version",…}}
//   - {"type":"response_item","payload":{"type":"message","role":"user|assistant","content":[{"type":"input_text|output_text","text":…}]}}
//   - {"type":"response_item","payload":{"type":"function_call","call_id","name","arguments":…}}
//   - {"type":"response_item","payload":{"type":"function_call_output","call_id","output":…}}
//   - {"type":"event_msg","payload":{"type":"agent_message|user_message|token_count|task_started|task_complete",…}}
//
// For live tailing we prefer the event_msg channel (flat, one event per user
// turn / agent reply / token count), and fall back to response_item for tool
// calls (which event_msg doesn't carry).

// codexLine is the common envelope of every Codex output line.
type codexLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// codexPayload is the union of fields across all payload subtypes.
type codexPayload struct {
	// message / function_call / function_call_output discriminator
	Type    string `json:"type,omitempty"` // "message" | "function_call" | "function_call_output"
	Role    string `json:"role,omitempty"` // for messages: user | assistant
	Model   string `json:"model,omitempty"`
	Phase   string `json:"phase,omitempty"` // final_answer | commentary
	Content []struct {
		Type string `json:"type"` // input_text | output_text | text
		Text string `json:"text"`
	} `json:"content,omitempty"`
	// function_call
	CallID    string          `json:"call_id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
	// function_call_output
	Output string `json:"output,omitempty"`
	// event_msg subtypes
	Message           string `json:"message,omitempty"`        // agent_message / user_message text
	LastAgentMessage  string `json:"last_agent_message,omitempty"` // task_complete
	LastTokenUsage    *codexTokenUsage `json:"last_token_usage,omitempty"` // token_count
	// session_meta
	ID        string `json:"id,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	CLIVersion string `json:"cli_version,omitempty"`
}

type codexTokenUsage struct {
	InputTokens           int `json:"input_tokens,omitempty"`
	CachedInputTokens     int `json:"cached_input_tokens,omitempty"`
	OutputTokens          int `json:"output_tokens,omitempty"`
	ReasoningOutputTokens int `json:"reasoning_output_tokens,omitempty"`
	TotalTokens           int `json:"total_tokens,omitempty"`
}

// ---- CodexAdapter (streaming stdout, codex exec --json) ----

// CodexAdapter implements AgentAdapter for Codex's streaming stdout.
type CodexAdapter struct {
	sessionID string
	model     string
}

// NewCodexAdapter creates an adapter for a single codex exec spawn.
func NewCodexAdapter() *CodexAdapter { return &CodexAdapter{} }

func (a *CodexAdapter) SessionID() string     { return a.sessionID }
func (a *CodexAdapter) SlashCommands() []string { return nil } // codex has no slash-command surface

func (a *CodexAdapter) ParseStreamLine(line string) ([]protocol.DaemonEvent, error) {
	return parseCodexLine(line, a)
}

// ---- CodexJSONLParser (persisted JSONL history) ----

// CodexJSONLParser implements JSONLParser for Codex rollout files. Stateless
// beyond the shared codex-line parsing (codex has no slash-command concept, so
// SetPendingCmd is a no-op).
type CodexJSONLParser struct{}

func NewCodexJSONLParser() *CodexJSONLParser { return &CodexJSONLParser{} }

func (p *CodexJSONLParser) SetPendingCmd(string) {} // no-op: codex has no slash commands

func (p *CodexJSONLParser) Parse(line string) ([]protocol.DaemonEvent, error) {
	return parseCodexLine(line, nil)
}

// parseCodexLine is the shared converter for both stdout and JSONL lines.
// session is non-nil when called from the streaming adapter (so it can record
// the session id/model parsed from session_meta); nil when called from the
// JSONL parser (events are stamped by the tailer instead).
func parseCodexLine(line string, session *CodexAdapter) ([]protocol.DaemonEvent, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, nil
	}
	var raw codexLine
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil, fmt.Errorf("parse codex json: %w", err)
	}
	if len(raw.Payload) == 0 {
		return nil, nil
	}
	var p codexPayload
	if err := json.Unmarshal(raw.Payload, &p); err != nil {
		return nil, nil // payload shape we don't recognize — skip
	}
	return convertCodexPayload(raw.Type, p, session), nil
}

// convertCodexPayload maps a Codex payload to daemon events. The session
// pointer (when non-nil) is updated with the session id / model as they're seen.
func convertCodexPayload(topType string, p codexPayload, session *CodexAdapter) []protocol.DaemonEvent {
	switch topType {
	case "session_meta":
		if p.ID != "" && session != nil {
			session.sessionID = p.ID
		}
		return nil

	case "response_item":
		return convertCodexResponseItem(p, session)

	case "event_msg":
		return convertCodexEventMsg(p)

	default:
		// path / turn_context / etc. — not surfaced.
		return nil
	}
}

// convertCodexResponseItem handles the wrapped message / function_call records.
func convertCodexResponseItem(p codexPayload, session *CodexAdapter) []protocol.DaemonEvent {
	switch p.Type {
	case "message":
		return convertCodexMessage(p, session)
	case "function_call":
		return []protocol.DaemonEvent{{
			Type:   "tool_call",
			CallID: p.CallID,
			Tool:   p.Name,
			Input:  p.Arguments,
		}}
	case "function_call_output":
		out := p.Output
		return []protocol.DaemonEvent{{
			Type:   "tool_result",
			CallID: p.CallID,
			Output: out,
		}}
	}
	return nil
}

// convertCodexMessage maps a user/assistant message to user_text / agent_text.
func convertCodexMessage(p codexPayload, session *CodexAdapter) []protocol.DaemonEvent {
	var text string
	for _, c := range p.Content {
		if c.Text != "" {
			if text != "" {
				text += "\n"
			}
			text += c.Text
		}
	}
	if text == "" {
		return nil
	}
	switch strings.ToLower(p.Role) {
	case "user":
		// Skip the <environment_context> wrapper codex injects — not real user input.
		if strings.Contains(text, "<environment_context>") && strings.Contains(text, "</environment_context>") {
			return nil
		}
		return []protocol.DaemonEvent{{Type: "user_text", Text: text}}
	case "assistant":
		ev := protocol.DaemonEvent{Type: "agent_text", Text: text, Model: CleanModelName(p.Model)}
		if session != nil && p.Model != "" {
			session.model = CleanModelName(p.Model)
		}
		return []protocol.DaemonEvent{ev}
	}
	return nil
}

// convertCodexEventMsg maps the flat event_msg subtypes.
func convertCodexEventMsg(p codexPayload) []protocol.DaemonEvent {
	switch p.Type {
	case "user_message":
		if p.Message == "" {
			return nil
		}
		return []protocol.DaemonEvent{{Type: "user_text", Text: p.Message}}

	case "agent_message":
		if p.Message == "" {
			return nil
		}
		return []protocol.DaemonEvent{{Type: "agent_text", Text: p.Message}}

	case "token_count":
		if p.LastTokenUsage == nil {
			return nil
		}
		u := p.LastTokenUsage
		return []protocol.DaemonEvent{{
			Type: "agent_text", // usage rides on an agent_text so the web can attribute it
			Usage: &protocol.ContextUsage{
				InputTokens:  u.InputTokens,
				OutputTokens: u.OutputTokens,
				CacheRead:    u.CachedInputTokens,
			},
		}}

	case "task_complete":
		// End of a turn → mark the session as completed (idle for PTY sessions).
		return []protocol.DaemonEvent{{
			Type:   "session_status",
			Status: protocol.StatusCompleted,
		}}
	}
	return nil
}

// ---- CodexLauncher (CLI args) ----

// CodexLauncher builds args for the Codex CLI.
//
// Interactive (PTY) mode launches `codex` (no subcommand) — the TUI. We pass
// --ask-for-approval never so the daemon (unattended) never stalls on a y/n
// prompt the UI can't surface (mirrors Claude's bypassPermissions default), and
// -C to pin the working directory. TERM must be set to a non-dumb value by the
// PTY starter or codex refuses to run (see pty.go).
type CodexLauncher struct{}

func (CodexLauncher) BuildInteractiveArgs(config protocol.SessionConfig) []string {
	args := []string{"--ask-for-approval", "never"}
	if config.Cwd != "" {
		args = append(args, "-C", config.Cwd)
	}
	if config.Model != "" {
		args = append(args, "-m", config.Model)
	}
	return args
}

func (CodexLauncher) BuildResumeArgs(prompt, sessionID string, config protocol.SessionConfig) []string {
	args := []string{"exec", "resume", sessionID, "--json"}
	if config.Model != "" {
		args = append(args, "-m", config.Model)
	}
	if prompt != "" {
		args = append(args, prompt)
	}
	return args
}

// ---- CodexSessionStorage (JSONL layout) ----

// CodexSessionStorage resolves Codex's rollout-*.jsonl layout:
// ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
// The session id is embedded in the filename (after the timestamp), so we glob
// for *<sessionID>.jsonl across the sessions tree.
type CodexSessionStorage struct{}

func (CodexSessionStorage) ResolveJSONLPath(sessionID, cwd string) (string, error) {
	sessionsDir := CodexSessionsDir()
	if sessionsDir == "" {
		return "", fmt.Errorf("codex home not resolved")
	}
	if _, err := os.Stat(sessionsDir); err != nil {
		return "", fmt.Errorf("codex sessions dir: %w", err)
	}

	// Glob for any rollout file whose name ends with the session id.
	var found string
	var foundMtime time.Time
	_ = filepath.Walk(sessionsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		name := info.Name()
		if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			return nil
		}
		// rollout-<timestamp>-<sessionID>.jsonl → match by suffix.
		if strings.HasSuffix(name, "-"+sessionID+".jsonl") {
			// Prefer the most recent match (in case of forks/archives).
			if found == "" || info.ModTime().After(foundMtime) {
				found = path
				foundMtime = info.ModTime()
			}
		}
		return nil
	})
	if found == "" {
		return "", fmt.Errorf("codex jsonl not found for session %s", sessionID)
	}
	return found, nil
}

func (CodexSessionStorage) ExtractTitle(lines []string) string {
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw codexLine
		if json.Unmarshal([]byte(line), &raw) != nil || raw.Type != "event_msg" {
			continue
		}
		var p codexPayload
		if json.Unmarshal(raw.Payload, &p) != nil {
			continue
		}
		if p.Type == "user_message" && p.Message != "" {
			return truncateCodex(p.Message, 60)
		}
	}
	return ""
}

func (CodexSessionStorage) ExtractModel(lines []string) string {
	model := ""
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw codexLine
		if json.Unmarshal([]byte(line), &raw) != nil {
			continue
		}
		if raw.Type != "response_item" {
			continue
		}
		var p codexPayload
		if json.Unmarshal(raw.Payload, &p) != nil {
			continue
		}
		if p.Type == "message" && strings.EqualFold(p.Role, "assistant") {
			if m := CleanModelName(p.Model); m != "" {
				model = m
			}
		}
	}
	return model
}

func truncateCodex(s string, maxLen int) string {
	if maxLen <= 0 {
		maxLen = 60
	}
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.TrimSpace(s)
	if len(s) > maxLen {
		return s[:maxLen-3] + "..."
	}
	return s
}
