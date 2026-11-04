package session

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/pocketctl/pocketctl/internal/protocol"
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
