package adapter

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// mkMsg builds an OpencodeMessageWithParts for the differ tests. completed>0
// marks an assistant turn as finished.
func mkMsg(id, role, model string, created, completed int64, parts ...OpencodePart) OpencodeMessageWithParts {
	m := OpencodeMessageWithParts{Parts: parts}
	m.Info.ID = id
	m.Info.Role = role
	m.Info.Time.Created = created
	m.Info.Time.Completed = completed
	if model != "" {
		m.Info.Model = &OpencodeModelRef{ProviderID: "opencode", ModelID: model}
	}
	return m
}

func shortSHA256(value string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(value)))[:16]
}

func TestOpencodeSync_EventIDsStableAcrossInstances(t *testing.T) {
	snapshot := []OpencodeMessageWithParts{
		mkMsg("msg_u", "user", "", 1, 0,
			OpencodePart{ID: "prt_u", MessageID: "msg_u", Type: "text", Text: "question"}),
		mkMsg("msg_a", "assistant", "glm-5", 2, 3,
			OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "answer"},
			OpencodePart{ID: "prt_reason", MessageID: "msg_a", Type: "reasoning", Text: "thinking"},
			OpencodePart{ID: "prt_tool", MessageID: "msg_a", Type: "tool", CallID: "call_1", Tool: "read",
				State: &OpencodeToolState{Status: "completed", Output: "ok"}}),
	}
	first := NewOpencodeSync("ses_1", true).Diff(snapshot)
	second := NewOpencodeSync("ses_1", true).Diff(snapshot)
	if len(first) != len(second) {
		t.Fatalf("fresh syncs emitted different event counts: %d != %d", len(first), len(second))
	}
	for i := range first {
		if first[i].EventID != second[i].EventID {
			t.Fatalf("event %d identity changed across sync instances: %q != %q", i, first[i].EventID, second[i].EventID)
		}
	}
	wants := map[string]string{
		"user_text":       "opencode:user:msg_u:prt_u",
		"agent_text":      "opencode:part:prt_text:final:" + shortSHA256("answer"),
		"agent_reasoning": "opencode:part:prt_reason:final:" + shortSHA256("thinking"),
	}
	for _, event := range first {
		if event.Type == "tool_result" && !strings.HasPrefix(event.EventID, "opencode:tool:call_1:completed:") {
			t.Errorf("tool_result event_id=%q", event.EventID)
		}
		if want, ok := wants[event.Type]; ok && event.EventID != want {
			t.Errorf("%s event_id=%q want %q", event.Type, event.EventID, want)
		}
	}
}

func TestOpencodeSync_EventIDsPreserveTextAndToolTransitions(t *testing.T) {
	syncer := NewOpencodeSync("ses_1", false)
	stream := syncer.Diff([]OpencodeMessageWithParts{mkMsg("msg_a", "assistant", "glm-5", 1, 0,
		OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hel"},
		OpencodePart{ID: "prt_tool", MessageID: "msg_a", Type: "tool", CallID: "call_1", Tool: "read",
			State: &OpencodeToolState{Status: "running", Input: []byte(`{"path":"a"}`)}},
	)})
	growth := syncer.Diff([]OpencodeMessageWithParts{mkMsg("msg_a", "assistant", "glm-5", 1, 0,
		OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hello"},
		OpencodePart{ID: "prt_tool", MessageID: "msg_a", Type: "tool", CallID: "call_1", Tool: "read",
			State: &OpencodeToolState{Status: "completed", Output: "ok"}},
	)})
	if stream[0].EventID != "opencode:part:prt_text:stream:"+shortSHA256("Hel") {
		t.Fatalf("initial stream id=%q", stream[0].EventID)
	}
	if growth[0].EventID != "opencode:part:prt_text:stream:"+shortSHA256("Hello") || growth[0].EventID == stream[0].EventID {
		t.Fatalf("text growth must have snapshot-derived identity: before=%q after=%q", stream[0].EventID, growth[0].EventID)
	}
	if !strings.HasPrefix(stream[1].EventID, "opencode:tool:call_1:running:") || !strings.HasPrefix(growth[1].EventID, "opencode:tool:call_1:completed:") {
		t.Fatalf("tool state identities wrong: before=%q after=%q", stream[1].EventID, growth[1].EventID)
	}
}

func TestOpencodeSync_TextEventIDsFormRestartStableCausalChain(t *testing.T) {
	firstSync := NewOpencodeSync("ses_1", false)
	first := firstSync.Diff([]OpencodeMessageWithParts{mkMsg("msg_a", "assistant", "glm-5", 1, 0,
		OpencodePart{ID: "prt_text", Type: "text", Text: "Hel"},
	)})[0]
	if first.PreviousEventID != "" {
		t.Fatalf("first snapshot unexpectedly has predecessor %q", first.PreviousEventID)
	}

	restarted := NewOpencodeSync("ses_1", false)
	seed := restarted.Diff([]OpencodeMessageWithParts{mkMsg("msg_a", "assistant", "glm-5", 1, 0,
		OpencodePart{ID: "prt_text", Type: "text", Text: "Hel"},
	)})[0]
	if seed.EventID != first.EventID {
		t.Fatalf("restart seed id changed: %q != %q", seed.EventID, first.EventID)
	}
	growth := restarted.Diff([]OpencodeMessageWithParts{mkMsg("msg_a", "assistant", "glm-5", 1, 0,
		OpencodePart{ID: "prt_text", Type: "text", Text: "Hell"},
	)})[0]
	if growth.PreviousEventID != seed.EventID {
		t.Fatalf("growth predecessor=%q want %q", growth.PreviousEventID, seed.EventID)
	}
	if growth.Text != "l" || growth.Snapshot != "Hell" {
		t.Fatalf("growth must carry delta plus full snapshot: %+v", growth)
	}
	final := restarted.Diff([]OpencodeMessageWithParts{mkMsg("msg_a", "assistant", "glm-5", 1, 2,
		OpencodePart{ID: "prt_text", Type: "text", Text: "Hell"},
	)})[0]
	if final.PreviousEventID != growth.EventID || final.EventID == growth.EventID {
		t.Fatalf("final causal identity wrong: previous=%q id=%q growth=%q", final.PreviousEventID, final.EventID, growth.EventID)
	}
}

func TestOpencodeSync_ToolSameStateMutationEmitsDistinctStableEvents(t *testing.T) {
	syncer := NewOpencodeSync("ses_1", false)
	tool := func(status, input, output, stateError string) []OpencodeMessageWithParts {
		return []OpencodeMessageWithParts{mkMsg("msg_a", "assistant", "glm-5", 1, 0,
			OpencodePart{ID: "prt_tool", Type: "tool", CallID: "call_1", Tool: "read", State: &OpencodeToolState{
				Status: status, Input: json.RawMessage(input), Output: output, Error: stateError,
			}},
		)}
	}
	running1 := syncer.Diff(tool("running", `{"path":"a","mode":1}`, "", ""))[0]
	if exact := syncer.Diff(tool("running", `{"mode":1,"path":"a"}`, "", "")); len(exact) != 0 {
		t.Fatalf("exact running replay emitted: %+v", exact)
	}
	running2 := syncer.Diff(tool("running", `{"path":"b"}`, "", ""))[0]
	completed1 := syncer.Diff(tool("completed", `{"path":"b"}`, "one", ""))[0]
	completed2 := syncer.Diff(tool("completed", `{"path":"b"}`, "two", ""))[0]
	if exact := syncer.Diff(tool("completed", `{"path":"b"}`, "two", "")); len(exact) != 0 {
		t.Fatalf("exact completed replay emitted: %+v", exact)
	}
	error1 := syncer.Diff(tool("error", `{"path":"b"}`, "", "failed one"))[0]
	error2 := syncer.Diff(tool("error", `{"path":"b"}`, "", "failed two"))[0]
	if exact := syncer.Diff(tool("error", `{"path":"b"}`, "", "failed two")); len(exact) != 0 {
		t.Fatalf("exact error replay emitted: %+v", exact)
	}
	for _, pair := range [][2]string{{running1.EventID, running2.EventID}, {completed1.EventID, completed2.EventID}, {error1.EventID, error2.EventID}} {
		if pair[0] == pair[1] {
			t.Fatalf("same-state semantic mutation reused id %q", pair[0])
		}
	}
	if running2.PreviousEventID != running1.EventID || completed2.PreviousEventID != completed1.EventID || error2.PreviousEventID != error1.EventID {
		t.Fatalf("tool mutations lost causal chain: running=%q completed=%q error=%q", running2.PreviousEventID, completed2.PreviousEventID, error2.PreviousEventID)
	}
}

func TestOpencodeSync_EmptyNativeIDsGetDistinctStableFallbacks(t *testing.T) {
	snapshot := []OpencodeMessageWithParts{
		mkMsg("", "assistant", "glm-5", 100, 0,
			OpencodePart{Type: "text", Text: "one"},
			OpencodePart{Type: "text", Text: "two"},
			OpencodePart{Type: "tool", Tool: "read", State: &OpencodeToolState{Status: "running", Input: []byte(`{"path":"a"}`)}},
			OpencodePart{Type: "tool", Tool: "read", State: &OpencodeToolState{Status: "running", Input: []byte(`{"path":"b"}`)}}),
		mkMsg("", "assistant", "glm-5", 101, 2),
		mkMsg("", "assistant", "glm-5", 102, 3),
	}
	snapshot[1].Info.Error = []byte(`{"name":"Error","data":{"message":"failed"}}`)
	snapshot[2].Info.Error = []byte(`{"name":"Error","data":{"message":"failed"}}`)
	first := NewOpencodeSync("ses_1", false).Diff(snapshot)
	second := NewOpencodeSync("ses_1", false).Diff(snapshot)
	seen := map[string]bool{}
	for i := range first {
		if first[i].Type == "session_status" {
			continue
		}
		if first[i].EventID == "" || first[i].EventID != second[i].EventID {
			t.Fatalf("event %d fallback identity unstable: %q != %q", i, first[i].EventID, second[i].EventID)
		}
		if seen[first[i].EventID] {
			t.Fatalf("fallback identity collision: %q", first[i].EventID)
		}
		seen[first[i].EventID] = true
		if strings.Contains(first[i].EventID, "tool::") {
			t.Fatalf("empty tool identity leaked into id: %q", first[i].EventID)
		}
	}
}

func TestOpencodeSync_EmptyMessageFallbackSurvivesEarlierHistory(t *testing.T) {
	target := func() OpencodeMessageWithParts {
		return mkMsg("", "assistant", "glm-5", 100, 0, OpencodePart{Type: "text", Text: "target"})
	}
	first := NewOpencodeSync("ses_1", false).Diff([]OpencodeMessageWithParts{target()})[0]
	withHistory := NewOpencodeSync("ses_1", false).Diff([]OpencodeMessageWithParts{
		mkMsg("older", "user", "", 50, 0, OpencodePart{ID: "older-part", Type: "text", Text: "old"}),
		target(),
	})
	var replay protocol.DaemonEvent
	for _, event := range withHistory {
		if event.Text == "target" {
			replay = event
			break
		}
	}
	if replay.EventID != first.EventID {
		t.Fatalf("earlier history changed fallback identity: %q != %q", replay.EventID, first.EventID)
	}
}

func TestOpencodeSync_EmptyMessageFallbackSurvivesSameContextInsertion(t *testing.T) {
	target := func() OpencodeMessageWithParts {
		return mkMsg("", "assistant", "glm-5", 100, 0, OpencodePart{Type: "text", Text: "target"})
	}
	first := NewOpencodeSync("ses_1", false).Diff([]OpencodeMessageWithParts{target()})[0]
	withPeer := NewOpencodeSync("ses_1", false).Diff([]OpencodeMessageWithParts{
		mkMsg("", "assistant", "glm-5", 100, 0, OpencodePart{Type: "text", Text: "inserted"}),
		target(),
	})
	found := false
	for _, event := range withPeer {
		if event.Text == "target" {
			found = true
			if event.EventID != first.EventID {
				t.Fatalf("same-context insertion changed fallback identity: %q != %q", event.EventID, first.EventID)
			}
		}
	}
	if !found {
		t.Fatal("target event missing")
	}
}

func TestOpencodeSync_EmptyPartFallbackSurvivesPrefixInsertion(t *testing.T) {
	target := OpencodePart{Type: "text", Text: "target"}
	first := NewOpencodeSync("ses_1", false).Diff([]OpencodeMessageWithParts{
		mkMsg("msg_1", "assistant", "glm-5", 100, 0, target),
	})[0]
	withPrefix := NewOpencodeSync("ses_1", false).Diff([]OpencodeMessageWithParts{
		mkMsg("msg_1", "assistant", "glm-5", 100, 0, OpencodePart{Type: "reasoning", Text: "prefix"}, target),
	})
	found := false
	for _, event := range withPrefix {
		if event.Text == "target" {
			found = true
			if event.EventID != first.EventID {
				t.Fatalf("Part prefix changed fallback identity: %q != %q", event.EventID, first.EventID)
			}
		}
	}
	if !found {
		t.Fatal("target event missing")
	}
}

func TestOpencodeSync_ErrorEventIDChangesWithError(t *testing.T) {
	syncer := NewOpencodeSync("ses_1", false)
	first := mkMsg("msg_a", "assistant", "glm-5", 1, 2)
	first.Info.Error = []byte(`{"name":"APIError","data":{"message":"failed"}}`)
	before := syncer.Diff([]OpencodeMessageWithParts{first})[0]
	changed := first
	changed.Info.Error = []byte(`{"name":"APIError","data":{"message":"retry failed"}}`)
	after := syncer.Diff([]OpencodeMessageWithParts{changed})[0]
	if before.EventID != "opencode:error:msg_a:"+shortSHA256("failed") || before.EventID == after.EventID {
		t.Fatalf("error identities wrong: before=%q after=%q", before.EventID, after.EventID)
	}
}

func TestOpencodeSync_IncrementalAndOrdering(t *testing.T) {
	s := NewOpencodeSync("ses_x", true /*emitUser*/)

	// Snapshot 1: user message (older) + assistant with an in-flight tool (running).
	snap1 := []OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 2000, 0,
			OpencodePart{ID: "prt_t", Type: "tool", CallID: "c1", Tool: "grep",
				State: &OpencodeToolState{Status: "running", Input: []byte(`{"p":"x"}`)}},
		),
		mkMsg("msg_u", "user", "", 1000, 0,
			OpencodePart{ID: "prt_u", Type: "text", Text: "hi"},
		),
	}
	got := s.Diff(snap1)
	// turn_status(running), user_text, tool_call, then session_status=running.
	if len(got) != 4 {
		t.Fatalf("snap1 want 4 events, got %d: %+v", len(got), got)
	}
	if got[0].Type != "turn_status" || got[0].TurnStatus != "running" || got[0].SourceTurnID != "msg_u" {
		t.Fatalf("snap1[0] should be turn_status running anchored on the user message: %+v", got[0])
	}
	if got[1].Type != "user_text" || got[1].Text != "hi" {
		t.Fatalf("snap1[1] should be user_text: %+v", got[1])
	}
	if got[2].Type != "tool_call" || got[2].CallID != "c1" {
		t.Fatalf("snap1[2] should be tool_call: %+v", got[2])
	}
	if got[3].Type != "session_status" || got[3].Status != "running" {
		t.Fatalf("snap1[3] should be session_status running: %+v", got[3])
	}

	// Snapshot 2: identical → nothing new (status unchanged too).
	if got := s.Diff(snap1); got != nil {
		t.Fatalf("unchanged snapshot should yield nil, got %+v", got)
	}

	// Snapshot 3: tool completes in place + assistant adds text + turn completed.
	snap3 := []OpencodeMessageWithParts{
		mkMsg("msg_u", "user", "", 1000, 0,
			OpencodePart{ID: "prt_u", Type: "text", Text: "hi"}),
		mkMsg("msg_a", "assistant", "glm-5", 2000, 2500, // completed now
			OpencodePart{ID: "prt_t", Type: "tool", CallID: "c1", Tool: "grep",
				State: &OpencodeToolState{Status: "completed", Output: "Found 1"}},
			OpencodePart{ID: "prt_ans", Type: "text", Text: "done"},
		),
	}
	got = s.Diff(snap3)
	// tool_result, agent_text, then turn_status(completed), session_status=idle
	// (terminal turn events follow the content but precede the session status).
	if len(got) != 4 {
		t.Fatalf("snap3 want 4 events, got %d: %+v", len(got), got)
	}
	if got[0].Type != "tool_result" || got[0].CallID != "c1" || got[0].Output != "Found 1" {
		t.Fatalf("snap3[0] should be tool_result: %+v", got[0])
	}
	if got[1].Type != "agent_text" || got[1].Text != "done" || got[1].Model != "opencode/glm-5" {
		t.Fatalf("snap3[1] should be agent_text: %+v", got[1])
	}
	if got[2].Type != "turn_status" || got[2].TurnStatus != "completed" || got[2].TurnID != turn.LogicalTurnID(AgentOpencode, "ses_x", "", "source_message", "msg_u") {
		t.Fatalf("snap3[2] should be the completed turn_status: %+v", got[2])
	}
	if got[3].Type != "session_status" || got[3].Status != "idle" {
		t.Fatalf("snap3[3] should be session_status idle: %+v", got[3])
	}
}

func TestOpencodeSync_MultiTurnLifecycleStaysAdjacentToItsContent(t *testing.T) {
	s := NewOpencodeSync("ses_multi", true)
	snapshot := []OpencodeMessageWithParts{
		mkMsg("user-1", "user", "", 1000, 0,
			OpencodePart{ID: "user-part-1", Type: "text", Text: "first"}),
		mkMsg("assistant-1", "assistant", "glm-5", 2000, 2500,
			OpencodePart{ID: "assistant-part-1", Type: "text", Text: "first reply"}),
		mkMsg("user-2", "user", "", 3000, 0,
			OpencodePart{ID: "user-part-2", Type: "text", Text: "second"}),
		mkMsg("assistant-2", "assistant", "glm-5", 4000, 0,
			OpencodePart{ID: "assistant-part-2", Type: "text", Text: "working"}),
	}
	events := s.Diff(snapshot)
	index := func(match func(protocol.DaemonEvent) bool) int {
		for i, ev := range events {
			if match(ev) {
				return i
			}
		}
		return -1
	}
	terminal1 := index(func(ev protocol.DaemonEvent) bool {
		return ev.Type == protocol.EventTypeTurnStatus && ev.SourceTurnID == "user-1" && ev.TurnStatus == protocol.TurnStateCompleted
	})
	running2 := index(func(ev protocol.DaemonEvent) bool {
		return ev.Type == protocol.EventTypeTurnStatus && ev.SourceTurnID == "user-2" && ev.TurnStatus == protocol.TurnStateRunning
	})
	content1 := index(func(ev protocol.DaemonEvent) bool {
		return ev.Type == "agent_text" && ev.SourceTurnID == "user-1"
	})
	content2 := index(func(ev protocol.DaemonEvent) bool {
		return ev.Type == "user_text" && ev.SourceTurnID == "user-2"
	})
	if content1 < 0 || terminal1 < 0 || running2 < 0 || content2 < 0 {
		t.Fatalf("missing multi-turn evidence: %+v", events)
	}
	if !(content1 < terminal1 && terminal1 < running2 && running2 < content2) {
		t.Fatalf("cross-turn lifecycle order = content1:%d terminal1:%d running2:%d content2:%d events=%+v",
			content1, terminal1, running2, content2, events)
	}
	if last := events[len(events)-1]; last.Type != "session_status" {
		t.Fatalf("session status must remain last: %+v", events)
	}
}

// A fast opencode turn can start and finish within a single poll window, so its
// "running" state is never observed and (with lastStatus already idle) the
// trailing idle is deduped away — leaving the turn with zero session_status
// events and the client's optimistic timer stuck. Turn-completion detection must
// force a terminal idle in that case.
func TestOpencodeSync_FastTurnForcesIdle(t *testing.T) {
	s := NewOpencodeSync("ses_z", true)

	// Poll 1: turn 1 already finished (assistant completed). Seeds the completion
	// tracker and reports idle.
	snap1 := []OpencodeMessageWithParts{
		mkMsg("msg_u1", "user", "", 1000, 0,
			OpencodePart{ID: "p_u1", Type: "text", Text: "first"}),
		mkMsg("msg_a1", "assistant", "glm-5", 2000, 2500,
			OpencodePart{ID: "p_a1", Type: "text", Text: "reply one"}),
	}
	got := s.Diff(snap1)
	if last := got[len(got)-1]; last.Type != "session_status" || last.Status != "idle" {
		t.Fatalf("snap1 should end with session_status idle, got %+v", got)
	}

	// Poll 2: turn 2 started AND finished between polls — assistant already
	// completed, "running" never observed, derived status still idle. Without
	// turn-completion detection this emits no session_status.
	snap2 := []OpencodeMessageWithParts{
		mkMsg("msg_u1", "user", "", 1000, 0,
			OpencodePart{ID: "p_u1", Type: "text", Text: "first"}),
		mkMsg("msg_a1", "assistant", "glm-5", 2000, 2500,
			OpencodePart{ID: "p_a1", Type: "text", Text: "reply one"}),
		mkMsg("msg_u2", "user", "", 3000, 0,
			OpencodePart{ID: "p_u2", Type: "text", Text: "second"}),
		mkMsg("msg_a2", "assistant", "glm-5", 3500, 4000,
			OpencodePart{ID: "p_a2", Type: "text", Text: "reply two"}),
	}
	got = s.Diff(snap2)
	sawIdle := false
	for _, ev := range got {
		if ev.Type == "session_status" && ev.Status == "idle" {
			sawIdle = true
		}
	}
	if !sawIdle {
		t.Fatalf("fast turn 2 should force a session_status idle, got %+v", got)
	}
}

func TestOpencodeSync_EmitUserFalse(t *testing.T) {
	// Owned sessions: user_text suppressed (echoed on Send instead).
	s := NewOpencodeSync("ses_y", false)
	snap := []OpencodeMessageWithParts{
		mkMsg("msg_u", "user", "", 1000, 0,
			OpencodePart{ID: "prt_u", Type: "text", Text: "hello"}),
		mkMsg("msg_a", "assistant", "glm-5", 2000, 2500,
			OpencodePart{ID: "prt_a", Type: "text", Text: "hi back"}),
	}
	got := s.Diff(snap)
	// agent_text, turn_status(completed), session_status idle (user_text
	// dropped; the turn lifecycle itself is never suppressed; the terminal
	// event follows the content it closes).
	if len(got) != 3 {
		t.Fatalf("emitUser=false want 3 events, got %d: %+v", len(got), got)
	}
	if got[0].Type != "agent_text" || got[0].Text != "hi back" {
		t.Fatalf("expected agent_text, got %+v", got[0])
	}
	if got[1].Type != "turn_status" || got[1].TurnStatus != "completed" || got[1].SourceTurnID != "msg_u" {
		t.Fatalf("expected completed turn_status, got %+v", got[1])
	}
	if got[2].Type != "session_status" || got[2].Status != "idle" {
		t.Fatalf("expected session_status idle, got %+v", got[2])
	}
}

func TestOpencodeSync_TextGrowth(t *testing.T) {
	s := NewOpencodeSync("ses_growth", false)

	first := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0,
			OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hel"}),
	})
	if len(first) < 1 || first[0].Type != "agent_text" {
		t.Fatalf("first snapshot must emit agent_text: %+v", first)
	}
	if first[0].Text != "Hel" || !first[0].Streaming || first[0].Replace || first[0].PartID != "prt_text" || first[0].Revision != 1 {
		t.Fatalf("unexpected initial text event: %+v", first[0])
	}

	second := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0,
			OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hello"}),
	})
	if len(second) != 1 {
		t.Fatalf("growth snapshot should emit one delta, got %+v", second)
	}
	if second[0].Text != "lo" || !second[0].Streaming || second[0].Replace || second[0].PartID != "prt_text" || second[0].Revision != 2 {
		t.Fatalf("prefix growth must be an append delta: %+v", second[0])
	}
}

func TestOpencodeSync_TextRevision(t *testing.T) {
	s := NewOpencodeSync("ses_revision", false)
	s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0,
			OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hello"}),
	})

	got := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0,
			OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hallo"}),
	})
	if len(got) != 1 {
		t.Fatalf("revision snapshot should emit one replacement, got %+v", got)
	}
	if got[0].Text != "Hallo" || !got[0].Replace || got[0].Revision != 2 {
		t.Fatalf("non-prefix revision must replace full text: %+v", got[0])
	}
}

func TestOpencodeSync_FinalSnapshot(t *testing.T) {
	s := NewOpencodeSync("ses_final", false)
	s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0,
			OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hello"}),
	})

	got := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 2000,
			OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hello"}),
	})
	if len(got) < 1 {
		t.Fatal("completion must emit a final text snapshot")
	}
	final := got[0]
	if final.Type != "agent_text" || final.Text != "Hello" || final.Streaming || !final.Replace || final.Revision != 2 {
		t.Fatalf("completion must emit the exact final snapshot: %+v", final)
	}

	again := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 2000,
			OpencodePart{ID: "prt_text", MessageID: "msg_a", Type: "text", Text: "Hello"}),
	})
	for _, ev := range again {
		if ev.Type == "agent_text" {
			t.Fatalf("unchanged completed snapshot must not repeat final text: %+v", again)
		}
	}
}

func TestOpencodeSync_Reasoning(t *testing.T) {
	s := NewOpencodeSync("ses_reasoning", false)
	first := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0,
			OpencodePart{ID: "prt_reason", MessageID: "msg_a", Type: "reasoning", Text: "think"}),
	})
	if len(first) < 1 || first[0].Type != "agent_reasoning" || first[0].Text != "think" || !first[0].Streaming {
		t.Fatalf("initial reasoning mapping wrong: %+v", first)
	}

	growth := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0,
			OpencodePart{ID: "prt_reason", MessageID: "msg_a", Type: "reasoning", Text: "thinking"}),
	})
	if len(growth) != 1 || growth[0].Text != "ing" || growth[0].Revision != 2 || growth[0].Replace {
		t.Fatalf("reasoning growth must be an append delta: %+v", growth)
	}

	final := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 2000,
			OpencodePart{ID: "prt_reason", MessageID: "msg_a", Type: "reasoning", Text: "thinking"}),
	})
	if len(final) < 1 || final[0].Type != "agent_reasoning" || final[0].Text != "thinking" || !final[0].Replace || final[0].Streaming {
		t.Fatalf("reasoning completion must emit final snapshot: %+v", final)
	}
}

func TestOpencodeSync_AssistantError(t *testing.T) {
	s := NewOpencodeSync("ses_error", false)
	m := mkMsg("msg_a", "assistant", "glm-5", 1000, 2000)
	m.Info.Error = []byte(`{"name":"UnknownError","data":{"message":"provider failed"}}`)
	got := s.Diff([]OpencodeMessageWithParts{m})
	if len(got) < 1 || got[0].Type != "error" || got[0].Error != "provider failed" || got[0].MessageID != "msg_a" {
		t.Fatalf("assistant error mapping wrong: %+v", got)
	}
	if again := s.Diff([]OpencodeMessageWithParts{m}); again != nil {
		t.Fatalf("unchanged assistant error must not repeat: %+v", again)
	}

	m.Info.Error = []byte(`{"name":"APIError","data":{"message":"rate limited","isRetryable":true}}`)
	changed := s.Diff([]OpencodeMessageWithParts{m})
	if len(changed) != 1 || changed[0].Error != "rate limited" {
		t.Fatalf("changed assistant error should emit once: %+v", changed)
	}
}

func TestOpencodeSync_Retry(t *testing.T) {
	s := NewOpencodeSync("ses_retry", false)
	retry := OpencodePart{
		ID: "prt_retry", MessageID: "msg_a", Type: "retry", Attempt: 2,
		Error: []byte(`{"name":"APIError","data":{"message":"rate limited","isRetryable":true}}`),
	}
	retry.Time.Created = 1234
	got := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0, retry),
	})
	if len(got) < 1 || got[0].Type != "agent_retry" || got[0].Attempt != 2 || got[0].RetryAt != 1234 || got[0].Error != "rate limited" {
		t.Fatalf("retry mapping wrong: %+v", got)
	}
	unchanged := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 0, retry),
	})
	for _, ev := range unchanged {
		if ev.Type == "agent_retry" {
			t.Fatalf("unchanged retry must not repeat: %+v", unchanged)
		}
	}
}

func TestOpencodeSync_Compaction(t *testing.T) {
	s := NewOpencodeSync("ses_compaction", false)
	part := OpencodePart{ID: "prt_compact", MessageID: "msg_a", Type: "compaction", Auto: true, Overflow: true}
	got := s.Diff([]OpencodeMessageWithParts{
		mkMsg("msg_a", "assistant", "glm-5", 1000, 2000, part),
	})
	if len(got) < 1 || got[0].Type != "agent_compaction" || !got[0].Auto || !got[0].Overflow || got[0].PartID != "prt_compact" {
		t.Fatalf("compaction mapping wrong: %+v", got)
	}
	if again := s.Diff([]OpencodeMessageWithParts{mkMsg("msg_a", "assistant", "glm-5", 1000, 2000, part)}); again != nil {
		t.Fatalf("unchanged compaction must not repeat: %+v", again)
	}
}

func TestOpencodeCanonicalJSONPreservesLargeIntegers(t *testing.T) {
	left := opencodeCanonicalJSON(json.RawMessage(`{"value":9007199254740992}`))
	right := opencodeCanonicalJSON(json.RawMessage(`{"value":9007199254740993}`))
	if string(left) == string(right) {
		t.Fatalf("adjacent integers above 2^53 must remain distinct: %s", left)
	}
	if string(right) != `{"value":9007199254740993}` {
		t.Fatalf("large integer changed during canonicalization: %s", right)
	}
}
