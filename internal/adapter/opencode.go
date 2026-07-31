package adapter

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// opencode.go holds opencode's data shapes and the single Part→DaemonEvent
// converter shared by both observation paths:
//   - DirWatch reads Part objects from storage/part/<msgId>/*.json files
//     (terminal sessions; see experiment finding: SSE is in-process so terminal
//     sessions must be observed via the filesystem).
//   - ServeSSE reads the same Part objects from the /event bus's
//     `message.part.updated` → properties.part (daemon-owned sessions).
//
// Both feed OpencodePart into ConvertOpencodePart, so the mapping lives in one
// place. The event-mapping table is documented in the change's design.md.

// OpencodeSessionSummary is a session list item from GET /api/session.
type OpencodeSessionSummary struct {
	ID       string `json:"id"`
	ParentID string `json:"parentID,omitempty"`
	Title    string `json:"title"`
	Time     struct {
		Created int64 `json:"created"`
		Updated int64 `json:"updated"`
	} `json:"time"`
	Location *struct {
		Directory string `json:"directory"`
	} `json:"location"`
}

// Directory returns the session's working directory ("" if unset).
func (s OpencodeSessionSummary) Directory() string {
	if s.Location == nil {
		return ""
	}
	return s.Location.Directory
}

// OpencodeMessageWithParts is one item from GET /session/{id}/message: a message
// plus its parts. (The legacy /session/.../message route returns these; the
// /api/... variant returns empty.)
type OpencodeMessageWithParts struct {
	Info  OpencodeMessage `json:"info"`
	Parts []OpencodePart  `json:"parts"`
}

// OpencodeMessage mirrors storage/message/<sid>/msg_*.json and the SSE
// message.updated payload. Carries the role + model that the message's parts
// inherit.
type OpencodeMessage struct {
	ID        string            `json:"id"`
	SessionID string            `json:"sessionID"`
	Role      string            `json:"role"` // "user" | "assistant"
	Error     json.RawMessage   `json:"error,omitempty"`
	Model     *OpencodeModelRef `json:"model,omitempty"`
	Time      struct {
		Created   int64 `json:"created"`
		Completed int64 `json:"completed"` // assistant messages: set when the turn finishes
	} `json:"time"`
	Path *struct {
		Cwd  string `json:"cwd"`
		Root string `json:"root"`
	} `json:"path,omitempty"`
}

// OpencodePart mirrors storage/part/<msgId>/prt_*.json and the SSE
// message.part.updated payload's `part`.
type OpencodePart struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	MessageID string `json:"messageID"`
	Type      string `json:"type"` // text | tool | reasoning | step-start | step-finish | patch | file

	// text
	Text string `json:"text,omitempty"`

	// tool
	CallID string             `json:"callID,omitempty"`
	Tool   string             `json:"tool,omitempty"`
	State  *OpencodeToolState `json:"state,omitempty"`

	// step-finish
	Tokens *OpencodeTokens `json:"tokens,omitempty"`

	// retry
	Attempt int             `json:"attempt,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
	Time    struct {
		Created int64 `json:"created"`
	} `json:"time,omitempty"`

	// compaction
	Auto     bool `json:"auto,omitempty"`
	Overflow bool `json:"overflow,omitempty"`

	// file
	Mime       string          `json:"mime,omitempty"`
	Filename   string          `json:"filename,omitempty"`
	URL        string          `json:"url,omitempty"`
	PartSource json.RawMessage `json:"source,omitempty"`

	// patch
	Hash  string   `json:"hash,omitempty"`
	Files []string `json:"files,omitempty"`

	// subtask / agent
	Prompt      string            `json:"prompt,omitempty"`
	Description string            `json:"description,omitempty"`
	Agent       string            `json:"agent,omitempty"`
	Model       *OpencodeModelRef `json:"model,omitempty"`
	Command     string            `json:"command,omitempty"`
	Name        string            `json:"name,omitempty"`
}

func (m *OpencodeModelRef) Display() string {
	if m == nil || m.ModelID == "" {
		return ""
	}
	if m.ProviderID == "" {
		return m.ModelID
	}
	return m.ProviderID + "/" + m.ModelID
}

// OpencodeToolState is the tool part's evolving state (pending→running→completed/error).
type OpencodeToolState struct {
	Status string          `json:"status"` // pending | running | completed | error
	Input  json.RawMessage `json:"input,omitempty"`
	Output string          `json:"output,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// OpencodeTokens is the step-finish token accounting.
type OpencodeTokens struct {
	Input     int `json:"input"`
	Output    int `json:"output"`
	Reasoning int `json:"reasoning"`
	Cache     struct {
		Read  int `json:"read"`
		Write int `json:"write"`
	} `json:"cache"`
}

// OpencodeModelDisplay returns the canonical "providerID/modelID" model string
// for a message (e.g. "zhipuai-coding-plan/glm-5.2"), "" if none. This matches
// the format used by the model picker, get_session_meta, and Prompt's model
// parsing, so the model badge and runtime change-detection stay consistent.
func (m *OpencodeMessage) OpencodeModelDisplay() string {
	if m == nil || m.Model == nil || m.Model.ModelID == "" {
		return ""
	}
	if m.Model.ProviderID != "" {
		return m.Model.ProviderID + "/" + m.Model.ModelID
	}
	return m.Model.ModelID
}

// ParseOpencodeMessage decodes one message JSON blob.
func ParseOpencodeMessage(data []byte) (*OpencodeMessage, error) {
	var m OpencodeMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// ParseOpencodePart decodes one part JSON blob.
func ParseOpencodePart(data []byte) (*OpencodePart, error) {
	var p OpencodePart
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// OpencodeSync is a stateful differ that turns repeated GetMessages snapshots
// into incremental DaemonEvents. It is the source-agnostic core of terminal
// session sync: feed it the latest message+part snapshot each poll and it emits
// only what's new or changed.
//
// Dedup rules (mirror the SSE demux): text/reasoning parts emit revisioned
// deltas plus one final snapshot; structured and tool parts re-emit whenever
// their canonical semantic snapshot changes, including within the same state.
type OpencodeSync struct {
	sessionID     string
	partState     map[string]opencodePartState
	textState     map[string]opencodeTextState
	messageErrors map[string]string // messageID → last emitted raw error
	emitUser      bool              // whether to emit user_text parts
	lastStatusKey string            // last emitted status plus native retry metadata

	// Turn-completion tracking. opencode polls every ~1s and only emits a
	// session_status on a derived-status change. A fast turn whose entire
	// running window falls between two polls is never observed as "running",
	// and its trailing "idle" is deduped away (lastStatusKey already idle) — so
	// the turn emits zero session_status events and clients' optimistic timers
	// never resolve. We detect such turns by watching the latest assistant
	// completion timestamp and force an idle when it advances.
	lastCompletedAt  int64 // greatest assistant Time.Completed seen so far
	seededCompletion bool  // first Diff seeds lastCompletedAt without force-emitting
}

type opencodeTextState struct {
	text      string
	revision  int
	finalized bool
	eventID   string
}

type opencodePartState struct {
	marker  string
	eventID string
}

// NewOpencodeSync creates a differ for a session. emitUser controls whether user
// message parts produce user_text events (terminal sessions: true, since nothing
// else surfaces them; owned sessions echo user text on send instead).
func NewOpencodeSync(sessionID string, emitUser bool) *OpencodeSync {
	return &OpencodeSync{
		sessionID:     sessionID,
		partState:     make(map[string]opencodePartState),
		textState:     make(map[string]opencodeTextState),
		messageErrors: make(map[string]string),
		emitUser:      emitUser,
	}
}

// Diff returns events for anything new/changed since the last snapshot. Messages
// are processed oldest-first (by time.created) for conversational order.
func (s *OpencodeSync) Diff(msgs []OpencodeMessageWithParts) []protocol.DaemonEvent {
	return s.DiffWithNativeStatus(msgs, nil)
}

// DiffWithNativeStatus prefers OpenCode's /session/status value when present.
// A nil status retains the P0 message-snapshot inference for older OpenCode
// versions and terminal sessions owned by a different OpenCode process.
func (s *OpencodeSync) DiffWithNativeStatus(msgs []OpencodeMessageWithParts, native *OpencodeSessionStatus) []protocol.DaemonEvent {
	ordered := make([]OpencodeMessageWithParts, len(msgs))
	copy(ordered, msgs)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].Info.Time.Created < ordered[j].Info.Time.Created
	})
	for messageIndex := range ordered {
		message := &ordered[messageIndex]
		if message.Info.ID == "" {
			// Native-ID-less records are inherently ambiguous. A semantic
			// fingerprint is more stable than array position when another message
			// with the same role/timestamp is inserted before this one.
			message.Info.ID = opencodeFallbackID(
				"message", message.Info.Role, fmt.Sprint(message.Info.Time.Created),
				opencodeContentHash(string(opencodeCanonicalJSON(message.Parts))),
			)
		}
		for partIndex := range message.Parts {
			part := &message.Parts[partIndex]
			if part.MessageID == "" {
				part.MessageID = message.Info.ID
			}
			if part.ID == "" {
				part.ID = opencodeFallbackID(
					"part", message.Info.ID, part.Type,
					opencodeContentHash(string(opencodeCanonicalJSON(part))),
				)
			}
			if part.Type == "tool" && part.CallID == "" {
				part.CallID = part.ID
			}
		}
	}

	var out []protocol.DaemonEvent
	for _, m := range ordered {
		role := m.Info.Role
		model := m.Info.OpencodeModelDisplay()
		if strings.EqualFold(role, "assistant") && len(m.Info.Error) > 0 {
			raw := string(m.Info.Error)
			if s.messageErrors[m.Info.ID] != raw {
				s.messageErrors[m.Info.ID] = raw
				errorMessage := opencodeErrorMessage(m.Info.Error)
				out = append(out, protocol.DaemonEvent{
					Type:      "error",
					SessionID: s.sessionID,
					MessageID: m.Info.ID,
					Error:     errorMessage,
					EventID:   fmt.Sprintf("opencode:error:%s:%s", m.Info.ID, opencodeContentHash(errorMessage)),
				})
			}
		}
		for i := range m.Parts {
			part := &m.Parts[i]
			if part.Type == "text" || part.Type == "reasoning" {
				isFinal := !strings.EqualFold(role, "assistant") || m.Info.Time.Completed > 0
				if ev, ok := s.diffTextPart(part, role, model, isFinal); ok {
					if ev.Type != "user_text" || s.emitUser {
						ev.SessionID = s.sessionID
						out = append(out, ev)
					}
				}
				continue
			}
			canonicalPart := opencodeCanonicalJSON(part)
			marker := opencodeContentHash(string(canonicalPart))
			previous := s.partState[part.ID]
			if previous.marker == marker {
				continue
			}

			emittedEventID := ""
			for _, ev := range ConvertOpencodePart(part, role, model) {
				if ev.Type == "user_text" && !s.emitUser {
					continue
				}
				ev.SessionID = s.sessionID
				ev.EventID = opencodePartEventID(part, ev)
				ev.PreviousEventID = previous.eventID
				emittedEventID = ev.EventID
				out = append(out, ev)
			}
			s.partState[part.ID] = opencodePartState{marker: marker, eventID: emittedEventID}
		}
	}

	// Derive the session's working state and emit a session_status transition.
	// opencode never streams an explicit "turn done" event, so we infer it.
	// Two triggers:
	//   1) the derived status changed (running<->idle) — the normal path, and
	//      also fires on the first Diff (lastStatusKey == "").
	//   2) a new assistant turn *completed* since the last poll even though the
	//      derived status is still idle — a fast turn whose "running" window
	//      fell between two polls. Without this it emits zero session_status.
	status := s.deriveStatus(ordered)
	statusKey := status
	statusEvent := protocol.DaemonEvent{Type: "session_status", SessionID: s.sessionID, Status: status}
	if native != nil && (native.Type == protocol.StatusBusy || native.Type == protocol.StatusRetry || native.Type == protocol.StatusIdle) {
		status = native.Type
		statusEvent.Status = native.Type
		statusEvent.Attempt = native.Attempt
		statusEvent.Error = native.Message
		statusEvent.RetryAt = native.Next
		encoded, _ := json.Marshal(native)
		statusKey = string(encoded)
	}
	completedAt := latestCompletedAssistant(ordered)
	switch {
	case status != "" && statusKey != s.lastStatusKey:
		s.lastStatusKey = statusKey
		out = append(out, statusEvent)
	case s.seededCompletion && completedAt > s.lastCompletedAt && status == protocol.StatusIdle:
		s.lastStatusKey = statusKey
		out = append(out, statusEvent)
	}
	if completedAt > s.lastCompletedAt {
		s.lastCompletedAt = completedAt
	}
	s.seededCompletion = true
	return out
}

// diffTextPart converts OpenCode's mutable text/reasoning Part snapshots into
// revisioned append or replace events. A completed assistant message always
// gets one exact, non-streaming final snapshot even when its text did not change
// since the preceding poll.
func (s *OpencodeSync) diffTextPart(p *OpencodePart, role, model string, final bool) (protocol.DaemonEvent, bool) {
	if strings.TrimSpace(p.Text) == "" || p.ID == "" {
		return protocol.DaemonEvent{}, false
	}
	state, seen := s.textState[p.ID]
	if seen && state.text == p.Text && (!final || state.finalized) {
		return protocol.DaemonEvent{}, false
	}

	state.revision++
	ev := protocol.DaemonEvent{
		Type:      "agent_text",
		Text:      p.Text,
		Snapshot:  p.Text,
		Streaming: strings.EqualFold(role, "assistant") && !final,
		MessageID: p.MessageID,
		PartID:    p.ID,
		Revision:  state.revision,
		Model:     model,
	}
	if strings.EqualFold(role, "user") {
		ev.Type = "user_text"
		ev.EventID = fmt.Sprintf("opencode:user:%s:%s", p.MessageID, p.ID)
	} else if p.Type == "reasoning" {
		ev.Type = "agent_reasoning"
	}
	if ev.EventID == "" {
		stateName := "stream"
		if final {
			stateName = "final"
		}
		ev.EventID = fmt.Sprintf("opencode:part:%s:%s:%s", p.ID, stateName, opencodeContentHash(p.Text))
	}
	ev.PreviousEventID = state.eventID

	if seen {
		if final || !strings.HasPrefix(p.Text, state.text) {
			ev.Replace = true
		} else {
			ev.Text = strings.TrimPrefix(p.Text, state.text)
		}
	}
	state.text = p.Text
	state.finalized = final
	state.eventID = ev.EventID
	s.textState[p.ID] = state
	return ev, true
}

func opencodeContentHash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return fmt.Sprintf("%x", sum)[:16]
}

func opencodeFallbackID(kind string, components ...string) string {
	return fmt.Sprintf("fallback-%s-%s", kind, opencodeContentHash(strings.Join(components, "\x00")))
}

func opencodeCanonicalJSON(value any) []byte {
	encoded, _ := json.Marshal(value)
	var normalized any
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	if decoder.Decode(&normalized) != nil {
		return encoded
	}
	canonical, _ := json.Marshal(normalized)
	return canonical
}

// opencodePartEventID identifies a non-text native Part snapshot. Tool Parts
// use their call identity and mutable state. Other structured Parts are keyed by
// their Part ID and canonical event content so restarts dedupe an identical
// snapshot without collapsing a changed native Part.
func opencodePartEventID(part *OpencodePart, event protocol.DaemonEvent) string {
	if part.Type == "tool" && part.State != nil {
		type canonicalTool struct {
			Tool   string          `json:"tool"`
			Status string          `json:"status"`
			Input  json.RawMessage `json:"input,omitempty"`
			Output string          `json:"output,omitempty"`
			Error  string          `json:"error,omitempty"`
		}
		canonical := opencodeCanonicalJSON(canonicalTool{
			Tool: part.Tool, Status: part.State.Status, Input: part.State.Input,
			Output: part.State.Output, Error: part.State.Error,
		})
		return fmt.Sprintf("opencode:tool:%s:%s:%s", part.CallID, part.State.Status, opencodeContentHash(string(canonical)))
	}
	event.EventID = ""
	event.PreviousEventID = ""
	event.Seq = 0
	canonical := opencodeCanonicalJSON(event)
	return fmt.Sprintf("opencode:part:%s:final:%s", part.ID, opencodeContentHash(string(canonical)))
}

// OpencodeTodoEventID returns the stable identity for a native todo snapshot.
// A fixed-field projection makes the JSON representation explicit and stable.
func OpencodeTodoEventID(sessionID string, todos []protocol.TodoItem) string {
	type canonicalTodo struct {
		Content  string `json:"content"`
		Status   string `json:"status"`
		Priority string `json:"priority"`
	}
	canonical := make([]canonicalTodo, len(todos))
	for i, todo := range todos {
		canonical[i] = canonicalTodo{Content: todo.Content, Status: todo.Status, Priority: todo.Priority}
	}
	encoded, _ := json.Marshal(canonical)
	return fmt.Sprintf("opencode:todo:%s:%s", sessionID, opencodeContentHash(string(encoded)))
}

// latestCompletedAssistant returns the greatest Time.Completed across assistant
// messages (0 if none have completed). When this advances between polls an
// assistant turn finished — used to force a terminal idle for turns whose
// "running" window was missed.
func latestCompletedAssistant(ordered []OpencodeMessageWithParts) int64 {
	var latest int64
	for i := range ordered {
		info := ordered[i].Info
		if strings.EqualFold(info.Role, "assistant") && info.Time.Completed > latest {
			latest = info.Time.Completed
		}
	}
	return latest
}

// OpencodeMessagesRunning reports whether a session has an assistant turn
// actively generating (the latest message is an assistant message with no
// time.completed). Used for busy-collision detection before sending a new prompt.
func OpencodeMessagesRunning(msgs []OpencodeMessageWithParts) bool {
	if len(msgs) == 0 {
		return false
	}
	last := msgs[0].Info
	for i := range msgs {
		if msgs[i].Info.Time.Created >= last.Time.Created {
			last = msgs[i].Info
		}
	}
	return strings.EqualFold(last.Role, "assistant") && last.Time.Completed == 0
}

// deriveStatus returns StatusRunning only while an assistant turn is actively
// generating (the latest message is an assistant message with no time.completed),
// StatusIdle otherwise, or "" when there are no messages yet.
//
// Note: a trailing *user* message (assistant not created yet) is treated as idle,
// not running. opencode creates the assistant message within ~1s of a turn
// starting, so the live "running" state is reported as soon as that appears; the
// sender's UI also shows an optimistic timer until then. Treating user-last as
// running instead would leave the session's DB status stuck at "running" forever
// if a turn is abandoned or fails before producing an assistant message.
func (s *OpencodeSync) deriveStatus(ordered []OpencodeMessageWithParts) string {
	if len(ordered) == 0 {
		return ""
	}
	last := ordered[len(ordered)-1].Info
	if strings.EqualFold(last.Role, "assistant") && last.Time.Completed == 0 {
		return protocol.StatusRunning
	}
	return protocol.StatusIdle
}

// ConvertOpencodePart maps a single Part to zero or more daemon events. role and
// model come from the part's owning message ("user"/"assistant", display model).
//
// Tool parts are observed as their state evolves: pending/running yields a
// tool_call; completed/error yields a tool_result. OpencodeSync deduplicates an
// exact canonical snapshot while preserving same-state input/output mutation.
func ConvertOpencodePart(p *OpencodePart, role, model string) []protocol.DaemonEvent {
	switch p.Type {
	case "text":
		text := strings.TrimSpace(p.Text)
		if text == "" {
			return nil
		}
		if strings.EqualFold(role, "user") {
			return []protocol.DaemonEvent{{Type: "user_text", Text: p.Text}}
		}
		return []protocol.DaemonEvent{{Type: "agent_text", Text: p.Text, Model: model}}

	case "reasoning":
		if strings.TrimSpace(p.Text) == "" || !strings.EqualFold(role, "assistant") {
			return nil
		}
		return []protocol.DaemonEvent{{Type: "agent_reasoning", Text: p.Text, Model: model}}

	case "retry":
		return []protocol.DaemonEvent{{
			Type:      "agent_retry",
			MessageID: p.MessageID,
			PartID:    p.ID,
			Attempt:   p.Attempt,
			RetryAt:   p.Time.Created,
			Error:     opencodeErrorMessage(p.Error),
		}}

	case "compaction":
		return []protocol.DaemonEvent{{
			Type:      "agent_compaction",
			MessageID: p.MessageID,
			PartID:    p.ID,
			Auto:      p.Auto,
			Overflow:  p.Overflow,
		}}

	case "file":
		return []protocol.DaemonEvent{{
			Type: "agent_file", MessageID: p.MessageID, PartID: p.ID,
			Mime: p.Mime, Filename: p.Filename, URL: p.URL,
			PartSource: append(json.RawMessage(nil), p.PartSource...),
		}}

	case "patch":
		return []protocol.DaemonEvent{{
			Type: "agent_patch", MessageID: p.MessageID, PartID: p.ID,
			Hash: p.Hash, Files: append([]string(nil), p.Files...),
		}}

	case "subtask":
		return []protocol.DaemonEvent{{
			Type: "agent_subtask", MessageID: p.MessageID, PartID: p.ID,
			Prompt: p.Prompt, Description: p.Description, Agent: p.Agent,
			Model: p.Model.Display(), Command: p.Command,
		}}

	case "agent":
		return []protocol.DaemonEvent{{
			Type: "agent_profile", MessageID: p.MessageID, PartID: p.ID,
			ProfileName: p.Name, PartSource: append(json.RawMessage(nil), p.PartSource...),
		}}

	case "tool":
		if p.State == nil {
			return nil
		}
		switch p.State.Status {
		case "completed":
			return []protocol.DaemonEvent{{Type: "tool_result", CallID: p.CallID, Output: p.State.Output}}
		case "error":
			out := p.State.Output
			if out == "" {
				out = p.State.Error
			}
			return []protocol.DaemonEvent{{Type: "tool_result", CallID: p.CallID, Output: out, Error: p.State.Error}}
		default: // pending | running
			return []protocol.DaemonEvent{{Type: "tool_call", CallID: p.CallID, Tool: p.Tool, Input: p.State.Input}}
		}

	case "step-finish":
		if p.Tokens == nil {
			return nil
		}
		// Usage rides on an agent_text (mirrors the codex token_count handling) so
		// the web attributes it to the session.
		return []protocol.DaemonEvent{{
			Type: "agent_text",
			Usage: &protocol.ContextUsage{
				InputTokens:  p.Tokens.Input,
				OutputTokens: p.Tokens.Output,
				CacheRead:    p.Tokens.Cache.Read,
				CacheCreate:  p.Tokens.Cache.Write,
			},
		}}

	default:
		// step-start and unknown future Parts are not surfaced.
		return nil
	}
}

func opencodeErrorMessage(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var parsed struct {
		Name string `json:"name"`
		Data struct {
			Message string `json:"message"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err == nil {
		if parsed.Data.Message != "" {
			return parsed.Data.Message
		}
		if parsed.Name != "" {
			return parsed.Name
		}
	}
	return string(raw)
}
