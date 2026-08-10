package zcode

import (
	"testing"
)

func TestZcodeSync_DiffPartRevisionOnContentChange(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	// first emission
	ev1, reason := z.DiffPart("p1", "m1", ZcodePartData{Type: "text", Text: "v1"}, "anthropic/claude")
	if reason != "" || ev1.Revision != 1 {
		t.Fatalf("first emit: reason=%q rev=%d %+v", reason, ev1.Revision, ev1)
	}
	if !ev1.Replace {
		t.Fatal("first emit must be Replace=true (snapshot)")
	}
	z.CommitPart() // confirm successful emit
	// identical content → skipped
	if _, reason := z.DiffPart("p1", "m1", ZcodePartData{Type: "text", Text: "v1"}, "anthropic/claude"); reason != "skip" {
		t.Fatal("identical content should be skipped")
	}
	// changed content → revision 2, PreviousEventID chained
	ev2, reason := z.DiffPart("p1", "m1", ZcodePartData{Type: "text", Text: "v2"}, "anthropic/claude")
	if reason != "" || ev2.Revision != 2 {
		t.Fatalf("changed emit: reason=%q rev=%d", reason, ev2.Revision)
	}
	if ev2.PreviousEventID != ev1.EventID {
		t.Fatalf("PreviousEventID must chain: %q want %q", ev2.PreviousEventID, ev1.EventID)
	}
	if ev2.EventID == ev1.EventID {
		t.Fatal("changed content must yield a new event id")
	}
	z.CommitPart()
}

// TestZcodeSync_DiffPartNotCommittedRetried verifies the core fix: if DiffPart
// produces an event but CommitPart is NOT called (emit was rejected by the low-
// priority gate), the next DiffPart for the same content returns the SAME event
// (not "skip"), so it is retried with a stable event id until emit succeeds.
func TestZcodeSync_DiffPartNotCommittedRetried(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	ev1, reason := z.DiffPart("p1", "m1", ZcodePartData{Type: "text", Text: "v1"}, "")
	if reason != "" {
		t.Fatalf("first DiffPart: reason=%q", reason)
	}
	// NO CommitPart — simulate emit rejected by the gate.
	// Retry: same content must return the same event (not "skip").
	ev2, reason := z.DiffPart("p1", "m1", ZcodePartData{Type: "text", Text: "v1"}, "")
	if reason != "" {
		t.Fatalf("retry DiffPart without commit: reason=%q want empty", reason)
	}
	if ev2.EventID != ev1.EventID {
		t.Fatalf("retry must yield same event id: %q vs %q", ev2.EventID, ev1.EventID)
	}
	if ev2.Revision != 1 {
		t.Fatalf("retry must keep revision 1 (not incremented): got %d", ev2.Revision)
	}
}

func TestZcodeSync_DiffSessionMetaDiscoveredOnce(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	first := z.DiffSessionMeta("title", "anthropic/claude", "completed")
	if len(first) != 1 || first[0].Type != "session_discovered" {
		t.Fatalf("first meta should be discovered: %+v", first)
	}
	// same title/model → no new events
	if got := z.DiffSessionMeta("title", "anthropic/claude", "completed"); len(got) != 0 {
		t.Fatalf("unchanged meta should emit nothing: %+v", got)
	}
	// title change → title update
	got := z.DiffSessionMeta("new title", "anthropic/claude", "completed")
	if len(got) != 1 || got[0].Type != "session_title_update" {
		t.Fatalf("title change: %+v", got)
	}
	// model change → model changed
	got = z.DiffSessionMeta("new title", "openai/gpt", "completed")
	if len(got) != 1 || got[0].Type != "session_model_changed" {
		t.Fatalf("model change: %+v", got)
	}
}

func TestZcodeSync_DiffMessageUserAndAssistantError(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	// user message with text parts
	evs := z.DiffMessage("m1", "wm1", ZcodeMessageData{
		Role:  "user",
		Parts: []ZcodePartData{{Type: "text", Text: "hello user"}},
	})
	if len(evs) != 1 || evs[0].Type != "user_text" || evs[0].Text != "hello user" {
		t.Fatalf("user message: %+v", evs)
	}
	// assistant error
	evs = z.DiffMessage("m2", "wm2", ZcodeMessageData{Role: "assistant", Error: &ZcodeError{Message: "boom"}})
	if len(evs) != 1 || evs[0].Type != "error" || evs[0].Error != "boom" {
		t.Fatalf("assistant error: %+v", evs)
	}
}

func TestZcodeSync_DiffMessageFiltersSyntheticSystem(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	if evs := z.DiffMessage("m", "w", ZcodeMessageData{Role: "assistant", Synthetic: true}); evs != nil {
		t.Fatal("synthetic must not reach mapper")
	}
	if evs := z.DiffMessage("m", "w", ZcodeMessageData{Role: "system"}); evs != nil {
		t.Fatal("system role must not reach mapper")
	}
}

func TestZcodeSync_DiffTodosClearEmits(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	if evs := z.DiffTodos([]TodoRow{{Content: "a", Status: "pending"}}); len(evs) != 1 {
		t.Fatal("first todo should emit")
	}
	// transition to empty (clear) must still emit
	if evs := z.DiffTodos(nil); len(evs) != 1 {
		t.Fatalf("todo clear must emit, got %d", len(evs))
	}
}

func TestZcodeSync_DoesNotImportOpencode(t *testing.T) {
	// This is a compile-time guard: internal/zcode must not import the OpenCode
	// differ/mapper. The test existence documents the constraint; the real guard
	// is the absence of the import (verified by the build and by Task 12's
	// go vet / import checks). We assert our mapper namespace is isolated.
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	ev, _ := z.DiffPart("p1", "m1", ZcodePartData{Type: "text", Text: "x"}, "")
	if ev.EventID == "" || ev.EventID[:6] != "zcode:" {
		t.Fatalf("event id not zcode-namespaced: %q", ev.EventID)
	}
}

func TestZcodeSync_DiffStatusChange(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	// First call seeds statusHash via DiffSessionMeta (discovered with completed)
	z.DiffSessionMeta("title", "", "completed")
	// Same status → no event
	if evs := z.DiffStatus("completed"); len(evs) != 0 {
		t.Fatalf("same status should not emit: %+v", evs)
	}
	// Status changed to running → emit session_status
	evs := z.DiffStatus("running")
	if len(evs) != 1 || evs[0].Type != "session_status" || evs[0].Status != "running" {
		t.Fatalf("status change event: %+v", evs)
	}
	z.CommitStatus()
	// Same again → no event
	if evs := z.DiffStatus("running"); len(evs) != 0 {
		t.Fatalf("same status again should not emit: %+v", evs)
	}
	// Back to completed → emit
	evs = z.DiffStatus("completed")
	if len(evs) != 1 || evs[0].Status != "completed" {
		t.Fatalf("status back to completed: %+v", evs)
	}
	z.CommitStatus()
}

// TestZcodeSync_DiffStatusNotCommittedRetried verifies that if DiffStatus
// produces an event but CommitStatus is NOT called (emit was rejected by the
// gate), the next DiffStatus for the same status returns the same event (not
// nil), so it is retried.
func TestZcodeSync_DiffStatusNotCommittedRetried(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	z.DiffSessionMeta("title", "", "completed")
	ev1 := z.DiffStatus("running")
	if len(ev1) != 1 {
		t.Fatal("first DiffStatus(running) should emit")
	}
	// NO CommitStatus — simulate emit rejected.
	ev2 := z.DiffStatus("running")
	if len(ev2) != 1 {
		t.Fatal("retry without commit should still emit (not cached)")
	}
	if ev2[0].EventID != ev1[0].EventID {
		t.Fatal("retry must yield same event id")
	}
}
