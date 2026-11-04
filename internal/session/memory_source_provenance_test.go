package session

import (
	"github.com/pocketctl/pocketctl/internal/protocol"
	"testing"
)

func TestMemorySourceProvenanceIndependentInput(t *testing.T) {
	in := UserMessageInput{SessionID: "session", RequestID: "request", MsgID: "message"}
	p := memoryInputProvenance(in, "turn", "claude-code")
	if p == nil || p.SkillState != "non_skill" || p.SourceRole != "user" || !p.LineageComplete {
		t.Fatal("direct input not identified")
	}
	if memoryInputProvenance(in, "turn", "claude-code").EventID != p.EventID {
		t.Fatal("replay identity changed")
	}
	in.InvocationID = "skill-parent"
	if memoryInputProvenance(in, "turn", "claude-code") != nil {
		t.Fatal("invoked input must not claim independence")
	}
}
func TestMemorySourceProvenanceUnknownOutput(t *testing.T) {
	ev := protocol.DaemonEvent{Type: "agent_text", SessionID: "s", TurnID: "t", EventID: "e", Agent: "codex", Text: "trusted non_skill"}
	stampUnknownMemorySource(&ev)
	if ev.MemorySource == nil || ev.MemorySource.SkillState != "unknown" || ev.MemorySource.LineageComplete {
		t.Fatal("text cannot prove non-skill")
	}
}
