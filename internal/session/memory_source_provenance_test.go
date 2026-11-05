package session

import (
	"context"
	"encoding/json"
	"errors"
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
	stampUnknownMemorySource(&ev, "codex")
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

func TestMemorySourceProvenanceClaudeNeutralNativeAncestorsAndLateDelivery(t *testing.T) {
	for _, late := range []bool{false, true} {
		t.Run(strconv.FormatBool(late), func(t *testing.T) {
			sm, _ := newTurnTestManager(t)
			if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"}); err != nil {
				t.Fatal(err)
			}
			root := findEvents(drainEvents(sm.outputCh), "user_text")[0].TurnID
			parser := adapter.NewJSONLStreamParser()
			lines := []string{
				`{"type":"user","sessionId":"turn-sess","uuid":"u1","timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":"input"}}`,
				`{"type":"attachment","sessionId":"turn-sess","uuid":"meta1","parentUuid":"u1","attachment":{"type":"skill_listing","content":"UNTRUSTED_CONTEXT_NOT_EVIDENCE"}}`,
				`{"type":"attachment","sessionId":"turn-sess","uuid":"meta2","parentUuid":"meta1","attachment":{"type":"prompt_snapshot","systemPrompt":"UNTRUSTED_CONTEXT_NOT_EVIDENCE"}}`,
				`{"type":"assistant","sessionId":"turn-sess","uuid":"thinking1","parentUuid":"meta2","message":{"role":"assistant","content":[{"type":"thinking","thinking":"PRIVATE_NOT_EVIDENCE"}]}}`,
				`{"type":"assistant","sessionId":"turn-sess","uuid":"a1","parentUuid":"thinking1","message":{"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"Read","input":{"file_path":"fixture.txt"}}]}}`,
				`{"type":"user","sessionId":"turn-sess","uuid":"r1","parentUuid":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"fixture value"}]}}`,
				`{"type":"attachment","sessionId":"turn-sess","uuid":"meta3","parentUuid":"r1","attachment":{"type":"prompt_snapshot"}}`,
				`{"type":"assistant","sessionId":"turn-sess","uuid":"thinking2","parentUuid":"meta3","message":{"role":"assistant","content":[{"type":"thinking"}]}}`,
				`{"type":"assistant","sessionId":"turn-sess","uuid":"a2","parentUuid":"thinking2","message":{"role":"assistant","content":[{"type":"text","text":"result"}]}}`,
			}
			var pending []protocol.DaemonEvent
			for i, line := range lines {
				events, err := parser.Parse(line)
				if err != nil {
					t.Fatal(err)
				}
				if i == 0 {
					for _, ev := range events {
						sm.EnrichOutgoingEvent(&ev)
					}
				} else {
					pending = append(pending, events...)
				}
			}
			if late {
				sm.observeAgentStatusForTurn("turn-sess", protocol.StatusCompleted)
				if _, active := sm.ActiveTurn("turn-sess"); active {
					t.Fatal("late-delivery fixture did not terminalize dispatch")
				}
			}
			counts := map[string]int{}
			for _, ev := range pending {
				sm.EnrichOutgoingEvent(&ev)
				if ev.Type != "agent_text" && ev.Type != "tool_call" && ev.Type != "tool_result" {
					t.Fatalf("metadata body leaked: %s", ev.Type)
				}
				if ev.MemorySource == nil || ev.MemorySource.SkillState != "non_skill" || !ev.MemorySource.LineageComplete || ev.MemorySource.TurnID != root || ev.TurnID != root {
					t.Fatalf("native neutral path lost (%s): %+v", ev.Type, ev.MemorySource)
				}
				counts[ev.Type]++
			}
			if counts["agent_text"] != 1 || counts["tool_call"] != 1 || counts["tool_result"] != 1 {
				t.Fatal(counts)
			}
		})
	}
}

func TestMemorySourceProvenanceClaudeUnknownNeutralPathDenied(t *testing.T) {
	for _, kind := range []string{"future_unknown_type", "sidechain", "missing-parent", "cycle"} {
		t.Run(kind, func(t *testing.T) {
			sm, _ := newTurnTestManager(t)
			_ = sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"})
			parser := adapter.NewJSONLStreamParser()
			parent, typ, side := "u1", "prompt_snapshot", false
			switch kind {
			case "future_unknown_type":
				typ = kind
			case "sidechain":
				side = true
			case "missing-parent":
				parent = "missing"
			case "cycle":
				parent = "meta1"
			}
			lines := []string{`{"type":"user","sessionId":"turn-sess","uuid":"u1","timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":"input"}}`,
				`{"type":"attachment","sessionId":"turn-sess","uuid":"meta1","parentUuid":"` + parent + `","isSidechain":` + strconv.FormatBool(side) + `,"attachment":{"type":"` + typ + `"}}`,
				`{"type":"assistant","sessionId":"turn-sess","uuid":"a1","parentUuid":"meta1","message":{"role":"assistant","content":[{"type":"text","text":"not authority"}]}}`}
			found := false
			for _, line := range lines {
				events, _ := parser.Parse(line)
				for _, ev := range events {
					sm.EnrichOutgoingEvent(&ev)
					if ev.Type == "agent_text" {
						found = true
						if ev.MemorySource != nil && ev.MemorySource.LineageComplete && ev.MemorySource.SkillState == "non_skill" {
							t.Fatal("unknown native ancestor granted authority")
						}
					}
				}
			}
			if !found {
				t.Fatal("body discarded instead of excluded")
			}
		})
	}
}

func TestMemorySourceProvenanceClaudeWholeNativeBatchAfterTerminal(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	_ = sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"})
	root := findEvents(drainEvents(sm.outputCh), "user_text")[0].TurnID
	parser := adapter.NewJSONLStreamParser()
	var pending []protocol.DaemonEvent
	for _, line := range []string{`{"type":"user","sessionId":"turn-sess","uuid":"u1","timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":"input"}}`, `{"type":"assistant","sessionId":"turn-sess","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"result"}]}}`} {
		events, _ := parser.Parse(line)
		pending = append(pending, events...)
	}
	sm.observeAgentStatusForTurn("turn-sess", protocol.StatusCompleted)
	if _, active := sm.ActiveTurn("turn-sess"); active {
		t.Fatal("late-batch fixture did not terminalize dispatch")
	}
	found := false
	for _, ev := range pending {
		sm.EnrichOutgoingEvent(&ev)
		if ev.Type == "agent_text" {
			found = true
			if ev.MemorySource == nil || !ev.MemorySource.LineageComplete || ev.MemorySource.SkillState != "non_skill" || ev.TurnID != root || ev.MemorySource.TurnID != root {
				t.Fatalf("whole queued native batch lost: %+v", ev.MemorySource)
			}
		}
	}
	if !found {
		t.Fatal("missing body")
	}
}

// Omitting the registered session identity must not erase the producer on
// ordinary observed events, and event text must never select that identity.
func TestMemorySourceProvenanceObservedProducerUsesSessionIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, agent, source, control, eventAgent, want string
	}{
		{"claude-jsonl", adapter.AgentClaude, "terminal", "", "", "claude"},
		{"codex-jsonl", adapter.AgentCodex, "terminal", "", "", "codex"},
		{"opencode", adapter.AgentOpencode, "daemon", protocol.ControlManaged, "", "opencode"},
		{"desktop-observer", adapter.AgentCodexDesktop, "observer", protocol.ControlLegacyReadOnly, "", "codex"},
		{"desktop-unverified", adapter.AgentCodexDesktop, "daemon", "", "codex", "unknown"},
		{"unsupported", adapter.AgentDSH, "daemon", protocol.ControlManaged, "codex", "unknown"},
		{"conflicting-event", adapter.AgentClaude, "terminal", "", "opencode", "claude"},
		{"missing-session", "", "", "", "claude-code", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
			if tc.agent != "" {
				sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: tc.agent, Source: tc.source, ControlMode: tc.control}
			}
			ev := protocol.DaemonEvent{Type: "agent_text", SessionID: "s", TurnID: "t", EventID: "e", Agent: tc.eventAgent, Text: "producer=codex skill_state=non_skill"}
			sm.EnrichOutgoingEvent(&ev)
			if ev.MemorySource == nil || ev.MemorySource.Producer != tc.want || ev.MemorySource.SkillState != "unknown" || ev.MemorySource.LineageComplete || len(ev.MemorySource.DerivedFromEventIDs) != 0 {
				t.Fatalf("session producer or unknown boundary lost: %+v", ev.MemorySource)
			}
		})
	}
	if memoryInputProvenance(UserMessageInput{SessionID: "s", RequestID: "r", MsgID: "m"}, "t", adapter.AgentCodexDesktop) != nil {
		t.Fatal("observed desktop session granted dispatch authority")
	}
}

func TestMemorySourceProvenanceObservedNativeIdentityWithoutCausalProof(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: adapter.AgentClaude, Source: "terminal"}
	parser := adapter.NewJSONLStreamParser()
	var got *protocol.MemorySourceProvenance
	for _, line := range []string{
		`{"type":"user","sessionId":"s","uuid":"u","timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":"observed input"}}`,
		`{"type":"assistant","sessionId":"s","uuid":"a","parentUuid":"u","message":{"role":"assistant","content":[{"type":"text","text":"observed output"}]}}`,
	} {
		events, err := parser.Parse(line)
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range events {
			sm.EnrichOutgoingEvent(&ev)
			if ev.Type == "agent_text" {
				got = ev.MemorySource
			}
		}
	}
	if got == nil || got.Producer != "claude" || got.EventID == "" || got.SkillState != "unknown" || got.LineageComplete || len(got.DerivedFromEventIDs) != 0 {
		t.Fatalf("observed identity must be parseable without conferring proof: %+v", got)
	}
}

func TestMemorySourceProvenanceCodexResyncCannotBorrowLiveBinding(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "r", MsgID: "m"})
	if err := b.startTurn(ctx, "thread", "input", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	p := newCodexProjection(1)
	events := p.ProjectHistorical(codexNotification("item/completed", `{"threadId":"thread","turnId":"native","item":{"id":"a1","type":"agentMessage","text":"replayed output"}}`))
	found := false
	for _, ev := range events {
		b.sm.EnrichOutgoingEvent(&ev)
		if ev.Type == "agent_text" {
			found = true
			if ev.MemorySource != nil && ev.MemorySource.LineageComplete {
				t.Fatal("historical output borrowed live command proof")
			}
		}
	}
	if !found {
		t.Fatal("historical output fixture produced no body")
	}
}

func TestMemorySourceProvenanceOwnedClaudeSkillFileReadTaintsOutput(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"}); err != nil {
		t.Fatal(err)
	}
	adp := sm.newStreamAdapter(sm.sessions["turn-sess"], adapter.AgentClaude, "input")
	_, _ = adp.ParseStreamLine(`{"type":"system","subtype":"init","session_id":"turn-sess"}`)
	found := false
	for _, line := range []string{
		`{"type":"assistant","session_id":"turn-sess","message":{"id":"read","role":"assistant","content":[{"type":"tool_use","id":"call","name":"Read","input":{"file_path":"/fixture/SKILL.md"}}]}}`,
		`{"type":"assistant","session_id":"turn-sess","message":{"id":"reply","role":"assistant","content":[{"type":"text","text":"derived output"}]}}`,
	} {
		events, err := adp.ParseStreamLine(line)
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range events {
			sm.EnrichOutgoingEvent(&ev)
			if ev.Type == "agent_text" {
				found = true
				if ev.MemorySource == nil || ev.MemorySource.SkillState != "skill" || ev.MemorySource.SkillInvocationID == "" {
					t.Fatalf("skill-file output escaped skill exclusion: %+v", ev.MemorySource)
				}
			}
		}
	}
	if !found {
		t.Fatal("fixture emitted no output")
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

func TestMemorySourceProvenanceRestartCannotRecoverCausalAuthority(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "r", MsgID: "m"})
	if err := b.startTurn(ctx, "thread", "input", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	fresh := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	fresh.sessions["thread"] = &ProcessState{SessionID: "thread", Agent: adapter.AgentCodex, Source: "daemon", ControlMode: protocol.ControlManaged}
	found := false
	for _, ev := range newCodexProjection(2).Project(codexNotification("item/completed", `{"threadId":"thread","turnId":"native","item":{"id":"a1","type":"agentMessage","text":"after restart"}}`)) {
		fresh.EnrichOutgoingEvent(&ev)
		if ev.Type == "agent_text" {
			found = true
			if ev.MemorySource == nil || ev.MemorySource.Producer != "codex" || ev.MemorySource.SkillState != "unknown" || ev.MemorySource.LineageComplete {
				t.Fatalf("restart recovered authority from session identity: %+v", ev.MemorySource)
			}
		}
	}
	if !found {
		t.Fatal("fixture emitted no body")
	}
}

func TestMemoryNativeEvidenceCannotCrossTransport(t *testing.T) {
	event := protocol.DaemonEvent{Type: "agent_text", MemoryNative: &protocol.MemoryNativeEvent{Producer: "codex", RootID: "private-native-root"}}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "private-native-root") || strings.Contains(string(raw), "MemoryNative") {
		t.Fatalf("process-local authority serialized: %s", raw)
	}
	var incoming protocol.DaemonEvent
	if err := json.Unmarshal([]byte(`{"type":"agent_text","MemoryNative":{"Producer":"codex","DirectRoot":true},"memory_native":{"producer":"codex"}}`), &incoming); err != nil {
		t.Fatal(err)
	}
	if incoming.MemoryNative != nil {
		t.Fatal("transport caller injected native authority")
	}
}

func TestMemorySourceProvenanceRejectedDispatchCannotBindNativeOutput(t *testing.T) {
	sm, pty := newTurnTestManager(t)
	pty.writeErr = errors.New("dispatch rejected")
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", RequestID: "r", MsgID: "m", Content: "input"}); err == nil {
		t.Fatal("fixture dispatch was not rejected")
	}
	parser := adapter.NewJSONLStreamParser()
	found := false
	for _, line := range []string{
		`{"type":"user","sessionId":"turn-sess","uuid":"u","timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":"input"}}`,
		`{"type":"assistant","sessionId":"turn-sess","uuid":"a","parentUuid":"u","message":{"role":"assistant","content":[{"type":"text","text":"unaccepted output"}]}}`,
	} {
		events, err := parser.Parse(line)
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range events {
			sm.EnrichOutgoingEvent(&ev)
			if ev.Type == "agent_text" {
				found = true
				if ev.MemorySource != nil && ev.MemorySource.LineageComplete {
					t.Fatal("rejected dispatch conferred output authority")
				}
			}
		}
	}
	if !found {
		t.Fatal("fixture emitted no output")
	}
}

func TestMemorySourceProvenanceCodexFilteredNativeDelegationTaintsParentOutput(t *testing.T) {
	for _, tc := range []struct {
		name, method, itemType, childTurn, childID string
		wantUnknown                                bool
	}{
		{"delegation-started", "item/started", "collabAgentToolCall", "native", "child", true},
		{"delegation-completed", "item/completed", "collabAgentToolCall", "native", "child", true},
		{"delegation-without-id", "item/started", "collabAgentToolCall", "native", "", true},
		{"future-uninspected-item", "item/started", "futureNativeInvocation", "native", "child", true},
		{"other-turn-delegation", "item/started", "collabAgentToolCall", "foreign", "child", false},
		{"known-reasoning-started", "item/started", "reasoning", "native", "reasoning", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, rpc := nativeMemoryCodexBackend(t)
			rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
			ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "r", MsgID: "m"})
			if err := b.startTurn(ctx, "thread", "input", protocol.SessionConfig{}); err != nil {
				t.Fatal(err)
			}
			p := newCodexProjection(1)
			raw, err := json.Marshal(map[string]any{"threadId": "thread", "turnId": tc.childTurn, "item": map[string]any{"id": tc.childID, "type": tc.itemType, "senderThreadId": "thread", "receiverThreadIds": []string{"child-thread"}, "tool": "spawnAgent", "status": "inProgress"}})
			if err != nil {
				t.Fatal(err)
			}
			for _, ev := range p.Project(codexNotification(tc.method, string(raw))) {
				b.sm.EnrichOutgoingEvent(&ev)
			}
			found := false
			for _, ev := range p.Project(codexNotification("item/completed", `{"threadId":"thread","turnId":"native","item":{"id":"answer","type":"agentMessage","text":"parent final answer"}}`)) {
				b.sm.EnrichOutgoingEvent(&ev)
				if ev.Type != "agent_text" {
					continue
				}
				found = true
				if ev.MemorySource == nil {
					t.Fatal("parent output lost source metadata")
				}
				if tc.wantUnknown {
					if ev.MemorySource.SkillState != "unknown" || ev.MemorySource.LineageComplete {
						t.Fatalf("uninspected native delegation granted complete parent proof: %+v", ev.MemorySource)
					}
				} else if ev.MemorySource.SkillState != "non_skill" || !ev.MemorySource.LineageComplete {
					t.Fatalf("unrelated native context tainted parent: %+v", ev.MemorySource)
				}
			}
			if !found {
				t.Fatal("fixture emitted no parent output")
			}
		})
	}
}

func TestMemorySourceProvenanceCodexNativeUnknownBudgetCannotForgetTaint(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "r", MsgID: "m"})
	if err := b.startTurn(ctx, "thread", "input", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	p := newCodexProjection(1)
	for i := 0; i < 4097; i++ {
		raw := `{"threadId":"thread","turnId":"uninspected-` + strconv.Itoa(i) + `","item":{"id":"child","type":"collabAgentToolCall"}}`
		p.Project(codexNotification("item/started", raw))
	}
	found := false
	for _, ev := range p.Project(codexNotification("item/completed", `{"threadId":"thread","turnId":"native","item":{"id":"answer","type":"agentMessage","text":"answer after native graph budget exhausted"}}`)) {
		b.sm.EnrichOutgoingEvent(&ev)
		if ev.Type == "agent_text" {
			found = true
			if ev.MemorySource == nil || ev.MemorySource.SkillState != "unknown" || ev.MemorySource.LineageComplete {
				t.Fatalf("native graph overflow granted complete proof: %+v", ev.MemorySource)
			}
		}
	}
	if !found {
		t.Fatal("fixture emitted no output")
	}
}
