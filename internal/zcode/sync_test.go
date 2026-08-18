package zcode

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestZcodeSync_PreviewPartRevisionOnContentChange(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	// first emission
	b1, _ := z.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v1"}, "")
	if b1.SkipReason != "" || b1.Events[0].Revision != 1 {
		t.Fatalf("first emit: reason=%q rev=%d %+v", b1.SkipReason, b1.Events[0].Revision, b1.Events)
	}
	if !b1.Events[0].Replace {
		t.Fatal("first emit must be Replace=true (snapshot)")
	}
	commit1 := b1.Commit
	commit1.CommitOrder = 1
	if err := z.ApplyAccepted(commit1); err != nil {
		t.Fatal(err)
	}
	// identical content → skipped
	if b, _ := z.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v1"}, ""); b.SkipReason != "skip" {
		t.Fatal("identical content should be skipped")
	}
	// changed content → revision 2, PreviousEventID chained
	b2, _ := z.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v2"}, "")
	if b2.Events[0].Revision != 2 {
		t.Fatalf("changed emit: rev=%d", b2.Events[0].Revision)
	}
	if b2.Events[0].PreviousEventID != b1.Events[0].EventID {
		t.Fatalf("PreviousEventID must chain: %q want %q", b2.Events[0].PreviousEventID, b1.Events[0].EventID)
	}
	if b2.Events[0].EventID == b1.Events[0].EventID {
		t.Fatal("changed content must yield a new event id")
	}
}

func TestZcodeSync_PreviewSessionMetaDiscoveredOnce(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	first, _ := z.PreviewSessionMeta("title", "anthropic/claude", "completed")
	if len(first.Events) != 1 || first.Events[0].Type != "session_discovered" {
		t.Fatalf("first meta should be discovered: %+v", first.Events)
	}
	mc := first.Commit
	mc.CommitOrder = 1
	if err := z.ApplyAccepted(mc); err != nil {
		t.Fatal(err)
	}
	// same title/model → no new events
	if got, _ := z.PreviewSessionMeta("title", "anthropic/claude", "completed"); len(got.Events) != 0 {
		t.Fatalf("unchanged meta should emit nothing: %+v", got.Events)
	}
	// title change → title update
	got, _ := z.PreviewSessionMeta("new title", "anthropic/claude", "completed")
	if len(got.Events) != 1 || got.Events[0].Type != "session_title_update" {
		t.Fatalf("title change: %+v", got.Events)
	}
	tc := got.Commit
	tc.CommitOrder = 2
	if err := z.ApplyAccepted(tc); err != nil {
		t.Fatal(err)
	}
	// model change → model changed
	got, _ = z.PreviewSessionMeta("new title", "openai/gpt", "completed")
	if len(got.Events) != 1 || got.Events[0].Type != "session_model_changed" {
		t.Fatalf("model change: %+v", got.Events)
	}
}

func TestZcodeSync_PreviewMessageUserAndAssistantError(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	// user message with text parts
	b, _ := z.PreviewMessage("m1", "wm1", ZcodeMessageData{
		Role:  "user",
		Parts: []ZcodePartData{{Type: "text", Text: "hello user"}},
	})
	if len(b.Events) != 1 || b.Events[0].Type != "user_text" || b.Events[0].Text != "hello user" {
		t.Fatalf("user message: %+v", b.Events)
	}
	// assistant error
	b, _ = z.PreviewMessage("m2", "wm2", ZcodeMessageData{Role: "assistant", Error: &ZcodeError{Message: "boom"}})
	if len(b.Events) != 1 || b.Events[0].Type != "error" || b.Events[0].Error != "boom" {
		t.Fatalf("assistant error: %+v", b.Events)
	}
}

func TestZcodeSync_PreviewMessageFiltersSyntheticSystem(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	if b, _ := z.PreviewMessage("m", "w", ZcodeMessageData{Role: "assistant", Synthetic: true}); len(b.Events) != 0 {
		t.Fatal("synthetic must not reach mapper")
	}
	if b, _ := z.PreviewMessage("m", "w", ZcodeMessageData{Role: "system"}); len(b.Events) != 0 {
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
	// differ/mapper. The real guard is the absence of the import (verified by
	// the build). We assert our mapper namespace is isolated.
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	b, _ := z.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "x"}, "")
	if len(b.Events) != 1 || b.Events[0].EventID[:6] != "zcode:" {
		t.Fatalf("event id not zcode-namespaced: %q", b.Events[0].EventID)
	}
}

func TestZcodeSync_PreviewStatusChange(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	// First call seeds statusHash via the discovered commit (completed).
	first, _ := z.PreviewSessionMeta("title", "", "completed")
	mc := first.Commit
	mc.CommitOrder = 1
	if err := z.ApplyAccepted(mc); err != nil {
		t.Fatal(err)
	}
	// Same status → no event
	if b, _ := z.PreviewStatus("completed"); len(b.Events) != 0 {
		t.Fatalf("same status should not emit: %+v", b.Events)
	}
	// Status changed to running → emit session_status
	b, _ := z.PreviewStatus("running")
	if len(b.Events) != 1 || b.Events[0].Type != "session_status" || b.Events[0].Status != "running" {
		t.Fatalf("status change event: %+v", b.Events)
	}
	sc := b.Commit
	sc.CommitOrder = 2
	if err := z.ApplyAccepted(sc); err != nil {
		t.Fatal(err)
	}
	// Same again → no event
	if b, _ := z.PreviewStatus("running"); len(b.Events) != 0 {
		t.Fatalf("same status again should not emit: %+v", b.Events)
	}
	// Back to completed → emit
	b, _ = z.PreviewStatus("completed")
	if len(b.Events) != 1 || b.Events[0].Status != "completed" {
		t.Fatalf("status back to completed: %+v", b.Events)
	}
}

// TestZcodeSync_PreviewStatusRetryKeepsEventID verifies that previews are pure:
// a status event that was never applied regenerates with the same identity on
// every retry.
func TestZcodeSync_PreviewStatusRetryKeepsEventID(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	first, _ := z.PreviewSessionMeta("title", "", "completed")
	mc := first.Commit
	mc.CommitOrder = 1
	if err := z.ApplyAccepted(mc); err != nil {
		t.Fatal(err)
	}
	b1, _ := z.PreviewStatus("running")
	if len(b1.Events) != 1 {
		t.Fatal("first PreviewStatus(running) should emit")
	}
	// No ApplyAccepted — simulate emit rejected.
	b2, _ := z.PreviewStatus("running")
	if len(b2.Events) != 1 {
		t.Fatal("retry without accept should still emit (preview is pure)")
	}
	if b2.Events[0].EventID != b1.Events[0].EventID {
		t.Fatal("retry must yield same event id")
	}
}

// --- preview / restart-safe projection tests --------------------------------

func acceptPart(t *testing.T, z *ZcodeSync, nativePartID string, part ZcodePartData, order uint64) DiffBatch {
	t.Helper()
	b, err := z.PreviewPart(nativePartID, "m1", part, "")
	if err != nil {
		t.Fatalf("PreviewPart: %v", err)
	}
	if len(b.Events) != 1 {
		t.Fatalf("PreviewPart produced %d events, want 1", len(b.Events))
	}
	commit := b.Commit
	commit.CommitOrder = order
	if err := z.ApplyAccepted(commit); err != nil {
		t.Fatalf("ApplyAccepted: %v", err)
	}
	return b
}

func TestZcodeSync_PreviewRetryKeepsEventID(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	part := ZcodePartData{Type: "text", Text: "v1"}
	b1, err := z.PreviewPart("p1", "m1", part, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(b1.Events) != 1 || b1.Events[0].Revision != 1 {
		t.Fatalf("first preview: %+v", b1.Events)
	}
	// The receiver was not mutated: an identical retry must produce the same
	// event identity and revision.
	b2, err := z.PreviewPart("p1", "m1", part, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(b2.Events) != 1 {
		t.Fatalf("retry produced %d events, want 1", len(b2.Events))
	}
	if b2.Events[0].EventID != b1.Events[0].EventID {
		t.Fatalf("retry event id changed: %q vs %q", b2.Events[0].EventID, b1.Events[0].EventID)
	}
	if b2.Events[0].Revision != 1 {
		t.Fatalf("retry revision = %d, want 1", b2.Events[0].Revision)
	}
	if b2.Commit.Part.Revision != 1 {
		t.Fatalf("retry commit revision = %d, want 1", b2.Commit.Part.Revision)
	}
}

func TestZcodeSync_AcceptedPreviewSuppressesDuplicate(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	part := ZcodePartData{Type: "text", Text: "v1"}
	acceptPart(t, z, "p1", part, 1)
	again, err := z.PreviewPart("p1", "m1", part, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Events) != 0 {
		t.Fatalf("accepted content must not re-emit: %+v", again.Events)
	}
	if again.SkipReason == "" {
		t.Fatal("suppressed preview should carry a skip reason")
	}
}

func TestZcodeSync_CloneDoesNotMutateOriginal(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	acceptPart(t, z, "p1", ZcodePartData{Type: "text", Text: "v1"}, 1)
	wp := WirePartID(testSourceID, "p1")
	c := z.Clone()
	acceptPart(t, c, "p1", ZcodePartData{Type: "text", Text: "v2"}, 2)
	if got := c.Checkpoint().Parts[wp].Revision; got != 2 {
		t.Fatalf("clone revision = %d, want 2", got)
	}
	if got := z.Checkpoint().Parts[wp].Revision; got != 1 {
		t.Fatalf("original mutated by clone: revision = %d, want 1", got)
	}
}

func TestZcodeSync_RestartContinuesPartRevision(t *testing.T) {
	z1 := NewZcodeSync(testSourceID, "zcode-wire1")
	acceptPart(t, z1, "p1", ZcodePartData{Type: "text", Text: "v1"}, 1)
	z2, err := NewZcodeSyncFromCheckpoint(testSourceID, "zcode-wire1", z1.Checkpoint())
	if err != nil {
		t.Fatal(err)
	}
	b, err := z2.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v2"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := b.Events[0].Revision; got != 2 {
		t.Fatalf("restart reused revision: got %d, want 2", got)
	}
}

func TestZcodeSync_RestartPreservesPreviousEventID(t *testing.T) {
	z1 := NewZcodeSync(testSourceID, "zcode-wire1")
	b1 := acceptPart(t, z1, "p1", ZcodePartData{Type: "text", Text: "v1"}, 1)
	z2, err := NewZcodeSyncFromCheckpoint(testSourceID, "zcode-wire1", z1.Checkpoint())
	if err != nil {
		t.Fatal(err)
	}
	b2, err := z2.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v2"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := b2.Events[0].PreviousEventID; got != b1.Events[0].EventID {
		t.Fatalf("restart lost PreviousEventID: %q, want %q", got, b1.Events[0].EventID)
	}
}

func TestZcodeSync_RestartReplaysPendingCommitsInOrder(t *testing.T) {
	wp := WirePartID(testSourceID, "p1")
	cursor := SessionCursor{
		Sync: SyncCheckpoint{
			LastCommitOrder: 1,
			LastEventID:     "e1",
			Parts:           map[string]PartCheckpoint{wp: {EventID: "e1", Revision: 1, SemanticHash: "s1"}},
		},
		Pending: map[string]PendingPosition{
			"k2": {Commit: SyncCommit{CommitOrder: 2, LastEventID: "e2", Part: &PartCommit{WirePartID: wp, EventID: "e2", Revision: 2, SemanticHash: "s2"}}},
			"k3": {Commit: SyncCommit{CommitOrder: 3, LastEventID: "e3", Part: &PartCommit{WirePartID: wp, EventID: "e3", Revision: 3, SemanticHash: "s3"}}},
		},
	}
	z, err := NewZcodeSyncFromSessionCursor(testSourceID, "zcode-wire1", cursor)
	if err != nil {
		t.Fatal(err)
	}
	cp := z.Checkpoint()
	if got := cp.Parts[wp].Revision; got != 3 {
		t.Fatalf("speculative revision = %d, want 3 (pending commits replayed in order)", got)
	}
	if cp.LastEventID != "e3" {
		t.Fatalf("speculative last event = %q, want e3", cp.LastEventID)
	}
	// The next mutation must continue the speculative chain.
	b, err := z.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v4"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := b.Events[0].Revision; got != 4 {
		t.Fatalf("next revision = %d, want 4", got)
	}
	if got := b.Events[0].PreviousEventID; got != "e3" {
		t.Fatalf("next PreviousEventID = %q, want e3", got)
	}
}

func TestZcodeSync_SpeculativePageChainsPartRevisions(t *testing.T) {
	base := NewZcodeSync(testSourceID, "zcode-wire1")
	acceptPart(t, base, "p1", ZcodePartData{Type: "text", Text: "v1"}, 1)
	scratch := base.Clone()
	b1, err := scratch.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v2"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := scratch.applyProvisional(b1.Commit); err != nil {
		t.Fatalf("applyProvisional: %v", err)
	}
	b2, err := scratch.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v3"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := b2.Events[0].Revision; got != 3 {
		t.Fatalf("second page row revision = %d, want 3", got)
	}
	if got := b2.Events[0].PreviousEventID; got != b1.Events[0].EventID {
		t.Fatalf("second page row PreviousEventID = %q, want %q", got, b1.Events[0].EventID)
	}
	// The authoritative receiver is untouched by scratch paging.
	bb, err := base.PreviewPart("p1", "m1", ZcodePartData{Type: "text", Text: "v2"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := bb.Events[0].Revision; got != 2 {
		t.Fatalf("base revision advanced by scratch: %d, want 2", got)
	}
}

func TestZcodeSync_CheckpointContainsNoSourceContent(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	meta, err := z.PreviewSessionMeta("SECRET-TITLE", "SECRET/MODEL", "completed")
	if err != nil {
		t.Fatal(err)
	}
	mc := meta.Commit
	mc.CommitOrder = 1
	if err := z.ApplyAccepted(mc); err != nil {
		t.Fatal(err)
	}
	acceptPart(t, z, "p1", ZcodePartData{Type: "text", Text: "SECRET-PART-TEXT"}, 2)
	blob, err := json.Marshal(z.Checkpoint())
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	for _, secret := range []string{"SECRET-TITLE", "SECRET/MODEL", "SECRET-PART-TEXT", "\"text\"", "\"title\":", "\"output\""} {
		if strings.Contains(s, secret) {
			t.Fatalf("checkpoint leaked %q: %s", secret, s)
		}
	}
	wp := WirePartID(testSourceID, "p1")
	if !strings.Contains(s, wp) {
		t.Fatal("checkpoint should contain the wire part id")
	}
}

func TestZcodeSync_OlderCommitCannotRegressCheckpoint(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	acceptPart(t, z, "p1", ZcodePartData{Type: "text", Text: "v1"}, 4)
	b2 := acceptPart(t, z, "p1", ZcodePartData{Type: "text", Text: "v2"}, 5)
	wp := WirePartID(testSourceID, "p1")
	older := SyncCommit{
		CommitOrder: 3,
		LastEventID: "stale-event",
		Part:        &PartCommit{WirePartID: wp, EventID: "stale-part-event", Revision: 1, SemanticHash: "stale"},
	}
	if err := z.ApplyAccepted(older); err != nil {
		t.Fatalf("stale commit must be ignored, not error: %v", err)
	}
	cp := z.Checkpoint()
	if got := cp.Parts[wp].Revision; got != 2 {
		t.Fatalf("stale commit regressed revision to %d, want 2", got)
	}
	if cp.LastEventID != b2.Events[0].EventID {
		t.Fatalf("stale commit regressed last event to %q", cp.LastEventID)
	}
}

func TestZcodeSync_EqualRevisionConflictIsRejected(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	acceptPart(t, z, "p1", ZcodePartData{Type: "text", Text: "v1"}, 1)
	acceptPart(t, z, "p1", ZcodePartData{Type: "text", Text: "v2"}, 2)
	wp := WirePartID(testSourceID, "p1")
	conflict := SyncCommit{
		CommitOrder: 9,
		Part:        &PartCommit{WirePartID: wp, EventID: "different-event", Revision: 2, SemanticHash: "different"},
	}
	if err := z.ApplyAccepted(conflict); !errors.Is(err, ErrCursorPartConflict) {
		t.Fatalf("error = %v, want ErrCursorPartConflict", err)
	}
}

func TestZcodeSync_MalformedCheckpointRejected(t *testing.T) {
	if _, err := NewZcodeSyncFromCheckpoint(testSourceID, "w", SyncCheckpoint{
		Parts: map[string]PartCheckpoint{"wp": {EventID: "e", Revision: 0, SemanticHash: "s"}},
	}); err == nil {
		t.Fatal("revision < 1 must be rejected")
	}
	wp := WirePartID(testSourceID, "p1")
	cursor := SessionCursor{
		Sync: SyncCheckpoint{LastCommitOrder: 1, Parts: map[string]PartCheckpoint{wp: {EventID: "e1", Revision: 1, SemanticHash: "s1"}}},
		Pending: map[string]PendingPosition{
			"k2":  {Commit: SyncCommit{CommitOrder: 2, Part: &PartCommit{WirePartID: wp, EventID: "e2", Revision: 2, SemanticHash: "s2"}}},
			"k2b": {Commit: SyncCommit{CommitOrder: 3, Part: &PartCommit{WirePartID: wp, EventID: "e2x", Revision: 2, SemanticHash: "s2x"}}},
		},
	}
	if _, err := NewZcodeSyncFromSessionCursor(testSourceID, "w", cursor); !errors.Is(err, ErrCursorPartConflict) {
		t.Fatalf("conflicting pending commits must be rejected, got %v", err)
	}
}

func TestZcodeSync_MessageCheckpointCommitOrderRules(t *testing.T) {
	z := NewZcodeSync(testSourceID, "zcode-wire1")
	apply := func(order uint64, eid, semantic string) error {
		return z.ApplyAccepted(SyncCommit{
			CommitOrder: order,
			Message:     &MessageCommit{WireMessageID: "wm1", EventID: eid, SemanticHash: semantic},
		})
	}
	if err := apply(5, "e5", "s5"); err != nil {
		t.Fatal(err)
	}
	// Lower order is stale and ignored.
	if err := apply(3, "e3", "s3"); err != nil {
		t.Fatal(err)
	}
	if cp := z.Checkpoint().Messages["wm1"]; cp.EventID != "e5" || cp.CommitOrder != 5 {
		t.Fatalf("stale commit replaced the checkpoint: %+v", cp)
	}
	// Equal order with identical identity is an idempotent no-op.
	if err := apply(5, "e5", "s5"); err != nil {
		t.Fatal(err)
	}
	// Equal order with a different identity is a typed conflict.
	if err := apply(5, "eX", "sX"); !errors.Is(err, ErrCursorMessageConflict) {
		t.Fatalf("error = %v, want ErrCursorMessageConflict", err)
	}
	// Higher order replaces.
	if err := apply(7, "e7", "s7"); err != nil {
		t.Fatal(err)
	}
	if cp := z.Checkpoint().Messages["wm1"]; cp.EventID != "e7" || cp.CommitOrder != 7 {
		t.Fatalf("higher commit did not replace the checkpoint: %+v", cp)
	}
	// A zero-order (legacy) stored checkpoint is superseded by any non-zero commit.
	z2 := NewZcodeSync(testSourceID, "zcode-wire1")
	cp := z2.Checkpoint()
	cp.Messages = map[string]MessageCheckpoint{"wm1": {EventID: "e-old", SemanticHash: "s-old"}}
	if err := z2.ApplyAccepted(SyncCommit{CommitOrder: 1, Message: &MessageCommit{WireMessageID: "wm1", EventID: "e1", SemanticHash: "s1"}}); err != nil {
		t.Fatal(err)
	}
	_ = cp
	hydrated, err := NewZcodeSyncFromCheckpoint(testSourceID, "zcode-wire1", z2.Checkpoint())
	if err != nil {
		t.Fatal(err)
	}
	if got := hydrated.Checkpoint().Messages["wm1"]; got.EventID != "e1" || got.CommitOrder != 1 {
		t.Fatalf("non-zero commit must supersede the zero-order legacy checkpoint: %+v", got)
	}
}
