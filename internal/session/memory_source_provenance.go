package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
)

func memoryProducer(agent string) string {
	switch agent {
	case "codex", "opencode":
		return agent
	case "claude", "claude-code":
		return "claude"
	}
	return "unknown"
}

// Only the direct dispatch command, not a replayed/native user-looking event,
// can establish an independent user assertion. Workflow invocations are excluded.
func memoryInputProvenance(in UserMessageInput, turnID, agent string) *protocol.MemorySourceProvenance {
	if in.InvocationID != "" || in.RequestID == "" || in.MsgID == "" || turnID == "" || memoryProducer(agent) == "unknown" {
		return nil
	}
	id := protocol.MemoryInputEventID(in.SessionID, in.RequestID, in.MsgID)
	return &protocol.MemorySourceProvenance{SourcePath: "managed_dispatch", AcceptedInputEventID: id, Version: 1, Producer: memoryProducer(agent), SessionID: in.SessionID, TurnID: turnID, EventID: id, Sequence: "1", InvocationID: id, SourceRole: "user", SkillState: "non_skill", LineageComplete: true, DerivedFromEventIDs: []string{}}
}

// Existing native adapters lack a complete skill lineage. Preserve that gap
// explicitly; transport sequence is canonicalized by the Relay journal.
func stampUnknownMemorySource(ev *protocol.DaemonEvent, producer string) {
	if ev == nil || ev.MemorySource != nil || ev.SessionID == "" || ev.TurnID == "" {
		return
	}
	role := "system"
	switch ev.Type {
	case "user_text", "user_message":
		role = "user"
	case "agent_text":
		role = "assistant"
	case "tool_call", "tool_result":
		role = "tool"
	}
	eventID := ev.EventID
	// Native record identity is useful even when there is no accepted dispatch.
	// This identifies the observation only; it cannot establish causal lineage.
	if n := ev.MemoryNative; eventID == "" && n != nil && n.Producer == producer && n.RecordID != "" {
		digest := sha256.Sum256([]byte(producer + "\x00" + ev.SessionID + "\x00" + ev.TurnID + "\x00" + n.RecordID + "\x00" + ev.Type + "\x00" + ev.CallID + "\x00" + strconv.Itoa(n.Ordinal)))
		eventID = "observed:" + hex.EncodeToString(digest[:])
	}
	if eventID == "" {
		eventID = ev.MemoryObservationID
	}
	path := "readonly_observation"
	if ev.Resync {
		path = "historical_resync"
	}
	ev.MemorySource = &protocol.MemorySourceProvenance{SourcePath: path, Version: 1, Producer: producer, SessionID: ev.SessionID, TurnID: ev.TurnID, EventID: eventID, Sequence: "1", InvocationID: ev.TurnID, SourceRole: role, SkillState: "unknown", LineageComplete: false, DerivedFromEventIDs: []string{}}
}

// Emit one diagnostic per newly classified dialogue event. Native metadata and
// message bodies stay out of logs; repeated enrichment keeps the original proof.
func (sm *SessionManager) recordUnknownMemorySource(ev *protocol.DaemonEvent, producer, reason string) {
	if ev.MemorySource != nil || ev.SessionID == "" || ev.TurnID == "" {
		return
	}
	stampUnknownMemorySource(ev, producer)
	p := ev.MemorySource
	p.SourceGapReason = reason
	// The ACK identifies one input in this native turn. On a shared runtime
	// it does not identify the author of other inputs or prove output lineage.
	if !ev.Resync && ev.Type != "user_text" && reason != "dispatch_unconfirmed" && reason != "dispatch_buffer_overflow" && reason != "dispatch_mismatch" {
		l := sm.memoryLedger()
		l.mu.Lock()
		b := l.bindings[ev.SessionID]
		if b != nil && !b.awaitingDispatch && b.root.Producer == producer && b.root.TurnID == ev.TurnID {
			n := ev.MemoryNative
			matches := n != nil && !n.Sidechain && n.Producer == producer && b.nativeRoot != "" && n.RootID == b.nativeRoot
			if producer == "codex" && ev.SourceTurnID != "" {
				matches = ev.TurnID == logicalCodexTurnID(ev.SessionID, ev.SourceTurnID) && (n == nil || n.RootID == ev.SourceTurnID)
			}
			if matches {
				p.SourcePath = "managed_dispatch"
				if !b.ambiguousInput {
					p.AcceptedInputEventID = b.root.EventID
				}
			}
		}
		l.mu.Unlock()
	}
	if !ev.Resync && (ev.Type == "user_text" || ev.Type == "agent_text" && ev.MessagePhase == "final_answer" || ev.Type == "turn_status" && ev.TurnStatus == "completed") {
		slog.Info("memory lineage unavailable", "producer", producer, "session_id", ev.SessionID, "turn_id", ev.TurnID, "event_type", ev.Type, "source_path", p.SourcePath, "accepted_input_event_id", p.AcceptedInputEventID, "reason", reason)
	}
}

// Registered session metadata is authoritative. Event prose and presentation
// fields cannot select a producer, and missing sessions never default to Claude.
func (sm *SessionManager) memoryEventProducer(ev *protocol.DaemonEvent) string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps := sm.sessions[ev.SessionID]
	if ps == nil {
		return "unknown"
	}
	if ps.Agent == adapter.AgentCodexDesktop && ps.Source == "observer" && ps.ControlMode == protocol.ControlLegacyReadOnly {
		return "codex"
	}
	return memoryProducer(ps.Agent)
}

// All state is process-local: restart/replay cannot retroactively confer proof.
// A command owns one native root and a bounded causal graph. Unknown branches
// never fall back to the nearest turn or to matching text.
type memorySourceLedger struct {
	mu       sync.Mutex
	bindings map[string]*memorySourceBinding
	pending  map[string]*memoryDispatchBuffer
}
type memorySourceBinding struct {
	awaitingDispatch bool
	ambiguousInput   bool
	root             *protocol.MemorySourceProvenance
	started          time.Time
	nativeRoot       string
	records          map[string]*protocol.MemorySourceProvenance
	calls            map[string]*protocol.MemorySourceProvenance
	skill            bool
	unknown          bool
}

func codexInvocationFrom(ctx context.Context) string {
	v, _ := ctx.Value(codexInvocationKey{}).(string)
	return v
}
func (sm *SessionManager) memoryLedger() *memorySourceLedger {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.memorySources == nil {
		sm.memorySources = &memorySourceLedger{bindings: map[string]*memorySourceBinding{}}
	}
	return sm.memorySources
}
func (sm *SessionManager) registerMemoryInput(in UserMessageInput, turnID, agent, nativeRoot string) *protocol.MemorySourceProvenance {
	return sm.trackMemoryInput(in, turnID, agent, nativeRoot, false)
}

// Non-Codex transports may reserve native identities before Send returns.
// Only a successful transport write can make the reserved graph usable.
func (sm *SessionManager) trackMemoryInput(in UserMessageInput, turnID, agent, nativeRoot string, awaitingDispatch bool) *protocol.MemorySourceProvenance {
	p := memoryInputProvenance(in, turnID, agent)
	l := sm.memoryLedger()
	l.mu.Lock()
	defer l.mu.Unlock()
	// The attached native TUI can add input to this same turn without passing
	// through the daemon. Its ACK proves this input, not later items' parents.
	if p == nil {
		delete(l.bindings, in.SessionID)
		return p
	}
	// Idempotent dispatch identity; do not reset a native graph on a duplicate ACK.
	if old := l.bindings[in.SessionID]; old != nil && old.root.TurnID == turnID {
		if old.root.EventID == p.EventID {
			return old.root
		}
		if agent == "codex" {
			old.ambiguousInput = true
			return p
		}
	}
	if l.bindings[in.SessionID] == nil && len(l.bindings) >= 512 {
		oldest := ""
		for id, binding := range l.bindings {
			if oldest == "" || binding.started.Before(l.bindings[oldest].started) {
				oldest = id
			}
		}
		delete(l.bindings, oldest)
	}
	l.bindings[in.SessionID] = &memorySourceBinding{root: p, awaitingDispatch: awaitingDispatch, started: time.Now(), nativeRoot: nativeRoot, records: map[string]*protocol.MemorySourceProvenance{}, calls: map[string]*protocol.MemorySourceProvenance{}}
	return p
}

func (sm *SessionManager) acceptMemoryInput(p *protocol.MemorySourceProvenance) {
	if p == nil {
		return
	}
	l := sm.memoryLedger()
	l.mu.Lock()
	b := l.bindings[p.SessionID]
	bound := b != nil && b.root == p
	if bound {
		b.awaitingDispatch = false
		bound = !b.ambiguousInput && (p.Producer != "codex" || b.nativeRoot != "")
	}
	l.mu.Unlock()
	slog.Info("memory input dispatched", "producer", p.Producer, "session_id", p.SessionID, "turn_id", p.TurnID, "input_event_id", p.EventID, "has_output_binding", bound)
}

// A failed transport write cannot remain a live source of causal authority.
// Match the exact turn so a delayed failure never clears a successor dispatch.
func (sm *SessionManager) discardMemoryInput(sessionID, turnID string) {
	l := sm.memoryLedger()
	l.mu.Lock()
	defer l.mu.Unlock()
	if b := l.bindings[sessionID]; b != nil && b.root.TurnID == turnID {
		delete(l.bindings, sessionID)
	}
}

func (sm *SessionManager) stampNativeMemorySource(ev *protocol.DaemonEvent) string {
	return sm.stampNativeMemorySourceForInput(ev, "")
}
func (sm *SessionManager) stampNativeMemorySourceForInput(ev *protocol.DaemonEvent, expectedInput string) string {
	if ev == nil || ev.MemorySource != nil || ev.SessionID == "" || ev.TurnID == "" {
		return ""
	}
	if ev.Resync {
		return "historical_replay"
	}
	if ev.MemoryNative == nil {
		return "native_metadata_unavailable"
	}
	n := ev.MemoryNative
	l := sm.memoryLedger()
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.bindings[ev.SessionID]
	switch {
	case b == nil:
		return "no_live_dispatch_binding"
	case expectedInput != "" && b.root.EventID != expectedInput || b.root.Producer != n.Producer:
		return "dispatch_mismatch"
	case b.ambiguousInput && b.root.TurnID == ev.TurnID:
		return "codex_input_unconfirmed"
	case n.Sidechain:
		return "sidechain"
	case n.RecordID == "":
		return "native_record_missing"
	case len(b.records) > 4096:
		return "record_limit"
	}
	if b.awaitingDispatch {
		// A concurrent observation cannot establish a native root before the
		// write succeeds. Preserve the gap for outputs from the same turn.
		if ev.TurnID == b.root.TurnID || (b.nativeRoot != "" && n.RootID == b.nativeRoot) {
			b.unknown = true
			b.skill = b.skill || n.Skill
		}
		return "dispatch_pending"
	}
	// Claude's PTY does not accept a client message UUID. Bind only the native
	// user root written after this command, then demand actual parent UUIDs.
	if b.nativeRoot == "" {
		if n.Producer == "codex" {
			if logicalCodexTurnID(ev.SessionID, n.RootID) != b.root.TurnID {
				return "native_root_mismatch"
			}
			return "accepted_input_without_output_binding"
		}
		at, err := time.Parse(time.RFC3339Nano, n.OccurredAt)
		if n.Producer != "claude" || !n.UserRoot || n.RootID != n.RecordID || err != nil || at.Before(b.started) {
			return "native_user_root_unconfirmed"
		}
		b.nativeRoot = n.RootID
	}
	if n.RootID != b.nativeRoot {
		return "native_root_mismatch"
	}
	// Queued native content may leave after the registry terminalized its
	// command turn. Only the exact bound Claude source root can bridge its
	// native logical turn back to this live dispatch; no nearest-turn lookup.
	if b.root.TurnID != ev.TurnID && !(n.Producer == "claude" && b.nativeRoot != "" && ev.SourceTurnID == b.nativeRoot && ev.TurnID == turn.LogicalTurnID(adapter.AgentClaude, ev.SessionID, "", "source_message", b.nativeRoot)) {
		return "turn_mismatch"
	}
	var parent *protocol.MemorySourceProvenance
	if n.Producer == "codex" || n.DirectRoot {
		parent = b.root
	} else if n.UserRoot && n.RecordID == b.nativeRoot {
		parent = b.root
	} else {
		parent = b.records[n.ParentRecordID]
	}
	if ev.Type == "tool_result" {
		parent = b.calls[ev.CallID]
		if parent == nil && n.CompleteCall {
			parent = b.root
		}
	}
	if parent == nil {
		return "native_parent_missing"
	}
	b.skill = b.skill || n.Skill
	b.unknown = b.unknown || n.UnknownChild
	role := "system"
	switch ev.Type {
	case "agent_text":
		role = "assistant"
	case "tool_call", "tool_result":
		role = "tool"
	}
	// A native user echo is system evidence of delivery. Only the dispatch
	// command is an independent user assertion.
	identity := sha256.Sum256([]byte(n.Producer + "\x00" + ev.SessionID + "\x00" + b.nativeRoot + "\x00" + n.RecordID + "\x00" + ev.Type + "\x00" + ev.CallID + "\x00" + ev.EventID + "\x00" + strconv.Itoa(n.Ordinal)))
	eventID := "native:" + hex.EncodeToString(identity[:])
	invocation := "output:" + strings.TrimPrefix(b.root.EventID, "input:")
	state, complete := "non_skill", true
	if b.skill {
		state = "skill"
	} else if b.unknown || parent.SkillState == "unknown" || !parent.LineageComplete {
		state = "unknown"
		complete = false
	}
	p := &protocol.MemorySourceProvenance{SourcePath: "managed_dispatch", AcceptedInputEventID: b.root.EventID, Version: 1, Producer: n.Producer, SessionID: ev.SessionID, TurnID: b.root.TurnID, EventID: eventID, Sequence: "1", InvocationID: invocation, ParentInvocationID: b.root.InvocationID, SourceRole: role, SkillState: state, LineageComplete: complete, DerivedFromEventIDs: []string{parent.EventID}}
	if !complete {
		p.SourceGapReason = "native_lineage_incomplete"
	}
	if b.skill {
		p.SkillInvocationID = invocation
	}
	ev.TurnID = b.root.TurnID
	ev.MemorySource = p
	b.records[n.RecordID] = p
	if ev.Type == "tool_call" && ev.CallID != "" {
		b.calls[ev.CallID] = p
	}
	return ""
}

// A source id may be reserved only by the live owned transport. Readers and
// recovery never call this, and a different command cannot replace the graph.
func (sm *SessionManager) bindMemoryNativeRoot(sessionID, turnID, nativeRoot string) bool {
	l := sm.memoryLedger()
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.bindings[sessionID]
	if b == nil || b.root.TurnID != turnID || nativeRoot == "" || b.nativeRoot != "" && b.nativeRoot != nativeRoot {
		return false
	}
	b.nativeRoot = nativeRoot
	return true
}
func (sm *SessionManager) ownedMemoryStreamRoot(sessionID string) string {
	l := sm.memoryLedger()
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.bindings[sessionID]
	if b == nil || b.root.Producer != "claude" {
		return ""
	}
	if b.nativeRoot == "" {
		b.nativeRoot = "spawn:" + strings.TrimPrefix(b.root.EventID, "input:")
	}
	return b.nativeRoot
}
