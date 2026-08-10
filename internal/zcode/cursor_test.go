package zcode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newCursorStore(t *testing.T) *CursorStore {
	t.Helper()
	dir := t.TempDir()
	return NewCursorStoreAt(filepath.Join(dir, "zcode-sync-cursor.json"))
}

func TestCursorSaveLoad_RoundTripAndPermission(t *testing.T) {
	cs := newCursorStore(t)
	cf := CursorFile{
		StoragePathHash:   "hash1",
		SourceID:          "src1",
		SchemaFingerprint: "fp1",
		Sessions: map[string]SessionCursor{
			"zcode-wire1": {AckMessageSequence: 5, TitleHash: "th"},
		},
	}
	if err := cs.Save(cf); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(cs.Path())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("perm = %o, want 0600", perm)
	}
	got, err := cs.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.Sessions["zcode-wire1"].AckMessageSequence != 5 {
		t.Fatalf("round-trip failed: %+v", got)
	}
}

func TestCursorLoad_MissingIsEmpty(t *testing.T) {
	cs := newCursorStore(t)
	cf, err := cs.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cf.Sessions) != 0 {
		t.Fatalf("missing cursor should be empty: %+v", cf)
	}
}

func TestCursorLoad_CorruptFailClosedAndEvidence(t *testing.T) {
	cs := newCursorStore(t)
	if err := os.WriteFile(cs.Path(), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(cs.Path())
	cf, err := cs.Load()
	if err == nil {
		t.Fatal("corrupt cursor should error")
	}
	if len(cf.Sessions) != 0 {
		t.Fatal("corrupt cursor must yield empty (fail-closed)")
	}
	// Evidence preserved as .corrupt-*.
	entries, _ := os.ReadDir(dir)
	found := false
	for _, e := range entries {
		if strings.Contains(e.Name(), ".corrupt") {
			found = true
		}
	}
	if !found {
		t.Fatal("corrupt cursor evidence not preserved")
	}
}

func TestCursor_NoContentStored(t *testing.T) {
	cs := newCursorStore(t)
	cf := CursorFile{
		Sessions: map[string]SessionCursor{
			"zcode-wire1": {
				TitleHash: "h", ModelHash: "h", TodoHash: "h",
				Pending: map[string]PendingPosition{
					"pos1": {ExpectedEventIDs: []string{"e1"}},
				},
			},
		},
	}
	if err := cs.Save(cf); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(cs.Path())
	blob := string(data)
	// Must not contain common content-bearing field names or plaintext values.
	for _, bad := range []string{"\"text\"", "\"prompt\"", "\"title\":", "\"cwd\"", "\"output\"", "secret-prompt"} {
		if strings.Contains(blob, bad) {
			t.Fatalf("cursor stored content marker %q:\n%s", bad, blob)
		}
	}
}

func TestCursor_RecordPendingThenAckAdvances(t *testing.T) {
	cs := newCursorStore(t)
	cf := CursorFile{Sessions: map[string]SessionCursor{}}
	if err := cs.RecordPending(&cf, "w1", "pos1", []string{"e1", "e2"}, ""); err != nil {
		t.Fatal(err)
	}
	// ACK only e1 → not delivered (position still pending).
	changed, err := cs.AcknowledgeEventIDs(&cf, []string{"e1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cf.Sessions["w1"].Pending) != 1 {
		t.Fatal("partial ACK must not deliver position")
	}
	_ = changed // session state changed (e1 now acked) but position still pending
	// ACK e2 → delivered, pending cleared.
	changed, err = cs.AcknowledgeEventIDs(&cf, []string{"e2"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cf.Sessions["w1"].Pending) != 0 {
		t.Fatal("full ACK must clear pending position")
	}
	if len(changed) != 1 || changed[0] != "w1" {
		t.Fatalf("changed = %v", changed)
	}
}

func TestCursor_OutOfOrderAckDoesNotCrossGap(t *testing.T) {
	cs := newCursorStore(t)
	cf := CursorFile{Sessions: map[string]SessionCursor{}}
	cs.RecordPending(&cf, "w1", "pos1", []string{"e1"}, "")
	cs.RecordPending(&cf, "w1", "pos2", []string{"e2"}, "")
	// ACK pos2 but not pos1 → gap, neither delivered.
	cs.AcknowledgeEventIDs(&cf, []string{"e2"})
	if len(cf.Sessions["w1"].Pending) != 2 {
		t.Fatalf("gap must not deliver; pending=%d", len(cf.Sessions["w1"].Pending))
	}
	// Now ACK pos1 → pos1 delivered, pos2 already acked → both close.
	cs.AcknowledgeEventIDs(&cf, []string{"e1"})
	if len(cf.Sessions["w1"].Pending) != 0 {
		t.Fatalf("after gap closure pending=%d", len(cf.Sessions["w1"].Pending))
	}
}

func TestCursor_DuplicateAckIdempotent(t *testing.T) {
	cs := newCursorStore(t)
	cf := CursorFile{Sessions: map[string]SessionCursor{}}
	cs.RecordPending(&cf, "w1", "pos1", []string{"e1"}, "")
	cs.AcknowledgeEventIDs(&cf, []string{"e1"})
	// Re-ACK the same id → no error, no change.
	if _, err := cs.AcknowledgeEventIDs(&cf, []string{"e1"}); err != nil {
		t.Fatal(err)
	}
	if len(cf.Sessions["w1"].Pending) != 0 {
		t.Fatal("duplicate ACK should leave delivered position cleared")
	}
}

func TestCursor_UnknownAckIdempotent(t *testing.T) {
	cs := newCursorStore(t)
	cf := CursorFile{Sessions: map[string]SessionCursor{"w1": {Pending: map[string]PendingPosition{"pos1": {ExpectedEventIDs: []string{"e1"}}}}}}
	if _, err := cs.AcknowledgeEventIDs(&cf, []string{"unknown-eid"}); err != nil {
		t.Fatal(err)
	}
	if len(cf.Sessions["w1"].Pending) != 1 {
		t.Fatal("unknown ACK must not change state")
	}
}

func TestCursor_SkippedPositionClosesWithAcked(t *testing.T) {
	cs := newCursorStore(t)
	cf := CursorFile{Sessions: map[string]SessionCursor{}}
	cs.RecordPending(&cf, "w1", "pos1", []string{"e1"}, "")
	cs.RecordPending(&cf, "w1", "pos2", nil, "filtered_role") // skipped, no events
	cs.RecordPending(&cf, "w1", "pos3", []string{"e3"}, "")
	// ACK e1 and e3 → pos1, pos2 (skipped), pos3 all close contiguously.
	cs.AcknowledgeEventIDs(&cf, []string{"e1", "e3"})
	if len(cf.Sessions["w1"].Pending) != 0 {
		t.Fatalf("skipped+acked contiguous run should close; pending=%d", len(cf.Sessions["w1"].Pending))
	}
}

func TestCursor_ResetForSource_SchemaOnlyKeepsSourceID(t *testing.T) {
	cs := newCursorStore(t)
	cf := CursorFile{
		SourceID: "src1", StoragePathHash: "h1", SchemaFingerprint: "fp1",
		Sessions: map[string]SessionCursor{"w1": {AckMessageSequence: 9}},
	}
	if err := cs.Save(cf); err != nil {
		t.Fatal(err)
	}
	// schema-only reset: source id preserved, cursors cleared.
	cs.ResetForSource(&cf, "h1", "src1", "fp2", true)
	if cf.SourceID != "src1" {
		t.Fatal("schema reset must keep source id")
	}
	if len(cf.Sessions) != 0 {
		t.Fatal("schema reset must clear cursors")
	}
	// full reset (storage change): new source id.
	cs.ResetForSource(&cf, "h2", "src2", "fp2", false)
	if cf.SourceID != "src2" || cf.StoragePathHash != "h2" {
		t.Fatal("full reset must set new source id + storage hash")
	}
}
