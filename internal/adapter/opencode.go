package adapter

import (
	"encoding/json"
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
	ID    string `json:"id"`
	Title string `json:"title"`
	Time  struct {
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
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	Role      string `json:"role"` // "user" | "assistant"
	Model     *struct {
		ProviderID string `json:"providerID"`
		ModelID    string `json:"modelID"`
	} `json:"model,omitempty"`
	Time struct {
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
// Dedup rules (mirror the SSE demux): text/step-finish parts emit once; tool
// parts re-emit when their status changes (pending/running→completed/error), and
// a given tool_call is forwarded at most once.
type OpencodeSync struct {
	sessionID  string
	partState  map[string]string // partID → last emitted marker
	seenCalls  map[string]bool    // callID → tool_call already emitted
	emitUser   bool               // whether to emit user_text parts
	lastStatus string             // last emitted session_status (dedupe)
}

// NewOpencodeSync creates a differ for a session. emitUser controls whether user
// message parts produce user_text events (terminal sessions: true, since nothing
// else surfaces them; owned sessions echo user text on send instead).
func NewOpencodeSync(sessionID string, emitUser bool) *OpencodeSync {
	return &OpencodeSync{
		sessionID: sessionID,
		partState: make(map[string]string),
		seenCalls: make(map[string]bool),
		emitUser:  emitUser,
	}
}

// Diff returns events for anything new/changed since the last snapshot. Messages
// are processed oldest-first (by time.created) for conversational order.
func (s *OpencodeSync) Diff(msgs []OpencodeMessageWithParts) []protocol.DaemonEvent {
	ordered := make([]OpencodeMessageWithParts, len(msgs))
	copy(ordered, msgs)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].Info.Time.Created < ordered[j].Info.Time.Created
	})

	var out []protocol.DaemonEvent
	for _, m := range ordered {
		role := m.Info.Role
		model := m.Info.OpencodeModelDisplay()
		for i := range m.Parts {
			part := &m.Parts[i]
			marker := "done"
			if part.Type == "tool" && part.State != nil {
				marker = part.State.Status
			}
			if s.partState[part.ID] == marker {
				continue
			}
			s.partState[part.ID] = marker

			for _, ev := range ConvertOpencodePart(part, role, model) {
				if ev.Type == "user_text" && !s.emitUser {
					continue
				}
				if ev.Type == "tool_call" {
					if s.seenCalls[ev.CallID] {
						continue
					}
					s.seenCalls[ev.CallID] = true
				}
				ev.SessionID = s.sessionID
				out = append(out, ev)
			}
		}
	}

	// Derive the session's working state from the latest message and emit a
	// session_status transition on change. opencode never streams an explicit
	// "turn done" event, so we infer it: an assistant message with time.completed
	// set means the turn finished (idle/ready); otherwise (latest is a user
	// message, or an assistant message still in progress) the model is working.
	if status := s.deriveStatus(ordered); status != "" && status != s.lastStatus {
		s.lastStatus = status
		out = append(out, protocol.DaemonEvent{
			Type:      "session_status",
			SessionID: s.sessionID,
			Status:    status,
		})
	}
	return out
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
// tool_call; completed/error yields a tool_result. The observation layer
// (DirWatch / SSE demux) is responsible for not double-forwarding the same
// tool_call across repeated part updates (dedupe by call_id).
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
		// reasoning / step-start / patch / file — not surfaced.
		return nil
	}
}
