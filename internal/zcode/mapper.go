package zcode

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// mapper.go converts whitelisted ZCode rows into DaemonEvents. It is fully
// independent of internal/adapter/opencode.go (design §6.2 / ADR-001): it has
// its own event-id namespace (zcode:...), its own semantic-hash, and its own
// revision/replace logic. It never imports OpenCode types or functions.
//
// Content filter (design §5.5):
//   - A message is dropped whole if role∉{user,assistant}, synthetic=true,
//     system non-empty, hidden/internal=true, or visibility not user-visible.
//   - Only text/reasoning/tool/step-start/step-finish/file parts are mapped;
//     step-start participates in status only; timeline/unknown → nil + counter.
//   - File parts keep only basename + length-limited mime; URL/source cleared.

const (
	maxFileBasename = 255
	maxFileMime     = 128
)

// Mapper turns decoded ZCode rows into DaemonEvents. It is stateless per call;
// revision/previous-event-id bookkeeping lives in ZcodeSync (sync.go), which
// holds the per-part checkpoint state.
type Mapper struct {
	sourceID    string // 128-bit source id (32 hex); used in event-id namespace
	sourceIDHex string // first 12 hex chars of sourceID, for the namespace prefix
}

// NewMapper returns a Mapper bound to a source id. The source id seeds the
// event-id namespace so events are stable across daemon restarts and isolated
// across different storage roots.
func NewMapper(sourceID string) *Mapper {
	prefix := sourceID
	if len(prefix) > 12 {
		prefix = prefix[:12]
	}
	return &Mapper{sourceID: sourceID, sourceIDHex: prefix}
}

// MessageVisible reports whether a message passes the content filter (design
// §5.5). Returns false (drop whole message) for synthetic/system/hidden/etc.
func MessageVisible(m ZcodeMessageData) bool {
	if m.Role != "user" && m.Role != "assistant" {
		return false
	}
	if m.Synthetic {
		return false
	}
	if len(m.System) > 0 && string(m.System) != "null" && strings.TrimSpace(string(m.System)) != `""` {
		return false
	}
	if m.Hidden || m.Internal {
		return false
	}
	if m.Visibility != "" && m.Visibility != "visible" && m.Visibility != "user" {
		return false
	}
	return true
}

// SessionDiscovered builds the initial session_discovered event for a ZCode
// observer session. agent=zcode, source=observer, control_mode=legacy_read_only,
// capabilities=[history_sync].
func (mp *Mapper) SessionDiscovered(wireSessionID, title, cwd, model, status string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:         "session_discovered",
		SessionID:    wireSessionID,
		Title:        title,
		Cwd:          cwd,
		Model:        model,
		Status:       status,
		Source:       "observer",
		Agent:        "zcode",
		ControlMode:  protocol.ControlLegacyReadOnly,
		Capabilities: []string{"history_sync"},
		EventID:      mp.sessionEventID(wireSessionID, "discovered"),
	}
}

// TitleUpdate builds a session_title_update event.
func (mp *Mapper) TitleUpdate(wireSessionID, title, prevEventID string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:            "session_title_update",
		SessionID:       wireSessionID,
		Title:           title,
		PreviousEventID: prevEventID,
		EventID:         mp.titleEventID(wireSessionID, title),
	}
}

// ModelChanged builds a session_model_changed event.
func (mp *Mapper) ModelChanged(wireSessionID, model, prevEventID string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:            "session_model_changed",
		SessionID:       wireSessionID,
		Model:           model,
		PreviousEventID: prevEventID,
		EventID:         mp.modelEventID(wireSessionID, model),
	}
}

// SessionStatus builds a session_status event for a derived status change. The
// status is derived conservatively from DB content (last tool state, last
// assistant finish) — never from a live process signal. Only running/completed
// are produced; waiting_approval/waiting_question are intentionally never
// derived (design §6.5).
func (mp *Mapper) SessionStatus(wireSessionID, status, prevEventID string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:            "session_status",
		SessionID:       wireSessionID,
		Status:          status,
		Source:          "observer",
		Agent:           "zcode",
		PreviousEventID: prevEventID,
		EventID:         mp.statusEventID(wireSessionID, status),
	}
}

// SubagentDiscovered builds a subagent_discovered event linking a ZCode child
// session to its parent. The child is uploaded as an independent read-only
// session; this event tells Relay/Web/iOS to show it as a child under the
// parent's children list. Relay's reconcileSubagent is idempotent, so repeated
// emission on each poll is safe.
func (mp *Mapper) SubagentDiscovered(wireParentID, wireChildID, agentType, title, prevEventID string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:            "subagent_discovered",
		SessionID:       wireParentID,
		AgentID:         wireChildID,
		ParentSessionID: wireParentID,
		RootSessionID:   wireParentID,
		IsSubagent:      true,
		SubAgentType:    agentType,
		SubAgentDesc:    title,
		Agent:           "zcode",
		Source:          "observer",
		PreviousEventID: prevEventID,
		EventID:         mp.subagentEventID(wireParentID, wireChildID),
	}
}

// MapPart maps one ZCode part into zero or one content DaemonEvent. step-start
// returns (nil, "") — it only informs status, no content. timeline/unknown
// returns (nil, "unknown") so the caller increments zcode_unknown_part_total
// without uploading raw JSON.
//
// Returns: (event, reason). reason=="" means an event was produced; "unknown"
// means no event and the part type should be counted; "step-start" means no
// content event (status-only).
func (mp *Mapper) MapPart(wireSessionID, wireMessageID, nativePartID string, part ZcodePartData, model, prevEventID string, revision int) (protocol.DaemonEvent, string) {
	base := protocol.DaemonEvent{
		SessionID:       wireSessionID,
		MessageID:       wireMessageID,
		PartID:          WirePartID(mp.sourceID, nativePartID),
		Model:           model,
		PreviousEventID: prevEventID,
		Revision:        revision,
	}
	switch part.Type {
	case "text":
		if strings.TrimSpace(part.Text) == "" {
			return protocol.DaemonEvent{}, "skip"
		}
		base.Type = "agent_text"
		if model == "" {
			// user text if the message role is user is handled by MapUserText;
			// bare text parts default to agent_text with the resolved model.
		}
		base.Text = part.Text
		base.Snapshot = part.Text
		base.Replace = true
		base.EventID = mp.partEventID(nativePartID, "text", part.Text)
		return base, ""
	case "reasoning":
		text := part.Text
		if text == "" {
			text = part.Reasoning
		}
		if strings.TrimSpace(text) == "" {
			return protocol.DaemonEvent{}, "skip"
		}
		base.Type = "agent_reasoning"
		base.Text = text
		base.Snapshot = text
		base.Replace = true
		base.EventID = mp.partEventID(nativePartID, "reasoning", text)
		return base, ""
	case "tool":
		if part.CallID == "" {
			return protocol.DaemonEvent{}, "skip"
		}
		ev, ok := mp.mapTool(base, nativePartID, part)
		if !ok {
			return protocol.DaemonEvent{}, "skip"
		}
		return ev, ""
	case "file":
		return mp.mapFile(base, nativePartID, part), ""
	case "step-finish":
		if part.Usage == nil {
			return protocol.DaemonEvent{}, "skip"
		}
		// usage-only agent_text: no visible text, just token accounting.
		base.Type = "agent_text"
		base.Usage = &protocol.ContextUsage{
			InputTokens:     int(part.Usage.InputTokens),
			OutputTokens:    int(part.Usage.OutputTokens),
			ReasoningTokens: int(part.Usage.ReasoningTokens),
			TotalTokens:     int(part.Usage.TotalTokens),
		}
		base.EventID = mp.partEventID(nativePartID, "usage", fmt.Sprintf("%d-%d-%d-%d", part.Usage.InputTokens, part.Usage.OutputTokens, part.Usage.ReasoningTokens, part.Usage.TotalTokens))
		return base, ""
	case "step-start":
		return protocol.DaemonEvent{}, "step-start"
	default:
		// timeline and any unknown type: never upload raw JSON; caller counts.
		return protocol.DaemonEvent{}, "unknown"
	}
}

func (mp *Mapper) mapTool(base protocol.DaemonEvent, nativePartID string, part ZcodePartData) (protocol.DaemonEvent, bool) {
	status := ""
	if part.State != nil {
		status = part.State.Status
	}
	base.Tool = part.Tool
	base.CallID = part.CallID
	switch status {
	case "pending", "running":
		base.Type = "tool_call"
		if part.State != nil {
			base.Input = canonicalJSON(part.State.Input)
		}
		base.Status = status
		base.EventID = mp.toolEventID(nativePartID, status, part)
		return base, true
	case "completed":
		base.Type = "tool_result"
		if part.State != nil {
			base.Output = part.State.Output
		}
		base.Status = status
		base.EventID = mp.toolEventID(nativePartID, status, part)
		return base, true
	case "error":
		base.Type = "tool_result"
		if part.State != nil {
			base.Error = part.State.Error
		}
		base.Status = status
		base.EventID = mp.toolEventID(nativePartID, status, part)
		return base, true
	default:
		// tool without a known state → treat as a call so it's visible.
		base.Type = "tool_call"
		base.Status = status
		base.EventID = mp.toolEventID(nativePartID, status, part)
		return base, true
	}
}

func (mp *Mapper) mapFile(base protocol.DaemonEvent, nativePartID string, part ZcodePartData) protocol.DaemonEvent {
	base.Type = "agent_file"
	if part.File != nil {
		base.Filename = limitString(filepath.Base(part.File.Filename), maxFileBasename)
		base.Mime = limitString(part.File.Mime, maxFileMime)
	}
	// URL and PartSource are explicitly cleared (never carried from source).
	base.URL = ""
	base.PartSource = nil
	base.EventID = mp.partEventID(nativePartID, "file", base.Filename+"|"+base.Mime)
	return base
}

// MapUserText builds a user_text event from a user message's text parts. It
// concatenates non-empty text parts of a user message.
func (mp *Mapper) MapUserText(wireSessionID, wireMessageID, nativeMessageID, text, prevEventID string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:            "user_text",
		SessionID:       wireSessionID,
		MessageID:       wireMessageID,
		Text:            text,
		PreviousEventID: prevEventID,
		EventID:         mp.userTextEventID(nativeMessageID, text),
	}
}

// MapTodo builds an agent_todo event from the current todo snapshot.
func (mp *Mapper) MapTodo(wireSessionID string, todos []TodoRow, prevEventID string) protocol.DaemonEvent {
	items := make([]protocol.TodoItem, 0, len(todos))
	for _, t := range todos {
		items = append(items, protocol.TodoItem{
			Content: t.Content, Status: t.Status, Priority: t.Priority,
		})
	}
	return protocol.DaemonEvent{
		Type:            "agent_todo",
		SessionID:       wireSessionID,
		Todos:           items,
		PreviousEventID: prevEventID,
		EventID:         mp.todoEventID(wireSessionID, items),
	}
}

// MapMessageError builds an error event from an assistant message error, using
// only the safe message text (never the raw error JSON).
func (mp *Mapper) MapMessageError(wireSessionID, nativeMessageID, message, prevEventID string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:            "error",
		SessionID:       wireSessionID,
		Error:           message,
		PreviousEventID: prevEventID,
		EventID:         mp.errorEventID(nativeMessageID, message),
	}
}

// --- event id namespace ---------------------------------------------------

// All event ids use the namespace zcode:<source-id-prefix>:<kind>:... and never
// contain the native session/message/part id in plaintext (only its hash).
func (mp *Mapper) partEventID(nativePartID, kind, content string) string {
	return fmt.Sprintf("zcode:%s:%s:%s:%s", mp.sourceIDHex, kind, hashID(nativePartID), semanticHash(content))
}

func (mp *Mapper) toolEventID(nativePartID, status string, part ZcodePartData) string {
	canonical := canonicalJSON(map[string]any{
		"tool":   part.Tool,
		"status": status,
		"input":  json.RawMessage(nil),
		"output": "",
	})
	if part.State != nil {
		canonical = canonicalJSON(map[string]any{
			"tool":   part.Tool,
			"status": status,
			"input":  json.RawMessage(part.State.Input),
			"output": part.State.Output,
			"error":  part.State.Error,
		})
	}
	return fmt.Sprintf("zcode:%s:tool:%s:%s:%s", mp.sourceIDHex, hashID(nativePartID), status, shortHash(string(canonical)))
}

func (mp *Mapper) sessionEventID(wireSessionID, kind string) string {
	return fmt.Sprintf("zcode:%s:session:%s:%s", mp.sourceIDHex, hashID(wireSessionID), kind)
}

func (mp *Mapper) titleEventID(wireSessionID, title string) string {
	return fmt.Sprintf("zcode:%s:title:%s:%s", mp.sourceIDHex, hashID(wireSessionID), semanticHash(title))
}

func (mp *Mapper) modelEventID(wireSessionID, model string) string {
	return fmt.Sprintf("zcode:%s:model:%s:%s", mp.sourceIDHex, hashID(wireSessionID), semanticHash(model))
}

func (mp *Mapper) statusEventID(wireSessionID, status string) string {
	return fmt.Sprintf("zcode:%s:status:%s:%s", mp.sourceIDHex, hashID(wireSessionID), semanticHash(status))
}

func (mp *Mapper) subagentEventID(wireParentID, wireChildID string) string {
	return fmt.Sprintf("zcode:%s:subagent:%s:%s", mp.sourceIDHex, hashID(wireParentID), hashID(wireChildID))
}

func (mp *Mapper) userTextEventID(nativeMessageID, text string) string {
	return fmt.Sprintf("zcode:%s:user:%s:%s", mp.sourceIDHex, hashID(nativeMessageID), semanticHash(text))
}

func (mp *Mapper) todoEventID(wireSessionID string, todos []protocol.TodoItem) string {
	return fmt.Sprintf("zcode:%s:todo:%s:%s", mp.sourceIDHex, hashID(wireSessionID), shortHash(string(canonicalJSON(todos))))
}

func (mp *Mapper) errorEventID(nativeMessageID, message string) string {
	return fmt.Sprintf("zcode:%s:error:%s:%s", mp.sourceIDHex, hashID(nativeMessageID), semanticHash(message))
}

// WirePartID returns a stable, native-id-free wire id for a part (used as the
// PartID field so clients can upsert without seeing the native id).
func WirePartID(sourceID, nativePartID string) string {
	return "zcodep-" + hashWithSource(sourceID, nativePartID)
}

// --- hash helpers ---------------------------------------------------------

func hashID(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:8])
}

func hashWithSource(sourceID, id string) string {
	h := sha256.New()
	h.Write([]byte(sourceID))
	h.Write([]byte{0x00})
	h.Write([]byte(id))
	return hex.EncodeToString(h.Sum(nil)[:16])
}

// semanticHash produces a stable hash of content for event-id stability. It is
// applied to display-relevant content only.
func semanticHash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:8])
}

func shortHash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:8])
}

// canonicalJSON marshals value with map keys sorted, so structurally-equal JSON
// produces identical bytes regardless of key order.
func canonicalJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte("{}")
	}
	var normalized any
	dec := json.NewDecoder(strings.NewReader(string(encoded)))
	dec.UseNumber()
	if dec.Decode(&normalized) != nil {
		return encoded
	}
	canonical, err := json.Marshal(normalized)
	if err != nil {
		return encoded
	}
	return canonical
}

// canonicalJSONSorted is used where explicit key sorting is wanted (mirrors the
// design's "map key sorted" requirement for semantic hashing).
func canonicalJSONSorted(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte("{}")
	}
	var raw map[string]any
	if json.Unmarshal(encoded, &raw) != nil {
		return encoded
	}
	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string]any, len(raw))
	for _, k := range keys {
		out[k] = raw[k]
	}
	b, _ := json.Marshal(out)
	return b
}

func limitString(s string, max int) string {
	if len(s) > max {
		return s[:max]
	}
	return s
}
