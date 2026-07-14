package adapter

import "testing"

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
	// user_text, tool_call, then session_status=running (turn in progress).
	if len(got) != 3 {
		t.Fatalf("snap1 want 3 events, got %d: %+v", len(got), got)
	}
	if got[0].Type != "user_text" || got[0].Text != "hi" {
		t.Fatalf("snap1[0] should be user_text: %+v", got[0])
	}
	if got[1].Type != "tool_call" || got[1].CallID != "c1" {
		t.Fatalf("snap1[1] should be tool_call: %+v", got[1])
	}
	if got[2].Type != "session_status" || got[2].Status != "running" {
		t.Fatalf("snap1[2] should be session_status running: %+v", got[2])
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
	// tool_result, agent_text, then session_status=idle (turn finished).
	if len(got) != 3 {
		t.Fatalf("snap3 want 3 events, got %d: %+v", len(got), got)
	}
	if got[0].Type != "tool_result" || got[0].CallID != "c1" || got[0].Output != "Found 1" {
		t.Fatalf("snap3[0] should be tool_result: %+v", got[0])
	}
	if got[1].Type != "agent_text" || got[1].Text != "done" || got[1].Model != "opencode/glm-5" {
		t.Fatalf("snap3[1] should be agent_text: %+v", got[1])
	}
	if got[2].Type != "session_status" || got[2].Status != "idle" {
		t.Fatalf("snap3[2] should be session_status idle: %+v", got[2])
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
	// agent_text + session_status idle (user_text dropped).
	if len(got) != 2 {
		t.Fatalf("emitUser=false want 2 events, got %d: %+v", len(got), got)
	}
	if got[0].Type != "agent_text" || got[0].Text != "hi back" {
		t.Fatalf("expected agent_text, got %+v", got[0])
	}
	if got[1].Type != "session_status" || got[1].Status != "idle" {
		t.Fatalf("expected session_status idle, got %+v", got[1])
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
