package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/pocketctl/pocketctl/internal/protocol"
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
	digest := sha256.Sum256([]byte(in.SessionID + "\x00" + in.RequestID + "\x00" + in.MsgID))
	id := "input:" + hex.EncodeToString(digest[:])
	return &protocol.MemorySourceProvenance{Version: 1, Producer: memoryProducer(agent), SessionID: in.SessionID, TurnID: turnID, EventID: id, Sequence: "1", InvocationID: id, SourceRole: "user", SkillState: "non_skill", LineageComplete: true, DerivedFromEventIDs: []string{}}
}

// Existing native adapters lack a complete skill lineage. Preserve that gap
// explicitly; transport sequence is canonicalized by the Relay journal.
func stampUnknownMemorySource(ev *protocol.DaemonEvent) {
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
	ev.MemorySource = &protocol.MemorySourceProvenance{Version: 1, Producer: memoryProducer(ev.Agent), SessionID: ev.SessionID, TurnID: ev.TurnID, EventID: ev.EventID, Sequence: "1", InvocationID: ev.TurnID, SourceRole: role, SkillState: "unknown", LineageComplete: false, DerivedFromEventIDs: []string{}}
}

// All state is process-local: restart/replay cannot retroactively confer proof.
// A command owns one native root and a bounded causal graph. Unknown branches
// never fall back to the nearest turn or to matching text.
type memorySourceLedger struct {
	mu       sync.Mutex
	bindings map[string]*memorySourceBinding
}
type memorySourceBinding struct {
	root       *protocol.MemorySourceProvenance
	started    time.Time
	nativeRoot string
	records    map[string]*protocol.MemorySourceProvenance
	calls      map[string]*protocol.MemorySourceProvenance
	skill      bool
	unknown    bool
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
	p := memoryInputProvenance(in, turnID, agent)
	l := sm.memoryLedger()
	l.mu.Lock()
	defer l.mu.Unlock()
	if p == nil {
		delete(l.bindings, in.SessionID)
		return nil
	}
	// Idempotent dispatch identity; do not reset a native graph on a duplicate ACK.
	if old := l.bindings[in.SessionID]; old != nil && old.root.EventID == p.EventID && old.root.TurnID == turnID {
		return old.root
	}
	if len(l.bindings) >= 512 {
		l.bindings = map[string]*memorySourceBinding{}
	}
	l.bindings[in.SessionID] = &memorySourceBinding{root: p, started: time.Now(), nativeRoot: nativeRoot, records: map[string]*protocol.MemorySourceProvenance{}, calls: map[string]*protocol.MemorySourceProvenance{}}
	return p
}
func (sm *SessionManager) stampNativeMemorySource(ev *protocol.DaemonEvent) {
	if ev == nil || ev.MemorySource != nil || ev.MemoryNative == nil || ev.SessionID == "" || ev.TurnID == "" {
		return
	}
	n := ev.MemoryNative
	l := sm.memoryLedger()
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.bindings[ev.SessionID]
	if b == nil || b.root.TurnID != ev.TurnID || b.root.Producer != n.Producer || n.Sidechain || n.RecordID == "" || len(b.records) > 4096 {
		return
	}
	// Claude's PTY does not accept a client message UUID. Bind only the native
	// user root written after this command, then demand actual parent UUIDs.
	if b.nativeRoot == "" {
		at, err := time.Parse(time.RFC3339Nano, n.OccurredAt)
		if n.Producer != "claude" || !n.UserRoot || n.RootID != n.RecordID || err != nil || at.Before(b.started) {
			return
		}
		b.nativeRoot = n.RootID
	}
	if n.RootID != b.nativeRoot {
		return
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
		return
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
	p := &protocol.MemorySourceProvenance{Version: 1, Producer: n.Producer, SessionID: ev.SessionID, TurnID: ev.TurnID, EventID: eventID, Sequence: "1", InvocationID: invocation, ParentInvocationID: b.root.InvocationID, SourceRole: role, SkillState: state, LineageComplete: complete, DerivedFromEventIDs: []string{parent.EventID}}
	if b.skill {
		p.SkillInvocationID = invocation
	}
	ev.MemorySource = p
	b.records[n.RecordID] = p
	if ev.Type == "tool_call" && ev.CallID != "" {
		b.calls[ev.CallID] = p
	}
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
