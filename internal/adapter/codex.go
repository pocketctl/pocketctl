package adapter

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// CodexHome returns Codex's home directory, honoring the CODEX_HOME environment
// variable (set e.g. by launch proxies like moonbridge) and falling back to
// ~/.codex. Returns "" only if the user home can't be resolved.
func CodexHome() string {
	if h := strings.TrimSpace(os.Getenv("CODEX_HOME")); h != "" {
		return h
	}
	home, err := config.HomeDir()
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

// CodexRolloutMetadata is the relationship metadata stored in a rollout's
// leading session_meta record. RootSessionID is the root conversation ID;
// ParentThreadID is the immediate parent for nested subagents.
type CodexRolloutMetadata struct {
	ID             string
	Cwd            string
	ParentThreadID string
	RootSessionID  string
	ThreadSource   string
	AgentNickname  string
	AgentPath      string
	IsSubagent     bool
}

// ReadCodexRolloutMetadata reads the head of a Codex rollout. ok is false if
// no usable session_meta has been flushed yet.
func ReadCodexRolloutMetadata(path string) (CodexRolloutMetadata, bool) {
	f, err := os.Open(path)
	if err != nil {
		return CodexRolloutMetadata{}, false
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
			relationID := p.ParentThreadID
			if relationID == "" {
				relationID = p.SessionID
			}
			rootSessionID := p.SessionID
			if rootSessionID == "" {
				rootSessionID = p.ParentThreadID
			}
			return CodexRolloutMetadata{
				ID:             p.ID,
				Cwd:            p.Cwd,
				ParentThreadID: p.ParentThreadID,
				RootSessionID:  rootSessionID,
				ThreadSource:   p.ThreadSource,
				AgentNickname:  p.AgentNickname,
				AgentPath:      p.AgentPath,
				IsSubagent:     p.ThreadSource == "subagent" && relationID != "" && relationID != p.ID,
			}, true
		}
	}
	return CodexRolloutMetadata{}, false
}

// CodexRolloutMeta preserves the original storage API for callers that only
// need the session id and cwd.
func CodexRolloutMeta(path string) (sessionID, cwd string, ok bool) {
	meta, ok := ReadCodexRolloutMetadata(path)
	return meta.ID, meta.Cwd, ok
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
	ThreadID  string          `json:"thread_id,omitempty"`
	Item      json.RawMessage `json:"item,omitempty"`
}

type codexExecItem struct {
	ID   string `json:"id,omitempty"`
	Type string `json:"type,omitempty"`
	Text string `json:"text,omitempty"`
}

// codexPayload is the union of fields across all payload subtypes.
type codexPayload struct {
	// message / function_call / function_call_output discriminator
	Type    string `json:"type,omitempty"` // "message" | "function_call" | "function_call_output"
	Role    string `json:"role,omitempty"` // for messages: user | assistant
	Model   string `json:"model,omitempty"`
	Effort  string `json:"effort,omitempty"`
	Phase   string `json:"phase,omitempty"` // final_answer | commentary
	Content []struct {
		Type string `json:"type"` // input_text | output_text | text
		Text string `json:"text"`
	} `json:"content,omitempty"`
	// function_call
	CallID    string          `json:"call_id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
	// custom_tool_call uses input while function_call uses arguments.
	Input json.RawMessage `json:"input,omitempty"`
	// function_call_output and custom_tool_call_output emit either a string or
	// an array of text blocks. Keep the raw JSON until conversion so one shape
	// never makes the complete response_item unparseable.
	Output json.RawMessage `json:"output,omitempty"`
	// event_msg subtypes
	Message          string                      `json:"message,omitempty"`            // agent_message / user_message text
	LastAgentMessage string                      `json:"last_agent_message,omitempty"` // task_complete
	LastTokenUsage   *codexTokenUsage            `json:"last_token_usage,omitempty"`   // token_count
	TurnID           string                      `json:"turn_id,omitempty"`
	Success          bool                        `json:"success,omitempty"`
	Status           string                      `json:"status,omitempty"`
	Changes          map[string]codexPatchChange `json:"changes,omitempty"`
	Info             struct {
		LastTokenUsage *codexTokenUsage `json:"last_token_usage,omitempty"`
	} `json:"info,omitempty"` // token_count in Codex exec/rollout v0.143+
	// session_meta
	ID             string `json:"id,omitempty"`
	SessionID      string `json:"session_id,omitempty"`
	ParentThreadID string `json:"parent_thread_id,omitempty"`
	ThreadSource   string `json:"thread_source,omitempty"`
	AgentNickname  string `json:"agent_nickname,omitempty"`
	AgentPath      string `json:"agent_path,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	CLIVersion     string `json:"cli_version,omitempty"`
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
	plan      *codexPlanTracker
	turns     codexTurnTracker
}

// NewCodexAdapter creates an adapter for a single codex exec spawn.
func NewCodexAdapter() *CodexAdapter { return NewCodexAdapterWithPlanState(nil) }

// NewCodexAdapterWithPlanState reuses Plan identity across subprocess resumes
// of the same Codex session.
func NewCodexAdapterWithPlanState(state *CodexPlanState) *CodexAdapter {
	if state == nil {
		state = NewCodexPlanState()
	}
	return &CodexAdapter{plan: &state.tracker}
}

func (a *CodexAdapter) SessionID() string       { return a.sessionID }
func (a *CodexAdapter) SlashCommands() []string { return nil } // codex has no slash-command surface

func (a *CodexAdapter) ParseStreamLine(line string) ([]protocol.DaemonEvent, error) {
	events, err := parseCodexLine(line, a, a.plan)
	if err != nil {
		return nil, err
	}
	return decorateCodexTurnEvents(line, &a.turns, events), nil
}

// ---- CodexJSONLParser (persisted JSONL history) ----

// CodexJSONLParser implements JSONLParser for Codex rollout files. It retains
// only bounded Plan identity state; Codex has no slash-command state, so
// SetPendingCmd is a no-op.
type CodexJSONLParser struct {
	plan                    codexPlanTracker
	turns                   codexTurnTracker
	pendingAgentMessageText string
}

func NewCodexJSONLParser() *CodexJSONLParser { return &CodexJSONLParser{} }

func (p *CodexJSONLParser) SetPendingCmd(string) {} // no-op: codex has no slash commands

// SetSessionID seeds a live tailer that starts after the persisted
// session_meta record. Historical replay learns the same identity by parsing
// that record in order.
func (p *CodexJSONLParser) SetSessionID(sessionID string) {
	p.turns.setSessionID(sessionID)
}

func (p *CodexJSONLParser) Parse(line string) ([]protocol.DaemonEvent, error) {
	events, err := parseCodexLine(line, nil, &p.plan)
	if err != nil {
		return nil, err
	}

	var raw codexLine
	var payload codexPayload
	if json.Unmarshal([]byte(line), &raw) != nil || json.Unmarshal(raw.Payload, &payload) != nil {
		return events, nil
	}
	events = p.turns.decorate(raw.Type, payload, events)

	if raw.Type == "event_msg" && payload.Type == "agent_message" && len(events) == 1 && events[0].Type == "agent_text" {
		p.pendingAgentMessageText = normalizeCodexAgentMessage(events[0].Text)
		return events, nil
	}
	if raw.Type == "response_item" && payload.Type == "message" && strings.EqualFold(payload.Role, "assistant") {
		responseText := ""
		for _, content := range payload.Content {
			if content.Text != "" {
				if responseText != "" {
					responseText += "\n"
				}
				responseText += content.Text
			}
		}
		if responseText != "" && p.pendingAgentMessageText != "" && normalizeCodexAgentMessage(responseText) == p.pendingAgentMessageText {
			p.pendingAgentMessageText = ""
			return nil, nil
		}
	}

	// The mirrored response_item immediately follows event_msg. Do not let a
	// later, unrelated record suppress a legitimate assistant response.
	p.pendingAgentMessageText = ""
	return events, nil
}

func decorateCodexTurnEvents(line string, turns *codexTurnTracker, events []protocol.DaemonEvent) []protocol.DaemonEvent {
	if turns == nil {
		return events
	}
	var raw codexLine
	var payload codexPayload
	if json.Unmarshal([]byte(line), &raw) != nil || json.Unmarshal(raw.Payload, &payload) != nil {
		return events
	}
	return turns.decorate(raw.Type, payload, events)
}

func normalizeCodexAgentMessage(text string) string {
	for {
		start := strings.Index(text, "<oai-mem-citation>")
		if start < 0 {
			break
		}
		end := strings.Index(text[start:], "</oai-mem-citation>")
		if end < 0 {
			break
		}
		end += start + len("</oai-mem-citation>")
		text = text[:start] + text[end:]
	}
	return strings.TrimSpace(text)
}

// parseCodexLine is the shared converter for both stdout and JSONL lines.
// session is non-nil when called from the streaming adapter (so it can record
// the session id/model parsed from session_meta); nil when called from the
// JSONL parser (events are stamped by the tailer instead).
func parseCodexLine(line string, session *CodexAdapter, plan *codexPlanTracker) ([]protocol.DaemonEvent, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, nil
	}
	var raw codexLine
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil, fmt.Errorf("parse codex json: %w", err)
	}
	switch raw.Type {
	case "thread.started":
		if raw.ThreadID != "" && session != nil {
			session.sessionID = raw.ThreadID
		}
		return nil, nil
	case "item.completed":
		var item codexExecItem
		if json.Unmarshal(raw.Item, &item) == nil && item.Type == "agent_message" && item.Text != "" {
			model := ""
			if session != nil {
				model = session.model
			}
			return []protocol.DaemonEvent{{Type: "agent_text", Text: item.Text, Model: model}}, nil
		}
		return nil, nil
	case "turn.completed":
		return nil, nil
	}
	if len(raw.Payload) == 0 {
		return nil, nil
	}
	var p codexPayload
	if err := json.Unmarshal(raw.Payload, &p); err != nil {
		return nil, nil // payload shape we don't recognize — skip
	}
	return convertCodexPayload(raw.Type, p, session, plan), nil
}

// convertCodexPayload maps a Codex payload to daemon events. The session
// pointer (when non-nil) is updated with the session id / model as they're seen.
func convertCodexPayload(topType string, p codexPayload, session *CodexAdapter, plan *codexPlanTracker) []protocol.DaemonEvent {
	switch topType {
	case "session_meta":
		if p.ID != "" && session != nil {
			session.sessionID = p.ID
		}
		return nil

	case "turn_context":
		// codex ≥0.142 only carries the selected model here (not on assistant
		// messages). Emit this record directly so a /model switch reaches the
		// relay before the next reply, rather than waiting for agent_text.
		model := CleanModelName(p.Model)
		if session != nil && model != "" {
			session.model = model
		}
		events := make([]protocol.DaemonEvent, 0, 2)
		if model != "" {
			events = append(events, protocol.DaemonEvent{Type: "session_model_changed", Model: model})
		}
		if effort := strings.TrimSpace(p.Effort); effort != "" {
			events = append(events, protocol.DaemonEvent{Type: "session_meta", Effort: effort})
		}
		return events

	case "response_item":
		return convertCodexResponseItem(p, session, plan)

	case "event_msg":
		return convertCodexEventMsg(p)

	default:
		// path / etc. — not surfaced.
		return nil
	}
}

// convertCodexResponseItem handles the wrapped message / function_call records.
func convertCodexResponseItem(p codexPayload, session *CodexAdapter, plan *codexPlanTracker) []protocol.DaemonEvent {
	switch p.Type {
	case "message":
		return convertCodexMessage(p, session)
	case "function_call":
		return []protocol.DaemonEvent{codexToolCall(p.CallID, p.Name, p.Arguments)}
	case "function_call_output":
		return []protocol.DaemonEvent{codexToolResult(p.CallID, p.Output)}
	case "custom_tool_call":
		events := []protocol.DaemonEvent{codexToolCall(p.CallID, p.Name, p.Input)}
		if p.CallID == "" || plan == nil {
			return events
		}
		payload, err := parseCodexPlanToolCall(p.Name, p.Input)
		if err != nil {
			return events
		}
		return append(events, plan.project(p.CallID, payload))
	case "custom_tool_call_output":
		return []protocol.DaemonEvent{codexToolResult(p.CallID, p.Output)}
	}
	return nil
}

func codexToolCall(callID, name string, input json.RawMessage) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:   "tool_call",
		CallID: callID,
		Tool:   name,
		Input:  input,
	}
}

func codexToolResult(callID string, rawOutput json.RawMessage) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:   "tool_result",
		CallID: callID,
		Output: decodeCodexToolOutput(rawOutput),
	}
}

// decodeCodexToolOutput normalizes Codex tool output without losing records
// when the CLI changes between a string and an array of text blocks.
func decodeCodexToolOutput(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}

	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}

	var blocks []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		parts := make([]string, 0, len(blocks))
		for _, block := range blocks {
			if block.Text != "" {
				parts = append(parts, block.Text)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}

	// Keep a valid but unfamiliar output shape visible instead of silently
	// dropping its tool_result and leaving the client card permanently running.
	var value any
	if err := json.Unmarshal(raw, &value); err == nil {
		if compact, err := json.Marshal(value); err == nil {
			return string(compact)
		}
	}
	return string(raw)
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
		// codex ≥0.142 stopped emitting model on assistant messages; fall back to
		// the model captured from the preceding turn_context line (if any).
		model := CleanModelName(p.Model)
		if model == "" && session != nil && session.model != "" {
			model = session.model
		}
		ev := protocol.DaemonEvent{Type: "agent_text", Text: text, Model: model}
		if session != nil && model != "" {
			session.model = model
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
		u := p.LastTokenUsage
		if u == nil {
			u = p.Info.LastTokenUsage
		}
		if u == nil {
			return nil
		}
		return []protocol.DaemonEvent{{
			Type: "agent_text", // usage rides on an agent_text so the web can attribute it
			Usage: &protocol.ContextUsage{
				InputTokens:     u.InputTokens,
				OutputTokens:    u.OutputTokens,
				CacheRead:       u.CachedInputTokens,
				ReasoningTokens: u.ReasoningOutputTokens,
				TotalTokens:     u.TotalTokens,
			},
		}}

	case "task_started":
		return []protocol.DaemonEvent{{
			Type:   "session_status",
			Status: protocol.StatusRunning,
		}}

	case "task_complete":
		// task_complete ends one Codex turn, not the interactive terminal session.
		return []protocol.DaemonEvent{{
			Type:   "session_status",
			Status: protocol.StatusIdle,
		}}

	case "patch_apply_end":
		return projectCodexPatchApplyEnd(p)
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
	args := []string{"exec", "resume", sessionID, "--json", "--skip-git-repo-check"}
	if permissionArgs, err := PermissionArgs(AgentCodex, config.Permission, CommandResume); err == nil {
		args = append(args, permissionArgs...)
	}
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

func (s CodexSessionStorage) ResolveJSONLPathForPTY(sessionID, cwd string, hints PTYResolveHints) (string, string, error) {
	if path, err := s.ResolveJSONLPath(sessionID, cwd); err == nil {
		return path, sessionID, nil
	}
	return s.findNewestRolloutByCwdSince(cwd, hints)
}

func (CodexSessionStorage) findNewestRolloutByCwdSince(cwd string, hints PTYResolveHints) (string, string, error) {
	sessionsDir := CodexSessionsDir()
	if sessionsDir == "" {
		return "", "", fmt.Errorf("codex home not resolved")
	}
	if _, err := os.Stat(sessionsDir); err != nil {
		return "", "", fmt.Errorf("codex sessions dir: %w", err)
	}

	var foundPath string
	var foundID string
	var foundMtime time.Time
	cutoff := hints.StartedAt.Add(-2 * time.Second)
	initialPrompt := strings.TrimSpace(hints.InitialPrompt)
	_ = filepath.Walk(sessionsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		name := info.Name()
		if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			return nil
		}
		if !hints.StartedAt.IsZero() && info.ModTime().Before(cutoff) {
			return nil
		}
		sessionID, metaCwd, ok := CodexRolloutMeta(path)
		if !ok || sessionID == "" || !sameCodexCwd(metaCwd, cwd) {
			return nil
		}
		if _, excluded := hints.ExcludeSessionIDs[sessionID]; excluded {
			return nil
		}
		if initialPrompt != "" && !CodexRolloutHasUserMessage(path, initialPrompt) {
			return nil
		}
		if foundPath == "" || info.ModTime().After(foundMtime) {
			foundPath = path
			foundID = sessionID
			foundMtime = info.ModTime()
		}
		return nil
	})
	if foundPath == "" {
		return "", "", fmt.Errorf("codex jsonl not found for cwd %s since %s", cwd, hints.StartedAt.Format(time.RFC3339))
	}
	return foundPath, foundID, nil
}

func CodexRolloutSessionIDsForCwd(cwd string) map[string]struct{} {
	ids := make(map[string]struct{})
	sessionsDir := CodexSessionsDir()
	if sessionsDir == "" {
		return ids
	}
	_ = filepath.Walk(sessionsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		name := info.Name()
		if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			return nil
		}
		sessionID, metaCwd, ok := CodexRolloutMeta(path)
		if ok && sessionID != "" && sameCodexCwd(metaCwd, cwd) {
			ids[sessionID] = struct{}{}
		}
		return nil
	})
	return ids
}

func CodexRolloutHasUserMessage(path string, want string) bool {
	want = strings.TrimSpace(want)
	if want == "" {
		return true
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for i := 0; sc.Scan() && i < 200; i++ {
		var raw codexLine
		if json.Unmarshal(sc.Bytes(), &raw) != nil || len(raw.Payload) == 0 {
			continue
		}
		var p codexPayload
		if json.Unmarshal(raw.Payload, &p) != nil {
			continue
		}
		if raw.Type == "event_msg" && p.Type == "user_message" && strings.TrimSpace(p.Message) == want {
			return true
		}
		if raw.Type == "response_item" && p.Type == "message" && strings.EqualFold(p.Role, "user") {
			var text string
			for _, c := range p.Content {
				if c.Text != "" {
					if text != "" {
						text += "\n"
					}
					text += c.Text
				}
			}
			if strings.TrimSpace(text) == want {
				return true
			}
		}
	}
	return false
}

func sameCodexCwd(a, b string) bool {
	if a == "" || b == "" {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return cleanCodexCwd(a) == cleanCodexCwd(b)
}

func cleanCodexCwd(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved
	}
	return filepath.Clean(abs)
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

// CodexExtractFirstUserMessage 提取 codex JSONL 首条 user 消息(供 GenerateTitle 触发)。
// 与 CodexSessionStorage.ExtractTitle 同逻辑,但函数形式 + maxLen 可控。
func CodexExtractFirstUserMessage(lines []string, maxLen int) string {
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
			return truncateCodex(p.Message, maxLen)
		}
	}
	return ""
}

// CodexExtractFirstAssistantMessage 提取 codex JSONL 首条 assistant 消息(供 GenerateTitle 触发)。
// 支持 event_msg(agent_message)和 response_item(message assistant)两种 codex 格式。
func CodexExtractFirstAssistantMessage(lines []string, maxLen int) string {
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw codexLine
		if json.Unmarshal([]byte(line), &raw) != nil {
			continue
		}
		var p codexPayload
		if json.Unmarshal(raw.Payload, &p) != nil {
			continue
		}
		// event_msg: agent_message
		if raw.Type == "event_msg" && p.Type == "agent_message" && p.Message != "" {
			return truncateCodex(p.Message, maxLen)
		}
		// response_item: message assistant(取首个 Content.Text)
		if raw.Type == "response_item" && p.Type == "message" && strings.EqualFold(p.Role, "assistant") {
			for _, c := range p.Content {
				if c.Text != "" {
					return truncateCodex(c.Text, maxLen)
				}
			}
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
		var p codexPayload
		if json.Unmarshal(raw.Payload, &p) != nil {
			continue
		}
		// codex ≥0.142 moved the model out of assistant messages: it now lives
		// on the turn_context line (payload.model). Older rollouts still carry
		// it on the assistant response_item. Check both so new AND old sessions
		// resolve a model.
		if raw.Type == "turn_context" {
			if m := CleanModelName(p.Model); m != "" {
				return m // turn_context is authoritative for the whole session
			}
			continue
		}
		if raw.Type == "response_item" && p.Type == "message" && strings.EqualFold(p.Role, "assistant") {
			if m := CleanModelName(p.Model); m != "" {
				model = m
			}
		}
	}
	return model
}

func (CodexSessionStorage) ExtractEffort(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var raw codexLine
		if json.Unmarshal([]byte(line), &raw) != nil || raw.Type != "turn_context" {
			continue
		}
		var p codexPayload
		if json.Unmarshal(raw.Payload, &p) != nil {
			continue
		}
		if effort := strings.TrimSpace(p.Effort); effort != "" {
			return effort
		}
	}
	return ""
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
