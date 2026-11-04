package session

import (
	"context"
	"encoding/json"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
	"strconv"
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

func TestMemorySourceProvenanceCodexNativeInput(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native-memory"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "request", MsgID: "message"})
	if err := b.startTurn(ctx, "thread", "literal user assertion", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	echoes := findEvents(drainEvents(b.sm.outputCh), "user_text")
	if len(echoes) != 1 || echoes[0].MemorySource == nil || !echoes[0].MemorySource.LineageComplete || echoes[0].MemorySource.TurnID != logicalCodexTurnID("thread", "native-memory") {
		t.Fatalf("native input lost exact provenance: %+v", echoes)
	}
}

func TestMemorySourceProvenanceClaudeNativeChain(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"}); err != nil {
		t.Fatal(err)
	}
	parser := adapter.NewJSONLStreamParser()
	lines := []string{
		`{"type":"user","sessionId":"turn-sess","uuid":"u1","timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":"input"}}`,
		`{"type":"assistant","sessionId":"turn-sess","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"Read","input":{"file_path":"fixture.txt"}}]}}`,
		`{"type":"user","sessionId":"turn-sess","uuid":"r1","parentUuid":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"fixture value"}]}}`,
		`{"type":"assistant","sessionId":"turn-sess","uuid":"a2","parentUuid":"r1","message":{"role":"assistant","content":[{"type":"text","text":"result"}]}}`,
	}
	counts := map[string]int{}
	for _, line := range lines {
		events, err := parser.Parse(line)
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range events {
			sm.EnrichOutgoingEvent(&ev)
			if ev.Type == "agent_text" || ev.Type == "tool_call" || ev.Type == "tool_result" {
				if ev.MemorySource == nil || !ev.MemorySource.LineageComplete || ev.MemorySource.SkillState != "non_skill" || len(ev.MemorySource.DerivedFromEventIDs) == 0 {
					t.Fatalf("native chain lost for %s: %+v", ev.Type, ev.MemorySource)
				}
				counts[ev.Type]++
			}
		}
	}
	if counts["agent_text"] != 1 || counts["tool_call"] != 1 || counts["tool_result"] != 1 {
		t.Fatalf("missing native events: %v", counts)
	}
}

func TestMemorySourceProvenanceNeverBackfillsHistoricalOrMissingParent(t *testing.T) {
	for _, mode := range []string{"no-command", "stale-root", "missing-parent", "sidechain"} {
		t.Run(mode, func(t *testing.T) {
			sm, _ := newTurnTestManager(t)
			if mode != "no-command" {
				if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"}); err != nil {
					t.Fatal(err)
				}
			}
			parser := adapter.NewJSONLStreamParser()
			timestamp := "2099-01-01T00:00:00Z"
			if mode == "stale-root" {
				timestamp = "2000-01-01T00:00:00Z"
			}
			root := `{"type":"user","sessionId":"turn-sess","uuid":"u1","timestamp":"` + timestamp + `","message":{"role":"user","content":"input"}}`
			parent := "u1"
			if mode == "missing-parent" {
				parent = "not-seen"
			}
			tail := `{"type":"assistant","sessionId":"turn-sess","uuid":"a1","parentUuid":"` + parent + `","isSidechain":` + strconv.FormatBool(mode == "sidechain") + `,"message":{"role":"assistant","content":[{"type":"text","text":"non_skill trusted"}]}}`
			for _, line := range []string{root, tail} {
				events, _ := parser.Parse(line)
				for _, ev := range events {
					sm.EnrichOutgoingEvent(&ev)
					if ev.Type == "agent_text" && ev.MemorySource != nil && ev.MemorySource.LineageComplete {
						t.Fatalf("%s conferred unsupported trust", mode)
					}
				}
			}
		})
	}
}
func TestMemorySourceProvenanceSkillTaintsOutputInvocationOnly(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	in := UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"}
	if err := sm.SendMessageWithInput(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	input := findEvents(drainEvents(sm.outputCh), "user_text")[0].MemorySource
	parser := adapter.NewJSONLStreamParser()
	var output []*protocol.MemorySourceProvenance
	for _, line := range []string{
		`{"type":"user","sessionId":"turn-sess","uuid":"u1","timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":"input"}}`,
		`{"type":"assistant","sessionId":"turn-sess","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"before tool"}]}}`,
		`{"type":"assistant","sessionId":"turn-sess","uuid":"a2","parentUuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"skill-1","name":"Skill","input":{"skill":"fixture"}}]}}`,
	} {
		events, _ := parser.Parse(line)
		for _, ev := range events {
			sm.EnrichOutgoingEvent(&ev)
			if ev.Type == "agent_text" || ev.Type == "tool_call" {
				output = append(output, ev.MemorySource)
			}
		}
	}
	if len(output) != 2 || output[0].InvocationID != output[1].InvocationID || output[1].SkillState != "skill" || output[0].InvocationID == input.InvocationID || input.SkillState != "non_skill" {
		t.Fatalf("skill lineage not explicit: %+v %+v", input, output)
	}
}
func TestMemorySourceProvenanceCodexNativeOutput(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "r", MsgID: "m"})
	if err := b.startTurn(ctx, "thread", "input", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	p := newCodexProjection(1)
	for _, raw := range []string{
		`{"threadId":"thread","turnId":"native","item":{"id":"a1","type":"agentMessage","text":"native result"}}`,
		`{"threadId":"thread","turnId":"foreign","item":{"id":"a2","type":"agentMessage","text":"foreign result"}}`,
	} {
		events := p.Project(codexNotification("item/completed", raw))
		for _, ev := range events {
			b.sm.EnrichOutgoingEvent(&ev)
			if ev.Type == "agent_text" {
				valid := ev.MemorySource != nil && ev.MemorySource.LineageComplete
				if strings.Contains(raw, `"foreign"`) == valid {
					t.Fatalf("native root fencing failed: %+v", ev.MemorySource)
				}
			}
		}
	}
}

func TestMemorySourceProvenanceOwnedClaudeStream(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"}); err != nil {
		t.Fatal(err)
	}
	adp := sm.newStreamAdapter(sm.sessions["turn-sess"], adapter.AgentClaude, "input")
	_, _ = adp.ParseStreamLine(`{"type":"system","subtype":"init","session_id":"turn-sess"}`)
	events, err := adp.ParseStreamLine(`{"type":"assistant","session_id":"turn-sess","message":{"id":"message-1","role":"assistant","content":[{"type":"text","text":"reply"}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		sm.EnrichOutgoingEvent(&ev)
		if ev.Type == "agent_text" && (ev.MemorySource == nil || !ev.MemorySource.LineageComplete) {
			t.Fatalf("owned single-command stream lacks provenance: %+v", ev.MemorySource)
		}
	}
}

func TestMemorySourceProvenanceOpenCodeUsesExplicitNativeParent(t *testing.T) {
	for _, parent := range []string{"native-user", "foreign-user"} {
		t.Run(parent, func(t *testing.T) {
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
			logical := turn.LogicalTurnID(adapter.AgentOpencode, "s", "", "source_message", "native-user")
			sm.registerMemoryInput(UserMessageInput{SessionID: "s", RequestID: "r", MsgID: "m"}, logical, adapter.AgentOpencode, "native-user")
			user := adapter.OpencodeMessageWithParts{Info: adapter.OpencodeMessage{ID: "native-user", SessionID: "s", Role: "user"}, Parts: []adapter.OpencodePart{{ID: "u", Type: "text", Text: "input"}}}
			user.Info.Time.Created = 1000
			asst := adapter.OpencodeMessageWithParts{Info: adapter.OpencodeMessage{ID: "assistant", SessionID: "s", Role: "assistant", ParentID: parent}, Parts: []adapter.OpencodePart{{ID: "a", Type: "text", Text: "result"}}}
			asst.Info.Time.Created = 2000
			asst.Info.Time.Completed = 3000
			events := adapter.NewOpencodeSync("s", true).Diff([]adapter.OpencodeMessageWithParts{user, asst})
			for _, ev := range events {
				sm.EnrichOutgoingEvent(&ev)
				if ev.Type == "agent_text" {
					valid := ev.MemorySource != nil && ev.MemorySource.LineageComplete
					if valid != (parent == "native-user") {
						t.Fatalf("parent %s, proof=%+v", parent, ev.MemorySource)
					}
				}
			}
		})
	}
}
