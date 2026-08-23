package adapter

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

func parseClaudeLines(t *testing.T, p *JSONLStreamParser, lines ...string) [][]protocol.DaemonEvent {
	t.Helper()
	out := make([][]protocol.DaemonEvent, 0, len(lines))
	for _, line := range lines {
		events, err := p.Parse(line)
		if err != nil {
			t.Fatalf("parse %q: %v", line, err)
		}
		out = append(out, events)
	}
	return out
}

// Normal user → assistant chunks → tool events → result completes one turn
// with a stable id; every content event carries the same identity.
func TestClaudeTurnHappyPathCompletion(t *testing.T) {
	p := NewJSONLStreamParser()
	batches := parseClaudeLines(t, p,
		`{"type":"user","sessionId":"cs1","uuid":"u1","message":{"role":"user","content":"fixture question"}}`,
		`{"type":"assistant","sessionId":"cs1","uuid":"a1","message":{"role":"assistant","model":"GLM-5.2","stop_reason":null,"content":[{"type":"text","text":"fixture part one"}]}}`,
		`{"type":"assistant","sessionId":"cs1","uuid":"a2","message":{"role":"assistant","model":"GLM-5.2","stop_reason":null,"content":[{"type":"text","text":"fixture part two"}]}}`,
		`{"type":"assistant","sessionId":"cs1","uuid":"a3","message":{"role":"assistant","model":"GLM-5.2","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"fixture.go"}}]}}`,
		`{"type":"user","sessionId":"cs1","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"fixture output"}]}}`,
		`{"type":"result","sessionId":"cs1","uuid":"r1","total_cost_usd":0.01,"num_turns":1}`,
	)
	wantTurn := turn.LogicalTurnID(AgentClaude, "cs1", "", "source_message", "u1")

	if len(batches[0]) != 2 || batches[0][0].Type != protocol.EventTypeTurnStatus ||
		batches[0][0].TurnStatus != protocol.TurnStateRunning || batches[0][0].TurnID != wantTurn {
		t.Fatalf("user batch = %+v", batches[0])
	}
	if batches[0][0].SourceTurnID != "u1" || batches[0][0].TurnOrigin != protocol.TurnOriginSourceMessage ||
		batches[0][0].TurnConfidence != protocol.TurnConfidenceDerived {
		t.Fatalf("running identity = %+v", batches[0][0])
	}
	if batches[0][1].Type != "user_text" || batches[0][1].TurnID != wantTurn {
		t.Fatalf("user_text not stamped: %+v", batches[0][1])
	}
	// Multiple assistant chunks and tool-only events stay in the turn.
	for _, bi := range []int{1, 2, 3} {
		for _, ev := range batches[bi] {
			if ev.TurnID != wantTurn {
				t.Fatalf("event %d drifted out of the turn: %+v", bi, ev)
			}
		}
	}
	// Tool-result user records do not start a new turn.
	if got := batches[4]; len(got) != 1 || got[0].Type != "tool_result" || got[0].TurnID != wantTurn {
		t.Fatalf("tool_result batch = %+v", got)
	}
	// Result closes exactly one completed turn before the session status.
	if len(batches[5]) != 2 || batches[5][0].Type != protocol.EventTypeTurnStatus ||
		batches[5][0].TurnStatus != protocol.TurnStateCompleted || batches[5][1].Type != "session_status" {
		t.Fatalf("result batch = %+v", batches[5])
	}
}

// A second user record while a turn is running is an addendum — same turn id,
// no second running status.
func TestClaudeTurnAddendumStaysInTurn(t *testing.T) {
	p := NewJSONLStreamParser()
	batches := parseClaudeLines(t, p,
		`{"type":"user","sessionId":"cs2","uuid":"u1","message":{"role":"user","content":"fixture first"}}`,
		`{"type":"user","sessionId":"cs2","uuid":"u2","message":{"role":"user","content":"fixture more"}}`,
	)
	if len(batches[0]) != 2 || batches[0][0].TurnStatus != protocol.TurnStateRunning {
		t.Fatalf("first batch = %+v", batches[0])
	}
	turnID := batches[0][0].TurnID
	if len(batches[1]) != 1 || batches[1][0].Type != "user_text" || batches[1][0].TurnID != turnID {
		t.Fatalf("addendum batch = %+v", batches[1])
	}
	for _, ev := range batches[1] {
		if ev.Type == protocol.EventTypeTurnStatus {
			t.Fatal("addendum must not emit a new running status")
		}
	}
}

// The interruption marker closes the turn as interrupted and is not surfaced
// as user input.
func TestClaudeTurnInterruptMarkerClosesTurn(t *testing.T) {
	p := NewJSONLStreamParser()
	batches := parseClaudeLines(t, p,
		`{"type":"user","sessionId":"cs3","uuid":"u1","message":{"role":"user","content":"fixture work"}}`,
		`{"type":"user","sessionId":"cs3","uuid":"u2","message":{"role":"user","content":"[Request interrupted by user for tool use]"}}`,
	)
	if len(batches[1]) != 1 || batches[1][0].Type != protocol.EventTypeTurnStatus ||
		batches[1][0].TurnStatus != protocol.TurnStateInterrupted {
		t.Fatalf("interrupt batch = %+v", batches[1])
	}
	if batches[1][0].TurnID != batches[0][0].TurnID {
		t.Fatal("interrupt must close the active turn")
	}
	// A late duplicate marker with nothing active is dropped.
	again, err := p.Parse(`{"type":"user","sessionId":"cs3","uuid":"u3","message":{"role":"user","content":"[Request interrupted by user]"}}`)
	if err != nil || len(again) != 0 {
		t.Fatalf("duplicate marker = %+v err=%v", again, err)
	}
}

// Records without a uuid anchor stay unassigned — no time-based grouping,
// no content-hash fallback.
func TestClaudeTurnUnassignedWithoutAnchor(t *testing.T) {
	p := NewJSONLStreamParser()
	batches := parseClaudeLines(t, p,
		`{"type":"user","sessionId":"cs4","message":{"role":"user","content":"fixture legacy"}}`,
		`{"type":"assistant","sessionId":"cs4","message":{"role":"assistant","model":"GLM-5.2","content":[{"type":"text","text":"fixture reply"}]}}`,
		`{"type":"result","sessionId":"cs4","total_cost_usd":0,"num_turns":1}`,
	)
	if len(batches[0]) != 1 || batches[0][0].Type != "user_text" || batches[0][0].TurnID != "" {
		t.Fatalf("legacy user batch = %+v", batches[0])
	}
	for _, batch := range batches {
		for _, ev := range batch {
			if ev.TurnID != "" {
				t.Fatalf("unanchored record got a turn id: %+v", ev)
			}
		}
	}
	// The result record still reports the session status, just no turn lifecycle.
	if len(batches[2]) != 1 || batches[2][0].Type != "session_status" {
		t.Fatalf("legacy result batch = %+v", batches[2])
	}
}

// Truncated/half lines parse-fail without state corruption; a rescan of the
// same records produces identical turn ids (id stability across re-reads).
func TestClaudeTurnTruncationAndRescanStability(t *testing.T) {
	p := NewJSONLStreamParser()
	if _, err := p.Parse(`{"type":"user","sessionId":"cs5","uuid":"u1","mess`); err == nil {
		t.Fatal("half line must fail")
	}
	first := parseClaudeLines(t, p,
		`{"type":"user","sessionId":"cs5","uuid":"u1","message":{"role":"user","content":"fixture one"}}`,
		`{"type":"result","sessionId":"cs5","uuid":"r1","total_cost_usd":0,"num_turns":1}`,
	)
	// Fresh parser rescan (daemon restart / full re-read).
	p2 := NewJSONLStreamParser()
	second := parseClaudeLines(t, p2,
		`{"type":"user","sessionId":"cs5","uuid":"u1","message":{"role":"user","content":"fixture one"}}`,
		`{"type":"result","sessionId":"cs5","uuid":"r1","total_cost_usd":0,"num_turns":1}`,
	)
	if first[0][0].TurnID != second[0][0].TurnID || first[0][0].EventID != second[0][0].EventID {
		t.Fatalf("rescan ids drifted: %+v vs %+v", first[0][0], second[0][0])
	}
	if first[1][0].EventID != second[1][0].EventID {
		t.Fatal("completed event id drifted across rescan")
	}
}

// Sidechain (subagent) records classify as subagent actors with their own
// turn namespace — never guessing a parent turn edge.
func TestClaudeTurnSidechainActorScope(t *testing.T) {
	p := NewJSONLStreamParser()
	batches := parseClaudeLines(t, p,
		`{"type":"user","sessionId":"cs6","uuid":"su1","isSidechain":true,"message":{"role":"user","content":"fixture subtask"}}`,
		`{"type":"assistant","sessionId":"cs6","uuid":"sa1","isSidechain":true,"message":{"role":"assistant","model":"GLM-5.2","content":[{"type":"text","text":"fixture sub reply"}]}}`,
	)
	if len(batches[0]) != 2 || batches[0][0].ActorScope != protocol.ActorScopeSubagent {
		t.Fatalf("sidechain start = %+v", batches[0])
	}
	if batches[0][0].TurnID == turn.LogicalTurnID(AgentClaude, "cs6", "", "source_message", "su1") {
		t.Fatal("subagent anchor must use the sidechain actor key")
	}
	if batches[1][0].ActorScope != protocol.ActorScopeSubagent || batches[1][0].TurnID != batches[0][0].TurnID {
		t.Fatalf("sidechain reply = %+v", batches[1][0])
	}
}
