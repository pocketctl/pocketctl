package zcode

import (
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// sync.go is the independent ZCode snapshot differ. It is deliberately separate
// from internal/adapter/opencode.go (design §6.2 / ADR-001): it does NOT import
// OpencodeSync or ConvertOpencodePart, and does not modify any OpenCode file.
// Some structural similarity to the OpenCode differ is accepted to avoid
// widening the OpenCode regression surface.
//
// ZcodeSync is initialized with a wire session id, a source id, and the
// acknowledged cursor state (loaded from the checkpoint). It produces
// DaemonEvents for newly-seen or changed content, and tracks per-part semantic
// hash / event id / revision so the same content never re-emits and a change to
// the same source part yields a new revision with Replace=true.

// partCheckpoint is the per-part mutable state ZcodeSync tracks for revisioning.
type partCheckpoint struct {
	eventID  string
	revision int
	semantic string // semantic hash of the last-emitted content
}

// sessionCheckpoint holds the rolling per-session differ state.
type sessionCheckpoint struct {
	titleEventID        string
	titleHash           string
	modelEventID        string
	modelHash           string
	statusHash          string // hash of the last-emitted status (for session_status diffing)
	todoEventID         string
	todoHash            string
	parts               map[string]partCheckpoint // keyed by wire part id
	lastEventID         string                    // most recently emitted event id (for PreviousEventID chaining)
	pendingCommit       pendingPartCommit         // uncommitted DiffPart state, applied by CommitPart
	pendingStatusCommit pendingStatusCommit       // uncommitted DiffStatus state
}

// ZcodeSync computes incremental DaemonEvents for one ZCode session. It is
// independent of any OpenCode differ. Reuse one ZcodeSync per session for the
// life of the observed content; reset it (NewZcodeSync) when the source cursor
// is fully reset (storage/source id change).
type ZcodeSync struct {
	mapper *Mapper
	wireID string
	state  sessionCheckpoint
}

// NewZcodeSync builds a differ bound to a wire session id and source id. The
// initial snapshot (history backfill) is assumed to NOT produce running status;
// callers drive live status separately.
func NewZcodeSync(sourceID, wireSessionID string) *ZcodeSync {
	return &ZcodeSync{
		mapper: NewMapper(sourceID),
		wireID: wireSessionID,
		state: sessionCheckpoint{
			parts: make(map[string]partCheckpoint),
		},
	}
}

// DiffSessionMeta emits session_discovered (first time), title and model update
// events when they change. The very first call for a session emits discovered
// (which carries the initial status); subsequent calls emit title/model deltas
// only when the hash differs. Status deltas are handled separately by DiffStatus
// (called after content scanning, once the derived status is known).
func (z *ZcodeSync) DiffSessionMeta(title, model, status string) []protocol.DaemonEvent {
	var out []protocol.DaemonEvent
	if z.state.titleEventID == "" && z.state.modelEventID == "" {
		// First observation of this session → session_discovered.
		ev := z.mapper.SessionDiscovered(z.wireID, title, "", model, status)
		z.state.lastEventID = ev.EventID
		z.state.titleEventID = ev.EventID
		z.state.titleHash = semanticHash(title)
		z.state.modelEventID = ev.EventID
		z.state.modelHash = semanticHash(model)
		z.state.statusHash = semanticHash(status) // seed so DiffStatus doesn't re-emit
		out = append(out, ev)
		return out
	}
	if semanticHash(title) != z.state.titleHash {
		ev := z.mapper.TitleUpdate(z.wireID, title, z.state.lastEventID)
		z.state.titleEventID = ev.EventID
		z.state.titleHash = semanticHash(title)
		z.state.lastEventID = ev.EventID
		out = append(out, ev)
	}
	if semanticHash(model) != z.state.modelHash {
		ev := z.mapper.ModelChanged(z.wireID, model, z.state.lastEventID)
		z.state.modelEventID = ev.EventID
		z.state.modelHash = semanticHash(model)
		z.state.lastEventID = ev.EventID
		out = append(out, ev)
	}
	return out
}

// DiffStatus emits a session_status event when the derived status changes. On
// the very first call after session_discovered, the status hash is already
// seeded from DiffSessionMeta, so no redundant event is produced if the derived
// status matches the initial one.
//
// IMPORTANT: like DiffPart, DiffStatus does NOT update the differ state. The
// caller must call CommitStatus only AFTER the event has been successfully
// emitted, so a rejected event is retried on the next poll.
func (z *ZcodeSync) DiffStatus(status string) []protocol.DaemonEvent {
	h := semanticHash(status)
	if h == z.state.statusHash {
		return nil
	}
	ev := z.mapper.SessionStatus(z.wireID, status, z.state.lastEventID)
	z.state.pendingStatusCommit = pendingStatusCommit{hash: h, eventID: ev.EventID}
	return []protocol.DaemonEvent{ev}
}

// CommitStatus commits the differ state for the most recent DiffStatus call.
// Call this ONLY after the session_status event has been successfully emitted.
func (z *ZcodeSync) CommitStatus() {
	psc := z.state.pendingStatusCommit
	if psc.hash == "" {
		return
	}
	z.state.statusHash = psc.hash
	z.state.lastEventID = psc.eventID
	z.state.pendingStatusCommit = pendingStatusCommit{}
}

type pendingStatusCommit struct {
	hash    string
	eventID string
}

// DiffMessage emits the user_text (for a visible user message) or an assistant
// message error. It does NOT emit per-part content; use DiffPart for that.
// Returns the events produced.
func (z *ZcodeSync) DiffMessage(nativeMessageID, wireMessageID string, data ZcodeMessageData) []protocol.DaemonEvent {
	if !MessageVisible(data) {
		return nil
	}
	var out []protocol.DaemonEvent
	if data.Role == "user" {
		text := extractUserText(data)
		if strings.TrimSpace(text) == "" {
			return nil
		}
		ev := z.mapper.MapUserText(z.wireID, wireMessageID, nativeMessageID, text, z.state.lastEventID)
		z.state.lastEventID = ev.EventID
		out = append(out, ev)
		return out
	}
	// assistant message error (safe text only).
	if data.Error != nil && strings.TrimSpace(data.Error.Message) != "" {
		ev := z.mapper.MapMessageError(z.wireID, nativeMessageID, data.Error.Message, z.state.lastEventID)
		z.state.lastEventID = ev.EventID
		out = append(out, ev)
	}
	return out
}

// DiffPart emits a content event for a part if it is new or its semantic hash
// changed. Returns the event (if any) and a reason:
//   - "" → event produced (caller MUST call CommitPart after successful emit)
//   - "skip"/"step-start"/"unknown" → no event (filtered / status-only / unknown)
//
// IMPORTANT: DiffPart does NOT update the differ state. The caller must call
// CommitPart(nativePartID) only AFTER the event has been successfully emitted
// (accepted by the low-priority gate). Otherwise a rejected event would be
// permanently marked as "seen" and never retried.
func (z *ZcodeSync) DiffPart(nativePartID, wireMessageID string, part ZcodePartData, model string) (protocol.DaemonEvent, string) {
	ev, reason := z.mapper.MapPart(z.wireID, wireMessageID, nativePartID, part, model, z.state.lastEventID, 0)
	if reason != "" {
		return protocol.DaemonEvent{}, reason
	}
	semantic := ev.ContentHash
	if semantic == "" {
		semantic = stableSemantic(ev)
	}
	wirePart := WirePartID(z.mapper.sourceID, nativePartID)
	prev, seen := z.state.parts[wirePart]
	if seen && prev.semantic == semantic {
		return protocol.DaemonEvent{}, "skip"
	}
	revision := 1
	if seen {
		revision = prev.revision + 1
	}
	ev.Revision = revision
	if seen {
		ev.PreviousEventID = prev.eventID
	}
	ev.Replace = true
	// NOTE: do NOT update z.state.parts or z.state.lastEventID here. The caller
	// commits via CommitPart only after a successful emit, so a rejected event
	// is retried on the next poll with the same revision/event id.
	// Stash the pending commit so CommitPart has what it needs.
	z.state.pendingCommit = pendingPartCommit{
		wirePart: wirePart,
		eventID:  ev.EventID,
		revision: revision,
		semantic: semantic,
	}
	return ev, ""
}

// CommitPart commits the differ state for the most recent DiffPart call. Call
// this ONLY after the event has been successfully emitted.
func (z *ZcodeSync) CommitPart() {
	pc := z.state.pendingCommit
	if pc.wirePart == "" {
		return
	}
	z.state.parts[pc.wirePart] = partCheckpoint{eventID: pc.eventID, revision: pc.revision, semantic: pc.semantic}
	z.state.lastEventID = pc.eventID
	z.state.pendingCommit = pendingPartCommit{}
}

// pendingPartCommit holds the differ state update for the most recent DiffPart,
// applied atomically by CommitPart after a successful emit.
type pendingPartCommit struct {
	wirePart string
	eventID  string
	revision int
	semantic string
}

// DiffTodos emits an agent_todo event when the snapshot hash changes, including
// the transition from non-empty to empty (a clear).
func (z *ZcodeSync) DiffTodos(todos []TodoRow) []protocol.DaemonEvent {
	items := make([]protocol.TodoItem, 0, len(todos))
	for _, t := range todos {
		items = append(items, protocol.TodoItem{Content: t.Content, Status: t.Status, Priority: t.Priority})
	}
	h := semanticHash(string(canonicalJSON(items)))
	if h == z.state.todoHash && z.state.todoEventID != "" {
		return nil
	}
	ev := z.mapper.MapTodo(z.wireID, todos, z.state.lastEventID)
	z.state.todoHash = h
	z.state.todoEventID = ev.EventID
	z.state.lastEventID = ev.EventID
	return []protocol.DaemonEvent{ev}
}

// LastEventID returns the most recently emitted event id (for chaining / cursor
// persistence).
func (z *ZcodeSync) LastEventID() string { return z.state.lastEventID }

// extractUserText concatenates non-empty text parts of a user message.
func extractUserText(data ZcodeMessageData) string {
	var sb strings.Builder
	for _, p := range data.Parts {
		if p.Type == "text" && p.Text != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

// stableSemantic returns a stable semantic string derived from an event's
// stable fields (event id + text + tool + status), so repeated identical content
// is recognized as unchanged without re-hashing raw payloads.
func stableSemantic(ev protocol.DaemonEvent) string {
	return semanticHash(ev.EventID + "|" + ev.Text + "|" + ev.Tool + "|" + ev.Status + "|" + ev.Output + "|" + ev.Error)
}
