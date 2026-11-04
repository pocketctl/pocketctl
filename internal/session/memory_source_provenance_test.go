package session

import (
	"context"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"strings"
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

// Exercise the ordinary managed-input dispatch seam, not just the metadata helper.
func TestMemorySourceProvenanceManagedDispatch(t *testing.T) {
	for _, invoked := range []bool{false, true} {
		sm, pty := newTurnTestManager(t)
		in := UserMessageInput{SessionID: "turn-sess", RequestID: "request", MsgID: "message", Content: "isolated direct user input"}
		if invoked {
			in.InvocationID = "skill-parent"
		}
		if err := sm.SendMessageWithInput(context.Background(), in); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(pty.String(), in.Content) {
			t.Fatal("normal dispatch did not reach the backend")
		}
		found := false
		for _, event := range drainEvents(sm.outputCh) {
			if event.Type != "user_text" {
				continue
			}
			found = true
			if invoked {
				if event.MemorySource != nil && event.MemorySource.LineageComplete {
					t.Fatal("workflow input was promoted to independent user input")
				}
			} else if event.MemorySource == nil || !event.MemorySource.LineageComplete || event.MemorySource.SkillState != "non_skill" || event.MemorySource.TurnID != event.TurnID {
				t.Fatal("accepted direct input lost its exact turn provenance")
			}
		}
		if !found {
			t.Fatal("accepted input was not emitted")
		}
	}
}
