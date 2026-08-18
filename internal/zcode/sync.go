package zcode

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync/atomic"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// sync.go is the independent ZCode snapshot differ. It is deliberately separate
// from internal/adapter/opencode.go (design §6.2 / ADR-001): it does NOT import
// OpencodeSync or ConvertOpencodePart, and does not modify any OpenCode file.
// Some structural similarity to the OpenCode differ is accepted to avoid
// widening the OpenCode regression surface.
//
// ZcodeSync is initialized with a wire session id, a source id, and (optionally)
// a restart checkpoint hydrated from the cursor. It produces DaemonEvents for
// newly-seen or changed content, and tracks per-part semantic hash / event id /
// revision so the same content never re-emits and a change to the same source
// part yields a new revision with Replace=true.
//
// Preview/commit model (ADR-0002): Preview* methods are pure — they never
// mutate the receiver, and the same receiver plus the same input always yield
// the same event ids and proposed commit. Callers prepare a page on a
// disposable scratch clone (via Clone + applyProvisional), then apply the
// canonical store-assigned commits with ApplyAccepted once the page is durable.

// partCheckpoint is the per-part mutable state ZcodeSync tracks for revisioning.
type partCheckpoint struct {
	eventID  string
	revision int
	semantic string // semantic hash of the last-emitted content
}

// msgCheckpoint is the per-message mutable state: the last-emitted content
// identity and its commit order, so unchanged messages are recognized inside
// mutation windows and cross-stream ACK order cannot regress the state.
type msgCheckpoint struct {
	eventID  string
	semantic string
	order    uint64
}

// sessionCheckpoint holds the rolling per-session differ state.
type sessionCheckpoint struct {
	titleEventID    string
	titleHash       string
	modelEventID    string
	modelHash       string
	statusHash      string // hash of the last-emitted status (for session_status diffing)
	todoEventID     string
	todoHash        string
	subagentEventID string
	msgs            map[string]msgCheckpoint  // keyed by wire message id
	parts           map[string]partCheckpoint // keyed by wire part id
	lastEventID     string                    // most recently emitted event id (for PreviousEventID chaining)
	lastCommitOrder uint64                    // highest canonical commit order applied
}

// ZcodeSync computes incremental DaemonEvents for one ZCode session. It is
// independent of any OpenCode differ. Reuse one ZcodeSync per session for the
// life of the observed content; rebuild it from the cursor checkpoint after a
// restart (NewZcodeSyncFromSessionCursor) instead of reusing a stale instance.
type ZcodeSync struct {
	mapper *Mapper
	wireID string
	state  sessionCheckpoint
}

// DiffBatch is the result of one preview: the generated events and the
// content-free commit that the durable cursor records alongside them. SkipReason
// is set when the row produced no event (filtered / status-only / unknown /
// unchanged).
type DiffBatch struct {
	Events     []protocol.DaemonEvent
	Commit     SyncCommit
	SkipReason string
}

// NewZcodeSync builds a differ bound to a wire session id and source id with an
// empty projection. The initial snapshot (history backfill) is assumed to NOT
// produce running status; callers drive live status separately.
func NewZcodeSync(sourceID, wireSessionID string) *ZcodeSync {
	return &ZcodeSync{
		mapper: NewMapper(sourceID),
		wireID: wireSessionID,
		state: sessionCheckpoint{
			msgs:  make(map[string]msgCheckpoint),
			parts: make(map[string]partCheckpoint),
		},
	}
}

// NewZcodeSyncFromCheckpoint rebuilds the projection from a durable sync
// checkpoint. Malformed checkpoints are rejected.
func NewZcodeSyncFromCheckpoint(sourceID, wireSessionID string, checkpoint SyncCheckpoint) (*ZcodeSync, error) {
	if err := validateCheckpoint(&checkpoint); err != nil {
		return nil, err
	}
	z := NewZcodeSync(sourceID, wireSessionID)
	z.state.titleEventID = checkpoint.TitleEventID
	z.state.titleHash = checkpoint.TitleHash
	z.state.modelEventID = checkpoint.ModelEventID
	z.state.modelHash = checkpoint.ModelHash
	z.state.statusHash = checkpoint.StatusHash
	z.state.todoEventID = checkpoint.TodoEventID
	z.state.todoHash = checkpoint.TodoHash
	z.state.subagentEventID = checkpoint.SubagentEventID
	z.state.lastEventID = checkpoint.LastEventID
	z.state.lastCommitOrder = checkpoint.LastCommitOrder
	for id, m := range checkpoint.Messages {
		z.state.msgs[id] = msgCheckpoint{eventID: m.EventID, semantic: m.SemanticHash, order: m.CommitOrder}
	}
	for id, p := range checkpoint.Parts {
		z.state.parts[id] = partCheckpoint{eventID: p.EventID, revision: p.Revision, semantic: p.SemanticHash}
	}
	return z, nil
}

// speculativeHydrations counts full speculative-projection rebuilds (the
// O(pending) hydration); tests use it to prove a hot path does not pay for
// one.
var speculativeHydrations atomic.Uint64

// NewZcodeSyncFromSessionCursor rebuilds the speculative projection used for
// later rows: it first applies the durable Sync checkpoint, then validates and
// applies every existing pending SyncCommit in increasing commit order. This
// does not mark those pending entries acknowledged and does not change the
// durable checkpoint — it only ensures a restart does not reuse a part revision
// or lose the previous-event chain while earlier emitted work awaits ACK.
func NewZcodeSyncFromSessionCursor(sourceID, wireSessionID string, cursor SessionCursor) (*ZcodeSync, error) {
	speculativeHydrations.Add(1)
	z, err := NewZcodeSyncFromCheckpoint(sourceID, wireSessionID, cursor.Sync)
	if err != nil {
		return nil, err
	}
	var commits []SyncCommit
	for _, pp := range cursor.Pending {
		if pp.Commit.CommitOrder > 0 {
			commits = append(commits, pp.Commit)
		}
	}
	sort.Slice(commits, func(i, j int) bool {
		return commits[i].CommitOrder < commits[j].CommitOrder
	})
	for _, c := range commits {
		if err := z.applyCommit(c); err != nil {
			return nil, err
		}
	}
	return z, nil
}

func validateCheckpoint(cp *SyncCheckpoint) error {
	for id, m := range cp.Messages {
		if m.EventID == "" || m.SemanticHash == "" {
			return fmt.Errorf("zcode sync: message %s is missing event id or semantic hash", id)
		}
	}
	for id, p := range cp.Parts {
		if p.Revision < 1 {
			return fmt.Errorf("zcode sync: part %s has invalid revision %d", id, p.Revision)
		}
		if p.EventID == "" || p.SemanticHash == "" {
			return fmt.Errorf("zcode sync: part %s revision %d is missing event id or semantic hash", id, p.Revision)
		}
	}
	return nil
}

// Clone returns an independent deep copy. Mutating the clone (including
// applying commits) never affects the receiver.
func (z *ZcodeSync) Clone() *ZcodeSync {
	c := &ZcodeSync{
		mapper: NewMapper(z.mapper.sourceID),
		wireID: z.wireID,
		state:  z.state,
	}
	c.state.parts = make(map[string]partCheckpoint, len(z.state.parts))
	for k, v := range z.state.parts {
		c.state.parts[k] = v
	}
	c.state.msgs = make(map[string]msgCheckpoint, len(z.state.msgs))
	for k, v := range z.state.msgs {
		c.state.msgs[k] = v
	}
	return c
}

// Checkpoint exports the current projection as a content-free SyncCheckpoint.
func (z *ZcodeSync) Checkpoint() SyncCheckpoint {
	cp := SyncCheckpoint{
		LastCommitOrder: z.state.lastCommitOrder,
		LastEventID:     z.state.lastEventID,
		TitleEventID:    z.state.titleEventID,
		TitleHash:       z.state.titleHash,
		ModelEventID:    z.state.modelEventID,
		ModelHash:       z.state.modelHash,
		StatusHash:      z.state.statusHash,
		TodoEventID:     z.state.todoEventID,
		TodoHash:        z.state.todoHash,
		SubagentEventID: z.state.subagentEventID,
	}
	if len(z.state.parts) > 0 {
		cp.Parts = make(map[string]PartCheckpoint, len(z.state.parts))
		for k, v := range z.state.parts {
			cp.Parts[k] = PartCheckpoint{EventID: v.eventID, Revision: v.revision, SemanticHash: v.semantic}
		}
	}
	if len(z.state.msgs) > 0 {
		cp.Messages = make(map[string]MessageCheckpoint, len(z.state.msgs))
		for k, v := range z.state.msgs {
			cp.Messages[k] = MessageCheckpoint{EventID: v.eventID, SemanticHash: v.semantic, CommitOrder: v.order}
		}
	}
	return cp
}

// --- preview API (pure) -----------------------------------------------------

// PreviewSessionMeta previews session_discovered (first observation), title and
// model update events when they change. Status deltas are handled separately by
// PreviewStatus.
func (z *ZcodeSync) PreviewSessionMeta(title, model, status string) (DiffBatch, error) {
	var batch DiffBatch
	if z.state.titleEventID == "" && z.state.modelEventID == "" {
		// First observation of this session → session_discovered.
		ev := z.mapper.SessionDiscovered(z.wireID, title, "", model, status)
		batch.Events = append(batch.Events, ev)
		batch.Commit.Title = &NamedCommit{EventID: ev.EventID, Hash: semanticHash(title)}
		batch.Commit.Model = &NamedCommit{EventID: ev.EventID, Hash: semanticHash(model)}
		batch.Commit.StatusHash = semanticHash(status) // seed so PreviewStatus doesn't re-emit
		batch.Commit.LastEventID = ev.EventID
		return batch, nil
	}
	prev := z.state.lastEventID
	if semanticHash(title) != z.state.titleHash {
		ev := z.mapper.TitleUpdate(z.wireID, title, prev)
		batch.Events = append(batch.Events, ev)
		batch.Commit.Title = &NamedCommit{EventID: ev.EventID, Hash: semanticHash(title)}
		batch.Commit.LastEventID = ev.EventID
		prev = ev.EventID
	}
	if semanticHash(model) != z.state.modelHash {
		ev := z.mapper.ModelChanged(z.wireID, model, prev)
		batch.Events = append(batch.Events, ev)
		batch.Commit.Model = &NamedCommit{EventID: ev.EventID, Hash: semanticHash(model)}
		batch.Commit.LastEventID = ev.EventID
	}
	return batch, nil
}

// PreviewMessage previews the user_text (for a visible user message) or an
// assistant message error. It does not preview per-part content; use
// PreviewPart for that.
func (z *ZcodeSync) PreviewMessage(nativeMessageID, wireMessageID string, data ZcodeMessageData) (DiffBatch, error) {
	if !MessageVisible(data) {
		return DiffBatch{}, nil
	}
	build := func() (DiffBatch, string) {
		if data.Role == "user" {
			text := extractUserText(data)
			if strings.TrimSpace(text) == "" {
				return DiffBatch{}, ""
			}
			ev := z.mapper.MapUserText(z.wireID, wireMessageID, nativeMessageID, text, z.state.lastEventID)
			return DiffBatch{
				Events: []protocol.DaemonEvent{ev},
				Commit: SyncCommit{
					Message:     &MessageCommit{WireMessageID: wireMessageID, EventID: ev.EventID, SemanticHash: semanticHash(text)},
					LastEventID: ev.EventID,
				},
			}, semanticHash(text)
		}
		// assistant message error (safe text only).
		if data.Error != nil && strings.TrimSpace(data.Error.Message) != "" {
			ev := z.mapper.MapMessageError(z.wireID, nativeMessageID, data.Error.Message, z.state.lastEventID)
			return DiffBatch{
				Events: []protocol.DaemonEvent{ev},
				Commit: SyncCommit{
					Message:     &MessageCommit{WireMessageID: wireMessageID, EventID: ev.EventID, SemanticHash: semanticHash(data.Error.Message)},
					LastEventID: ev.EventID,
				},
			}, semanticHash(data.Error.Message)
		}
		return DiffBatch{}, ""
	}
	batch, semantic := build()
	if semantic != "" {
		if prev, seen := z.state.msgs[wireMessageID]; seen && prev.semantic == semantic {
			return DiffBatch{SkipReason: "skip"}, nil
		}
	}
	return batch, nil
}

// PreviewPart previews a content event for a part if it is new or its semantic
// hash changed. SkipReason carries the filter reason when no event is produced
// ("skip" for unchanged/empty, "step-start" for status-only, "unknown" for
// unmapped types).
func (z *ZcodeSync) PreviewPart(nativePartID, wireMessageID string, part ZcodePartData, model string) (DiffBatch, error) {
	ev, reason := z.mapper.MapPart(z.wireID, wireMessageID, nativePartID, part, model, z.state.lastEventID, 0)
	if reason != "" {
		return DiffBatch{SkipReason: reason}, nil
	}
	semantic := ev.ContentHash
	if semantic == "" {
		semantic = stableSemantic(ev)
	}
	wirePart := WirePartID(z.mapper.sourceID, nativePartID)
	prev, seen := z.state.parts[wirePart]
	if seen && prev.semantic == semantic {
		return DiffBatch{SkipReason: "skip"}, nil
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
	batch := DiffBatch{
		Events: []protocol.DaemonEvent{ev},
		Commit: SyncCommit{
			Part:        &PartCommit{WirePartID: wirePart, EventID: ev.EventID, Revision: revision, SemanticHash: semantic},
			LastEventID: ev.EventID,
		},
	}
	return batch, nil
}

// PreviewStatus previews a session_status event when the derived status
// changes. On the very first observation after session_discovered the status
// hash is already seeded, so no redundant event is produced if the derived
// status matches the initial one.
func (z *ZcodeSync) PreviewStatus(status string) (DiffBatch, error) {
	h := semanticHash(status)
	if h == z.state.statusHash {
		return DiffBatch{}, nil
	}
	ev := z.mapper.SessionStatus(z.wireID, status, z.state.lastEventID)
	return DiffBatch{
		Events: []protocol.DaemonEvent{ev},
		Commit: SyncCommit{StatusHash: h, LastEventID: ev.EventID},
	}, nil
}

// --- commit application -----------------------------------------------------

// ApplyAccepted applies a canonical store-assigned commit to the projection.
// Zero-order (provisional) commits are rejected: published state only accepts
// commits whose order the CursorStore assigned.
func (z *ZcodeSync) ApplyAccepted(commit SyncCommit) error {
	if commit.CommitOrder == 0 {
		return errors.New("zcode sync: ApplyAccepted requires a canonical store-assigned commit order")
	}
	return z.applyCommit(commit)
}

// applyProvisional applies a zero-order commit to a disposable scratch clone
// during page preparation, so later rows in the same page see increasing
// revisions and a valid PreviousEventID. It must never be used on published
// state.
func (z *ZcodeSync) applyProvisional(commit SyncCommit) error {
	return z.applyCommit(commit)
}

// applyCommit applies one commit under the monotonicity rules: part
// checkpoints advance by revision (equal revision with a different identity is
// a corruption error; lower revisions are stale and ignored), named metadata
// follows the commit, and the cross-stream event chain only moves forward in
// commit order. Provisional (zero-order) commits chain LastEventID directly
// because scratch rows apply in source order.
func (z *ZcodeSync) applyCommit(commit SyncCommit) error {
	if commit.Part != nil {
		pc := commit.Part
		if existing, ok := z.state.parts[pc.WirePartID]; ok {
			switch {
			case pc.Revision < existing.revision:
				// Stale commit: keep the newer checkpoint.
			case pc.Revision == existing.revision:
				if existing.eventID != pc.EventID || existing.semantic != pc.SemanticHash {
					return fmt.Errorf("%w: part %s revision %d has conflicting identity",
						ErrCursorPartConflict, pc.WirePartID, pc.Revision)
				}
			default:
				z.state.parts[pc.WirePartID] = partCheckpoint{eventID: pc.EventID, revision: pc.Revision, semantic: pc.SemanticHash}
			}
		} else {
			z.state.parts[pc.WirePartID] = partCheckpoint{eventID: pc.EventID, revision: pc.Revision, semantic: pc.SemanticHash}
		}
	}
	if commit.Message != nil {
		existing, seen := z.state.msgs[commit.Message.WireMessageID]
		next := msgCheckpoint{eventID: commit.Message.EventID, semantic: commit.Message.SemanticHash, order: commit.CommitOrder}
		switch {
		case !seen:
		case commit.CommitOrder == 0: // provisional page proposal
			if existing.eventID == commit.Message.EventID && existing.semantic == commit.Message.SemanticHash {
				return nil
			}
		case existing.order == 0: // legacy checkpoint: superseded
		case commit.CommitOrder > existing.order:
		case commit.CommitOrder < existing.order:
			return nil // stale
		default:
			if existing.eventID == commit.Message.EventID && existing.semantic == commit.Message.SemanticHash {
				return nil
			}
			return fmt.Errorf("%w: message %s order %d has conflicting identity",
				ErrCursorMessageConflict, commit.Message.WireMessageID, commit.CommitOrder)
		}
		z.state.msgs[commit.Message.WireMessageID] = next
	}
	if commit.Title != nil {
		z.state.titleEventID = commit.Title.EventID
		z.state.titleHash = commit.Title.Hash
	}
	if commit.Model != nil {
		z.state.modelEventID = commit.Model.EventID
		z.state.modelHash = commit.Model.Hash
	}
	if commit.Todo != nil {
		z.state.todoEventID = commit.Todo.EventID
		z.state.todoHash = commit.Todo.Hash
	}
	if commit.StatusHash != "" {
		z.state.statusHash = commit.StatusHash
	}
	if commit.SubagentEventID != "" {
		z.state.subagentEventID = commit.SubagentEventID
	}
	switch {
	case commit.LastEventID != "" && commit.CommitOrder > z.state.lastCommitOrder:
		z.state.lastEventID = commit.LastEventID
		z.state.lastCommitOrder = commit.CommitOrder
	case commit.CommitOrder == 0 && commit.LastEventID != "":
		// Provisional scratch chaining: rows apply in source order.
		z.state.lastEventID = commit.LastEventID
	}
	return nil
}

// --- todos -------------------------------------------------------------------

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
