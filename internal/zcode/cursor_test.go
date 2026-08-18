package zcode

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newCursorStore(t *testing.T) *CursorStore {
	t.Helper()
	dir := t.TempDir()
	return NewCursorStoreAt(filepath.Join(dir, "zcode-sync-cursor.json"))
}

func mustSnapshot(t *testing.T, cs *CursorStore) CursorFile {
	t.Helper()
	snap, err := cs.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	return snap.File
}

// countPersists wraps the store's persist function with a call counter.
func countPersists(cs *CursorStore) *atomic.Int32 {
	t := &atomic.Int32{}
	prev := cs.persist
	cs.persist = func(cf CursorFile) error {
		t.Add(1)
		if prev != nil {
			return prev(cf)
		}
		return cs.writeCursor(cf)
	}
	return t
}

// recordBatchAt records a batch using the session's current state revision and
// an explicit scan timestamp. Event-producing records are marked
// PayloadDurable the way the journal-backed observer does.
func recordBatchAt(t *testing.T, cs *CursorStore, wireID string, scan int64, recs ...PendingRecord) RecordedBatch {
	t.Helper()
	for i := range recs {
		if len(recs[i].ExpectedEventIDs) > 0 {
			recs[i].PayloadDurable = true
		}
	}
	cf := mustSnapshot(t, cs)
	out, err := cs.RecordPendingBatch(PendingBatchRequest{
		WireSessionID:         wireID,
		ExpectedStateRevision: cf.Sessions[wireID].StateRevision,
		Records:               recs,
	}, scan)
	if err != nil {
		t.Fatalf("RecordPendingBatch: %v", err)
	}
	return out
}

// --- persistence round-trip tests -------------------------------------------

func TestCursorSaveLoad_RoundTripAndPermission(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "zcode-wire1", 1_000_000, PendingRecord{
		WireSessionID:    "zcode-wire1",
		Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 5},
		ExpectedEventIDs: []string{"e1"},
	})
	info, err := os.Stat(cs.Path())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("perm = %o, want 0600", perm)
	}
	got := mustSnapshot(t, cs)
	if got.Sessions["zcode-wire1"].AckMessageSequence != 0 {
		t.Fatalf("round-trip mutated state: %+v", got)
	}
	if got.Version != CursorVersion {
		t.Fatalf("version = %d, want %d", got.Version, CursorVersion)
	}
	if len(got.Sessions["zcode-wire1"].Pending) != 1 {
		t.Fatalf("round-trip lost pending: %+v", got.Sessions["zcode-wire1"])
	}
}

func TestCursorLoad_MissingIsEmpty(t *testing.T) {
	cs := newCursorStore(t)
	cf := mustSnapshot(t, cs)
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
	if _, err := cs.Snapshot(); err == nil {
		t.Fatal("corrupt cursor should error")
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
	recordBatchAt(t, cs, "zcode-wire1", 1_000_000, PendingRecord{
		WireSessionID:    "zcode-wire1",
		Position:         SourcePosition{Kind: PositionMetadata, NativeIDHash: "h"},
		ExpectedEventIDs: []string{"e1"},
		Commit:           SyncCommit{Title: &NamedCommit{EventID: "e1", Hash: "th"}, Model: &NamedCommit{EventID: "e1", Hash: "mh"}},
	})
	data, _ := os.ReadFile(cs.Path())
	blob := string(data)
	// Must not contain content-bearing field names or plaintext values. (The
	// commit's "title" key is content-free: it wraps {event_id, hash} only.)
	for _, bad := range []string{"\"text\"", "\"prompt\"", "\"cwd\"", "\"output\"", "secret-prompt", "SECRET-TITLE-PLAINTEXT"} {
		if strings.Contains(blob, bad) {
			t.Fatalf("cursor stored content marker %q:\n%s", bad, blob)
		}
	}
}

func TestCursorStore_SkippedPositionClosesWithAcked(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000,
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1}, ExpectedEventIDs: []string{"e1"}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2}, SkippedReason: "filtered_role"},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 3}, ExpectedEventIDs: []string{"e3"}},
	)
	// ACK e1 and e3 → the skipped row closes with the contiguous prefix.
	if _, err := cs.AcknowledgeEventIDs([]string{"e1", "e3"}); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 0 {
		t.Fatalf("skipped+acked contiguous run should close; pending=%d", got)
	}
	if got := cf.Sessions["w1"].AckMessageSequence; got != 3 {
		t.Fatalf("AckMessageSequence = %d, want 3", got)
	}
}

func TestCursorStore_CrossStreamSkipDoesNotLeapfrogEventChain(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
		Commit:           SyncCommit{LastEventID: "e1"},
	})
	recordBatchAt(t, cs, "w1", 1_000_100, PendingRecord{
		WireSessionID: "w1",
		Position:      SourcePosition{Kind: PositionPartInsert, PartMessageSeq: 1, PartSequence: 1},
		SkippedReason: "unknown",
	})

	beforeAck := mustSnapshot(t, cs).Sessions["w1"].Sync
	if beforeAck.LastCommitOrder != 0 || beforeAck.LastEventID != "" {
		t.Fatalf("cross-stream skip advanced event chain before ACK: %+v", beforeAck)
	}
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err != nil {
		t.Fatal(err)
	}
	afterAck := mustSnapshot(t, cs).Sessions["w1"].Sync
	if afterAck.LastCommitOrder != 1 || afterAck.LastEventID != "e1" {
		t.Fatalf("event ACK did not become the durable chain head: %+v", afterAck)
	}
}

func TestCursorStore_UpdateIdentityResetsOnlyWhenChanged(t *testing.T) {
	cs := newCursorStore(t)
	ident := CursorIdentity{StoragePathHash: "h1", SourceID: "src1", SchemaFingerprint: "fp1"}
	if err := cs.UpdateIdentity(ident); err != nil {
		t.Fatal(err)
	}
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 9},
		ExpectedEventIDs: []string{"e1"},
	})
	// Same identity → no-op, sessions preserved.
	if err := cs.UpdateIdentity(ident); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	if len(cf.Sessions["w1"].Pending) != 1 {
		t.Fatal("identity no-op must not reset sessions")
	}
	// Schema-only change → sessions cleared, source id kept.
	if err := cs.UpdateIdentity(CursorIdentity{StoragePathHash: "h1", SourceID: "src1", SchemaFingerprint: "fp2"}); err != nil {
		t.Fatal(err)
	}
	cf = mustSnapshot(t, cs)
	if cf.SourceID != "src1" {
		t.Fatal("schema reset must keep source id")
	}
	if len(cf.Sessions) != 0 {
		t.Fatal("schema reset must clear sessions")
	}
	// Storage change → full reset with new identity.
	if err := cs.UpdateIdentity(CursorIdentity{StoragePathHash: "h2", SourceID: "src2", SchemaFingerprint: "fp2"}); err != nil {
		t.Fatal(err)
	}
	cf = mustSnapshot(t, cs)
	if cf.SourceID != "src2" || cf.StoragePathHash != "h2" {
		t.Fatal("full reset must set new source id + storage hash")
	}
}

// --- v2 store tests ----------------------------------------------------------

func TestCursorStore_ConcurrentRecordAndAckNoLostUpdate(t *testing.T) {
	cs := newCursorStore(t)
	if err := cs.UpdateIdentity(CursorIdentity{StoragePathHash: "h", SourceID: "s", SchemaFingerprint: "f"}); err != nil {
		t.Fatal(err)
	}
	const workers = 8
	const perWorker = 5
	allIDs := func() []string {
		ids := make([]string, 0, workers*perWorker)
		for w := 0; w < workers; w++ {
			for i := 0; i < perWorker; i++ {
				ids = append(ids, fmt.Sprintf("ev-%d-%d", w, i))
			}
		}
		return ids
	}
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				for attempt := 0; attempt < 200; attempt++ {
					snap, err := cs.Snapshot()
					if err != nil {
						t.Errorf("Snapshot: %v", err)
						return
					}
					_, err = cs.RecordPendingBatch(PendingBatchRequest{
						WireSessionID:         "w1",
						ExpectedStateRevision: snap.File.Sessions["w1"].StateRevision,
						Records: []PendingRecord{{
							WireSessionID:    "w1",
							Position:         SourcePosition{Kind: PositionPartInsert, PartSequence: int64(w*perWorker + i + 1)},
							ExpectedEventIDs: []string{fmt.Sprintf("ev-%d-%d", w, i)},
							PayloadDurable:   true,
						}},
					}, time.Now().UnixMilli())
					if err == nil {
						break
					}
					if !errors.Is(err, ErrCursorConflict) {
						t.Errorf("RecordPendingBatch: %v", err)
						return
					}
				}
			}
		}(w)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for round := 0; round < 10; round++ {
			if _, err := cs.AcknowledgeEventIDs(allIDs()); err != nil {
				t.Errorf("AcknowledgeEventIDs: %v", err)
				return
			}
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 25; i++ {
			_ = cs.TouchLastScan(time.Now().UnixMilli())
			_ = cs.UpdateIdentity(CursorIdentity{StoragePathHash: "h", SourceID: "s", SchemaFingerprint: "f"})
		}
	}()
	wg.Wait()
	// Convergence sweep: re-submit every record (identical content merges with
	// surviving ACKs), then acknowledge everything. All entries must close.
	for w := 0; w < workers; w++ {
		for i := 0; i < perWorker; i++ {
			recordBatchAt(t, cs, "w1", time.Now().UnixMilli(), PendingRecord{
				WireSessionID:    "w1",
				Position:         SourcePosition{Kind: PositionPartInsert, PartSequence: int64(w*perWorker + i + 1)},
				ExpectedEventIDs: []string{fmt.Sprintf("ev-%d-%d", w, i)},
			})
		}
	}
	if _, err := cs.AcknowledgeEventIDs(allIDs()); err != nil {
		t.Fatalf("final ack: %v", err)
	}
	cf := mustSnapshot(t, cs)
	if n := len(cf.Sessions["w1"].Pending); n != 0 {
		t.Fatalf("lost update: %d pending remain", n)
	}
	if got := cf.Sessions["w1"].AckPartSequence; got != workers*perWorker {
		t.Fatalf("AckPartSequence = %d, want %d", got, workers*perWorker)
	}
}

func TestCursorStore_SnapshotIsDeepCopy(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
	})
	snap1 := mustSnapshot(t, cs)
	recordBatchAt(t, cs, "w1", 1_000_100, PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2},
		ExpectedEventIDs: []string{"e2"},
	})
	if got := len(snap1.Sessions["w1"].Pending); got != 1 {
		t.Fatalf("snapshot was not a deep copy: %d pending (want 1)", got)
	}
	// Mutating the snapshot must not leak into the store.
	snap1.Sessions["w1"].Pending["k"] = PendingPosition{}
	delete(snap1.Sessions, "w1")
	cf := mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 2 {
		t.Fatalf("snapshot mutation leaked into store: %d pending (want 2)", got)
	}
}

func TestCursorStore_PersistFailureDoesNotPublishMemoryState(t *testing.T) {
	cs := newCursorStore(t)
	var fails atomic.Bool
	cs.persist = func(cf CursorFile) error {
		if fails.Load() {
			return errors.New("disk full")
		}
		return cs.writeCursor(cf)
	}
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
	})
	fails.Store(true)
	snap := mustSnapshot(t, cs)
	if _, err := cs.RecordPendingBatch(PendingBatchRequest{
		WireSessionID:         "w1",
		ExpectedStateRevision: snap.Sessions["w1"].StateRevision,
		Records: []PendingRecord{{
			WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2},
			ExpectedEventIDs: []string{"e2"},
			PayloadDurable:   true,
		}},
	}, 1_000_100); err == nil {
		t.Fatal("persist failure must surface an error")
	}
	after := mustSnapshot(t, cs)
	if n := len(after.Sessions["w1"].Pending); n != 1 {
		t.Fatalf("failed persist published state: %d pending (want 1)", n)
	}
	if rev := after.Sessions["w1"].StateRevision; rev != snap.Sessions["w1"].StateRevision {
		t.Fatalf("failed persist bumped revision: %d (want %d)", rev, snap.Sessions["w1"].StateRevision)
	}
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err == nil {
		t.Fatal("ack during persist failure must error")
	}
	after = mustSnapshot(t, cs)
	if n := len(after.Sessions["w1"].Pending); n != 1 {
		t.Fatalf("failed ack changed pending: %d (want 1)", n)
	}
	fails.Store(false)
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err != nil {
		t.Fatalf("ack after recovery: %v", err)
	}
	after = mustSnapshot(t, cs)
	if n := len(after.Sessions["w1"].Pending); n != 0 {
		t.Fatalf("recovered ack did not advance: %d pending", n)
	}
	if after.Sessions["w1"].AckMessageSequence != 1 {
		t.Fatalf("recovered ack did not advance high-water: %d", after.Sessions["w1"].AckMessageSequence)
	}
}

func TestCursorStore_RecordPendingBatchPersistsOnce(t *testing.T) {
	cs := newCursorStore(t)
	n := countPersists(cs)
	recordBatchAt(t, cs, "w1", 1_000_000,
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1}, ExpectedEventIDs: []string{"e1"}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2}, ExpectedEventIDs: []string{"e2"}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 3}, ExpectedEventIDs: []string{"e3"}},
	)
	if got := n.Load(); got != 1 {
		t.Fatalf("persist calls = %d, want 1 (page-bounded, not row-bounded)", got)
	}
}

func TestCursorStore_RecordPendingBatchReturnsAssignedOrders(t *testing.T) {
	cs := newCursorStore(t)
	out := recordBatchAt(t, cs, "w1", 1_000_000,
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1}, ExpectedEventIDs: []string{"e1"}, Commit: SyncCommit{LastEventID: "e1"}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2}, ExpectedEventIDs: []string{"e2"}, Commit: SyncCommit{LastEventID: "e2"}},
	)
	if out.StateRevision != 1 {
		t.Fatalf("StateRevision = %d, want 1", out.StateRevision)
	}
	if len(out.Records) != 2 {
		t.Fatalf("records = %d, want 2", len(out.Records))
	}
	for i, rec := range out.Records {
		if rec.Position.Order != uint64(i+1) {
			t.Fatalf("record %d Order = %d, want %d", i, rec.Position.Order, i+1)
		}
		if rec.Commit.CommitOrder != uint64(i+1) {
			t.Fatalf("record %d CommitOrder = %d, want %d", i, rec.Commit.CommitOrder, i+1)
		}
		if rec.Key == "" {
			t.Fatalf("record %d has empty canonical key", i)
		}
	}
	if out.Records[0].Key == out.Records[1].Key {
		t.Fatal("canonical keys must be distinct")
	}
	out2 := recordBatchAt(t, cs, "w1", 1_000_200,
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 3}, ExpectedEventIDs: []string{"e3"}, Commit: SyncCommit{LastEventID: "e3"}},
	)
	if out2.StateRevision != 2 {
		t.Fatalf("second batch StateRevision = %d, want 2", out2.StateRevision)
	}
	if out2.Records[0].Position.Order != 3 {
		t.Fatalf("third entry Order = %d, want 3", out2.Records[0].Position.Order)
	}
}

func TestCursorStore_IdenticalBatchIsNoOp(t *testing.T) {
	cs := newCursorStore(t)
	n := countPersists(cs)
	rec := PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 3, NativeIDHash: "mh"},
		ExpectedEventIDs: []string{"e1"},
	}
	recordBatchAt(t, cs, "w1", 1_000_000, rec)
	n.Store(0)
	out := recordBatchAt(t, cs, "w1", 1_000_100, rec)
	if got := n.Load(); got != 0 {
		t.Fatalf("identical batch persisted %d times, want 0", got)
	}
	if out.StateRevision != 1 {
		t.Fatalf("identical batch bumped revision to %d, want 1", out.StateRevision)
	}
	if len(out.Records) != 1 || out.Records[0].Key == "" {
		t.Fatalf("identical batch must return canonical record: %+v", out.Records)
	}
	// Identical batch with a due scan timestamp persists the scan piggyback
	// without bumping the session revision.
	out = recordBatchAt(t, cs, "w1", 1_061_000, rec)
	if got := n.Load(); got != 1 {
		t.Fatalf("due-scan identical batch persisted %d times, want 1", got)
	}
	if out.StateRevision != 1 {
		t.Fatalf("due-scan identical batch bumped revision to %d, want 1", out.StateRevision)
	}
	cf := mustSnapshot(t, cs)
	if cf.LastScanUnixMs != 1_061_000 {
		t.Fatalf("LastScanUnixMs = %d, want 1061000", cf.LastScanUnixMs)
	}
}

func TestCursorStore_StaleSessionRevisionRejectsPreparedPage(t *testing.T) {
	cs := newCursorStore(t)
	n := countPersists(cs)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
	})
	n.Store(0)
	_, err := cs.RecordPendingBatch(PendingBatchRequest{
		WireSessionID:         "w1",
		ExpectedStateRevision: 0, // stale: session is now at revision 1
		Records: []PendingRecord{{
			WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2},
			ExpectedEventIDs: []string{"e2"},
			PayloadDurable:   true,
		}},
	}, 1_000_100)
	if !errors.Is(err, ErrCursorConflict) {
		t.Fatalf("stale revision error = %v, want ErrCursorConflict", err)
	}
	if got := n.Load(); got != 0 {
		t.Fatalf("conflicting batch persisted %d times, want 0", got)
	}
	cf := mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 1 {
		t.Fatalf("conflicting batch changed pending: %d (want 1)", got)
	}
}

func TestCursorStore_UnrelatedSessionChangeDoesNotConflict(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "wA", 1_000_000, PendingRecord{
		WireSessionID: "wA", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"ea1"},
	})
	recordBatchAt(t, cs, "wA", 1_000_100, PendingRecord{
		WireSessionID: "wA", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2},
		ExpectedEventIDs: []string{"ea2"},
	})
	// wB is still at revision 0 even though wA changed twice.
	recordBatchAt(t, cs, "wB", 1_000_200, PendingRecord{
		WireSessionID: "wB", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"eb1"},
	})
	cf := mustSnapshot(t, cs)
	if len(cf.Sessions["wA"].Pending) != 2 || len(cf.Sessions["wB"].Pending) != 1 {
		t.Fatalf("unrelated session batches lost: %+v", cf.Sessions)
	}
}

func TestCursorStore_PartialAckDoesNotAdvance(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 7},
		ExpectedEventIDs: []string{"e1", "e2"},
	})
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	s := cf.Sessions["w1"]
	if len(s.Pending) != 1 {
		t.Fatalf("partial ACK must keep position pending: %d", len(s.Pending))
	}
	if s.AckMessageSequence != 0 {
		t.Fatalf("partial ACK advanced high-water: %d", s.AckMessageSequence)
	}
	for _, pp := range s.Pending {
		if len(pp.AckedEventIDs) != 1 || pp.AckedEventIDs[0] != "e1" {
			t.Fatalf("acked set = %v, want [e1]", pp.AckedEventIDs)
		}
	}
}

func TestCursorStore_OutOfOrderAckAdvancesOnlyContiguousPrefix(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000,
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 7}, ExpectedEventIDs: []string{"e1"}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 8}, ExpectedEventIDs: []string{"e2"}},
	)
	// ACK the later position first: retained complete, high-water unchanged.
	if _, err := cs.AcknowledgeEventIDs([]string{"e2"}); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 2 {
		t.Fatalf("later completion must be retained: %d pending", got)
	}
	if cf.Sessions["w1"].AckMessageSequence != 0 {
		t.Fatalf("out-of-order ACK advanced high-water: %d", cf.Sessions["w1"].AckMessageSequence)
	}
	// First position completes → both commit in order.
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err != nil {
		t.Fatal(err)
	}
	cf = mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 0 {
		t.Fatalf("contiguous prefix must close: %d pending", got)
	}
	if got := cf.Sessions["w1"].AckMessageSequence; got != 8 {
		t.Fatalf("high-water = %d, want 8", got)
	}
}

func TestCursorStore_AllFiveStreamsAdvanceIndependently(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000,
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMetadata}, ExpectedEventIDs: []string{"em"}, Commit: SyncCommit{Title: &NamedCommit{EventID: "em", Hash: "th"}}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 5}, ExpectedEventIDs: []string{"emi"}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionPartInsert, PartMessageSeq: 2, PartSequence: 3, NativeIDHash: "ph"}, ExpectedEventIDs: []string{"epi"}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageMutation, MutationTime: 1000, NativeIDHash: "mh"}, ExpectedEventIDs: []string{"emm"}},
		PendingRecord{WireSessionID: "w1", Position: SourcePosition{Kind: PositionPartMutation, MutationTime: 2000, NativeIDHash: "ph"}, ExpectedEventIDs: []string{"epm"}},
	)
	// ACK only the message-insert event: that stream advances, others do not.
	if _, err := cs.AcknowledgeEventIDs([]string{"emi"}); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	s := cf.Sessions["w1"]
	if s.AckMessageSequence != 5 {
		t.Fatalf("message insert high-water = %d, want 5", s.AckMessageSequence)
	}
	if s.AckPartMessageSeq != 0 || s.AckPartSequence != 0 || s.AckMessageMutationTime != 0 || s.AckPartMutationTime != 0 {
		t.Fatalf("unrelated streams advanced: %+v", s)
	}
	if got := len(s.Pending); got != 4 {
		t.Fatalf("pending = %d, want 4", got)
	}
	if _, err := cs.AcknowledgeEventIDs([]string{"em", "epi", "emm", "epm"}); err != nil {
		t.Fatal(err)
	}
	cf = mustSnapshot(t, cs)
	s = cf.Sessions["w1"]
	if got := len(s.Pending); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
	if s.AckPartMessageSeq != 2 || s.AckPartSequence != 3 || s.AckPartIDHash != "ph" {
		t.Fatalf("part insert high-water wrong: %+v", s)
	}
	if s.AckMessageMutationTime != 1000 || s.AckMessageMutationIDHash != "mh" {
		t.Fatalf("message mutation high-water wrong: %+v", s)
	}
	if s.AckPartMutationTime != 2000 || s.AckPartMutationIDHash != "ph" {
		t.Fatalf("part mutation high-water wrong: %+v", s)
	}
	if s.Sync.TitleEventID != "em" || s.Sync.TitleHash != "th" {
		t.Fatalf("sync commit not applied: %+v", s.Sync)
	}
}

func TestCursorStore_DuplicateAndUnknownAckAreIdempotent(t *testing.T) {
	cs := newCursorStore(t)
	n := countPersists(cs)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
	})
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err != nil {
		t.Fatal(err)
	}
	n.Store(0)
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err != nil {
		t.Fatalf("duplicate ack: %v", err)
	}
	if _, err := cs.AcknowledgeEventIDs([]string{"unknown-eid"}); err != nil {
		t.Fatalf("unknown ack: %v", err)
	}
	if got := n.Load(); got != 0 {
		t.Fatalf("idempotent acks persisted %d times, want 0", got)
	}
	cf := mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
}

func TestCursorStore_TwoMutationGenerationsDoNotOverwrite(t *testing.T) {
	cs := newCursorStore(t)
	gen1 := PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionPartMutation, MutationTime: 500, NativeIDHash: "ph"},
		ExpectedEventIDs: []string{"g1e1"},
		Commit:           SyncCommit{Part: &PartCommit{WirePartID: "wp", EventID: "g1e1", Revision: 1, SemanticHash: "s1"}},
	}
	gen2 := PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionPartMutation, MutationTime: 500, NativeIDHash: "ph"},
		ExpectedEventIDs: []string{"g2e1"},
		Commit:           SyncCommit{Part: &PartCommit{WirePartID: "wp", EventID: "g2e1", Revision: 2, SemanticHash: "s2"}},
	}
	out1 := recordBatchAt(t, cs, "w1", 1_000_000, gen1)
	out2 := recordBatchAt(t, cs, "w1", 1_000_100, gen2)
	if out1.Records[0].Key == out2.Records[0].Key {
		t.Fatal("two mutation generations must have distinct pending keys")
	}
	cf := mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 2 {
		t.Fatalf("second generation overwrote the first: %d pending", got)
	}
	// ACK the second generation first: both remain (prefix blocked).
	if _, err := cs.AcknowledgeEventIDs([]string{"g2e1"}); err != nil {
		t.Fatal(err)
	}
	cf = mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 2 {
		t.Fatalf("out-of-order generation ack advanced prefix: %d pending", got)
	}
	// First generation ack → both commit in order.
	if _, err := cs.AcknowledgeEventIDs([]string{"g1e1"}); err != nil {
		t.Fatal(err)
	}
	cf = mustSnapshot(t, cs)
	if got := len(cf.Sessions["w1"].Pending); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
	part := cf.Sessions["w1"].Sync.Parts["wp"]
	if part.Revision != 2 || part.EventID != "g2e1" || part.SemanticHash != "s2" {
		t.Fatalf("part checkpoint = %+v, want revision 2 / g2e1 / s2", part)
	}
	if got := cf.Sessions["w1"].AckPartMutationTime; got != 500 {
		t.Fatalf("part mutation high-water = %d, want 500", got)
	}
}

func TestCursorStore_HighWaterNeverRegresses(t *testing.T) {
	cs := newCursorStore(t)
	// Craft a v2 cursor whose pending orders contradict the numeric mutation
	// times: order 1 carries time 200, order 2 carries time 100. Advancing in
	// order must keep the high-water at 200, not move it backward.
	crafted := CursorFile{
		Version: CursorVersion,
		Sessions: map[string]SessionCursor{
			"w1": {
				StateRevision:   5,
				NextOrder:       map[PositionKind]uint64{PositionPartMutation: 3},
				NextCommitOrder: 3,
				Pending: map[string]PendingPosition{
					"pa": {Position: SourcePosition{Kind: PositionPartMutation, Order: 1, MutationTime: 200, NativeIDHash: "h200"}, ExpectedEventIDs: []string{"ea"}},
					"pb": {Position: SourcePosition{Kind: PositionPartMutation, Order: 2, MutationTime: 100, NativeIDHash: "h100"}, ExpectedEventIDs: []string{"eb"}},
				},
			},
		},
	}
	data, err := json.Marshal(crafted)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cs.Path(), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.AcknowledgeEventIDs([]string{"ea", "eb"}); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	if got := cf.Sessions["w1"].AckPartMutationTime; got != 200 {
		t.Fatalf("mutation high-water regressed to %d, want 200", got)
	}
	if got := len(cf.Sessions["w1"].Pending); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
}

func TestCursorStore_TouchLastScanIsThrottled(t *testing.T) {
	cs := newCursorStore(t)
	n := countPersists(cs)
	base := int64(1_700_000_000_000)
	if err := cs.TouchLastScan(base); err != nil {
		t.Fatal(err)
	}
	if got := n.Load(); got != 1 {
		t.Fatalf("first touch persisted %d times, want 1", got)
	}
	if err := cs.TouchLastScan(base + 1000); err != nil {
		t.Fatal(err)
	}
	if err := cs.TouchLastScan(base + 30_000); err != nil {
		t.Fatal(err)
	}
	if got := n.Load(); got != 1 {
		t.Fatalf("throttled touches persisted %d times, want 1", got)
	}
	if err := cs.TouchLastScan(base + 61_000); err != nil {
		t.Fatal(err)
	}
	if got := n.Load(); got != 2 {
		t.Fatalf("due touch persisted %d times, want 2", got)
	}
	cf := mustSnapshot(t, cs)
	if cf.LastScanUnixMs != base+61_000 {
		t.Fatalf("LastScanUnixMs = %d, want %d", cf.LastScanUnixMs, base+61_000)
	}
}

func writeV1Cursor(t *testing.T, path string) []byte {
	t.Helper()
	v1 := map[string]any{
		"version":            1,
		"storage_path_hash":  "sph-1",
		"source_id":          "src-1",
		"schema_fingerprint": "fp-1",
		"last_scan_unix_ms":  123,
		"sessions": map[string]any{
			"w1": map[string]any{
				"ack_message_sequence": 9,
				"pending": map[string]any{
					"pos1": map[string]any{"expected_event_ids": []string{"e1"}},
				},
			},
		},
	}
	data, err := json.Marshal(v1)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestCursorStore_V1MigrationBacksUpAndResetsSessions(t *testing.T) {
	cs := newCursorStore(t)
	original := writeV1Cursor(t, cs.Path())
	cf := mustSnapshot(t, cs)
	if len(cf.Sessions) != 0 {
		t.Fatalf("v1 migration must reset sessions: %+v", cf.Sessions)
	}
	// The active file is now v2.
	data, err := os.ReadFile(cs.Path())
	if err != nil {
		t.Fatal(err)
	}
	var onDisk map[string]any
	if err := json.Unmarshal(data, &onDisk); err != nil {
		t.Fatal(err)
	}
	if v, _ := onDisk["version"].(float64); v != float64(CursorVersion) {
		t.Fatalf("active cursor version = %v, want %d", onDisk["version"], CursorVersion)
	}
	// A 0600 backup preserves the original v1 bytes.
	entries, err := os.ReadDir(filepath.Dir(cs.Path()))
	if err != nil {
		t.Fatal(err)
	}
	backups := 0
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), filepath.Base(cs.Path())+".v1-backup-") {
			continue
		}
		backups++
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("backup perm = %o, want 0600", perm)
		}
		got, err := os.ReadFile(filepath.Join(filepath.Dir(cs.Path()), e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(original) {
			t.Fatal("backup must preserve the original v1 bytes")
		}
	}
	if backups != 1 {
		t.Fatalf("backups = %d, want 1", backups)
	}
}

func TestCursorStore_V1MigrationPreservesIdentity(t *testing.T) {
	cs := newCursorStore(t)
	writeV1Cursor(t, cs.Path())
	cf := mustSnapshot(t, cs)
	if cf.StoragePathHash != "sph-1" || cf.SourceID != "src-1" || cf.SchemaFingerprint != "fp-1" {
		t.Fatalf("v1 migration lost identity: %+v", cf)
	}
	// A second store over the same path sees v2 and does not re-migrate.
	cs2 := NewCursorStoreAt(cs.Path())
	cf2 := mustSnapshot(t, cs2)
	if cf2.SourceID != "src-1" {
		t.Fatalf("second load lost identity: %+v", cf2)
	}
	entries, _ := os.ReadDir(filepath.Dir(cs.Path()))
	backups := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), filepath.Base(cs.Path())+".v1-backup-") {
			backups++
		}
	}
	if backups != 1 {
		t.Fatalf("backups = %d, want 1 (no re-migration)", backups)
	}
}

func TestCursorStore_FutureVersionIsRejectedWithoutOverwrite(t *testing.T) {
	cs := newCursorStore(t)
	future := []byte(`{"version":3,"source_id":"src","sessions":{}}`)
	if err := os.WriteFile(cs.Path(), future, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.Snapshot(); !errors.Is(err, ErrCursorFutureVersion) {
		t.Fatalf("error = %v, want ErrCursorFutureVersion", err)
	}
	got, err := os.ReadFile(cs.Path())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(future) {
		t.Fatal("future-version cursor must not be overwritten")
	}
}

func TestCursorStore_InterruptedAtomicWriteKeepsLastGoodCursor(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
	})
	good, err := os.ReadFile(cs.Path())
	if err != nil {
		t.Fatal(err)
	}
	cs.persist = func(cf CursorFile) error {
		// Simulate a crash mid-write: a leftover temp file exists but the
		// rename never happens.
		tmp, err := os.CreateTemp(filepath.Dir(cs.Path()), ".zcode-cursor.*.tmp")
		if err != nil {
			return err
		}
		_, _ = tmp.Write([]byte("{partial"))
		_ = tmp.Close()
		return errors.New("interrupted")
	}
	snap := mustSnapshot(t, cs)
	if _, err := cs.RecordPendingBatch(PendingBatchRequest{
		WireSessionID:         "w1",
		ExpectedStateRevision: snap.Sessions["w1"].StateRevision,
		Records: []PendingRecord{{
			WireSessionID: "w1", Position: SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2},
			ExpectedEventIDs: []string{"e2"},
			PayloadDurable:   true,
		}},
	}, 1_000_100); err == nil {
		t.Fatal("interrupted write must error")
	}
	got, err := os.ReadFile(cs.Path())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(good) {
		t.Fatal("interrupted atomic write must keep the last good cursor")
	}
	// A fresh store still loads the last good state.
	cs2 := NewCursorStoreAt(cs.Path())
	cf := mustSnapshot(t, cs2)
	if got := len(cf.Sessions["w1"].Pending); got != 1 {
		t.Fatalf("recovered pending = %d, want 1", got)
	}
}

func TestCursorStore_JSONContainsNoSourceContentOrRawNativeID(t *testing.T) {
	cs := newCursorStore(t)
	nativePartID := "NATIVE-PART-9f2c"
	hashed := hashID(nativePartID)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionPartInsert, PartMessageSeq: 1, PartSequence: 2, NativeIDHash: hashed},
		ExpectedEventIDs: []string{"e1"},
		Commit:           SyncCommit{Part: &PartCommit{WirePartID: "wp-1", EventID: "e1", Revision: 1, SemanticHash: "sh"}},
	})
	data, err := os.ReadFile(cs.Path())
	if err != nil {
		t.Fatal(err)
	}
	blob := string(data)
	if strings.Contains(blob, nativePartID) {
		t.Fatal("cursor JSON contains the raw native id")
	}
	if !strings.Contains(blob, hashed) {
		t.Fatal("cursor JSON should contain the hashed native id")
	}
	for _, bad := range []string{"\"text\"", "\"prompt\"", "\"title\":", "\"cwd\"", "\"output\"", "\"input\""} {
		if strings.Contains(blob, bad) {
			t.Fatalf("cursor stored content marker %q:\n%s", bad, blob)
		}
	}
}

// --- recovery hardening: copy-on-write isolation ------------------------------

func TestCursorStore_SnapshotMessagesMapIsDeepCopy(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
		Commit:           SyncCommit{Message: &MessageCommit{WireMessageID: "wm1", EventID: "e1", SemanticHash: "s1"}},
	})
	// Advance the prefix so the message commit lands in the durable Sync
	// checkpoint (pending commits only reach Sync.Messages at advancement).
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err != nil {
		t.Fatal(err)
	}
	snap := mustSnapshot(t, cs)
	if len(snap.Sessions["w1"].Sync.Messages) != 1 {
		t.Fatalf("message checkpoint missing after ack: %+v", snap.Sessions["w1"].Sync)
	}
	// Mutating the snapshot's Sync.Messages must not touch the store.
	mc := snap.Sessions["w1"].Sync.Messages["wm1"]
	mc.EventID = "MUTATED"
	snap.Sessions["w1"].Sync.Messages["wm1"] = mc
	delete(snap.Sessions["w1"].Sync.Messages, "wm1")
	after := mustSnapshot(t, cs)
	if got := after.Sessions["w1"].Sync.Messages["wm1"].EventID; got != "e1" {
		t.Fatalf("Snapshot().Sync.Messages leaked into authoritative state: %q", got)
	}
}

func TestCursorStore_SnapshotPendingCommitMessageIsDeepCopy(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
		Commit:           SyncCommit{Message: &MessageCommit{WireMessageID: "wm1", EventID: "e1", SemanticHash: "s1"}},
	})
	snap := mustSnapshot(t, cs)
	for key, pp := range snap.Sessions["w1"].Pending {
		pp.Commit.Message.EventID = "MUTATED"
		pp.Commit.Message.SemanticHash = "MUTATED"
		snap.Sessions["w1"].Pending[key] = pp
	}
	after := mustSnapshot(t, cs)
	for _, pp := range after.Sessions["w1"].Pending {
		if pp.Commit.Message == nil {
			t.Fatal("message commit lost")
		}
		if pp.Commit.Message.EventID == "MUTATED" || pp.Commit.Message.SemanticHash == "MUTATED" {
			t.Fatalf("Snapshot().Pending[*].Commit.Message leaked into authoritative state: %+v", pp.Commit.Message)
		}
	}
}

func TestCursorStore_FailedMessageAckLeavesCheckpointUnchanged(t *testing.T) {
	cs := newCursorStore(t)
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e1"},
		Commit:           SyncCommit{Message: &MessageCommit{WireMessageID: "wm1", EventID: "e1", SemanticHash: "s1"}},
	})
	if _, err := cs.AcknowledgeEventIDs([]string{"e1"}); err != nil {
		t.Fatal(err)
	}
	good := mustSnapshot(t, cs)
	if good.Sessions["w1"].Sync.Messages["wm1"].EventID != "e1" {
		t.Fatalf("checkpoint not applied: %+v", good.Sessions["w1"].Sync.Messages)
	}
	// A second (mutating) ACK whose persistence fails must leave memory AND
	// disk unchanged relative to the state immediately before that ACK.
	recordBatchAt(t, cs, "w1", 1_000_100, PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 2},
		ExpectedEventIDs: []string{"e2"},
		Commit:           SyncCommit{Message: &MessageCommit{WireMessageID: "wm1", EventID: "e2", SemanticHash: "s2"}},
	})
	goodBytes, _ := os.ReadFile(cs.Path())
	cs.persist = func(cf CursorFile) error { return errors.New("disk full") }
	if _, err := cs.AcknowledgeEventIDs([]string{"e2"}); err == nil {
		t.Fatal("failed ACK persistence must error")
	}
	cs.persist = nil
	after := mustSnapshot(t, cs)
	if got := after.Sessions["w1"].Sync.Messages["wm1"].EventID; got != "e1" {
		t.Fatalf("failed persistence mutated memory checkpoint: %q, want e1", got)
	}
	afterBytes, err := os.ReadFile(cs.Path())
	if err != nil {
		t.Fatal(err)
	}
	if string(afterBytes) != string(goodBytes) {
		t.Fatal("failed persistence mutated the on-disk checkpoint")
	}
}

// --- recovery hardening: monotonic message checkpoints ------------------------

func TestCursorStore_MessageMutationAckBeforeInsertKeepsNewerCheckpoint(t *testing.T) {
	cs := newCursorStore(t)
	// Insert stream entry first (lower commit order), mutation second.
	recordBatchAt(t, cs, "w1", 1_000_000, PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"e-ins"},
		Commit:           SyncCommit{Message: &MessageCommit{WireMessageID: "wm1", EventID: "e-ins", SemanticHash: "s1"}},
	})
	recordBatchAt(t, cs, "w1", 1_000_100, PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionMessageMutation, MutationTime: 500, NativeIDHash: "mh"},
		ExpectedEventIDs: []string{"e-mut"},
		Commit:           SyncCommit{Message: &MessageCommit{WireMessageID: "wm1", EventID: "e-mut", SemanticHash: "s2"}},
	})
	// The mutation stream ACKs first: its checkpoint applies.
	if _, err := cs.AcknowledgeEventIDs([]string{"e-mut"}); err != nil {
		t.Fatal(err)
	}
	// The older insert ACK completes afterwards: its lower commit order must
	// NOT overwrite the newer mutation checkpoint.
	if _, err := cs.AcknowledgeEventIDs([]string{"e-ins"}); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	cp := cf.Sessions["w1"].Sync.Messages["wm1"]
	if cp.EventID != "e-mut" || cp.SemanticHash != "s2" {
		t.Fatalf("older insert ACK overwrote the newer mutation checkpoint: %+v", cp)
	}
	if cf.Sessions["w1"].Sync.Messages["wm1"].CommitOrder == 0 {
		t.Fatal("message checkpoint must persist its commit order")
	}
}

func TestCursorStore_EqualOrderMessageConflictFailsClosed(t *testing.T) {
	cs := newCursorStore(t)
	// Craft a durable state with a message checkpoint at commit order 1.
	crafted := CursorFile{
		Version: CursorVersion,
		Sessions: map[string]SessionCursor{
			"w1": {
				StateRevision:   5,
				NextCommitOrder: 3,
				Sync: SyncCheckpoint{
					LastCommitOrder: 1,
					Messages:        map[string]MessageCheckpoint{"wm1": {EventID: "e1", SemanticHash: "s1", CommitOrder: 1}},
				},
				Pending: map[string]PendingPosition{
					"pa": {
						Position:         SourcePosition{Kind: PositionMessageMutation, Order: 1, MutationTime: 900, NativeIDHash: "mh"},
						ExpectedEventIDs: []string{"e2"},
						// Same commit order as the stored checkpoint but a
						// different identity: a corruption conflict.
						Commit: SyncCommit{
							CommitOrder: 1,
							Message:     &MessageCommit{WireMessageID: "wm1", EventID: "e2", SemanticHash: "s2"},
						},
					},
				},
			},
		},
	}
	data, err := json.Marshal(crafted)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cs.Path(), data, 0o600); err != nil {
		t.Fatal(err)
	}
	before := mustSnapshot(t, cs)
	beforeBytes, _ := os.ReadFile(cs.Path())
	_, err = cs.AcknowledgeEventIDs([]string{"e2"})
	if !errors.Is(err, ErrCursorMessageConflict) {
		t.Fatalf("error = %v, want ErrCursorMessageConflict", err)
	}
	if got := before.Sessions["w1"].Sync.Messages["wm1"].EventID; got != "e1" {
		t.Fatalf("crafted baseline wrong: %q", got)
	}
	after := mustSnapshot(t, cs)
	if got := after.Sessions["w1"].Sync.Messages["wm1"].EventID; got != "e1" {
		t.Fatalf("conflicting commit partially published: %q", got)
	}
	if got := len(after.Sessions["w1"].Pending); got != 1 {
		t.Fatalf("conflicting commit advanced pending: %d", got)
	}
	afterBytes, _ := os.ReadFile(cs.Path())
	if string(afterBytes) != string(beforeBytes) {
		t.Fatal("conflicting commit mutated the on-disk checkpoint")
	}
}

func TestCursorStore_LegacyZeroOrderMessageCheckpointSuperseded(t *testing.T) {
	cs := newCursorStore(t)
	// A legacy v2 checkpoint without commit order stays readable and is
	// superseded by the next non-zero message commit.
	crafted := CursorFile{
		Version: CursorVersion,
		Sessions: map[string]SessionCursor{
			"w1": {
				StateRevision:   5,
				NextCommitOrder: 2,
				Sync: SyncCheckpoint{
					LastCommitOrder: 1,
					Messages:        map[string]MessageCheckpoint{"wm1": {EventID: "e-old", SemanticHash: "s-old"}},
				},
				Pending: map[string]PendingPosition{
					"pa": {
						Position:         SourcePosition{Kind: PositionMessageMutation, Order: 1, MutationTime: 900, NativeIDHash: "mh"},
						ExpectedEventIDs: []string{"e2"},
						Commit: SyncCommit{
							CommitOrder: 2,
							Message:     &MessageCommit{WireMessageID: "wm1", EventID: "e2", SemanticHash: "s2"},
						},
					},
				},
			},
		},
	}
	data, err := json.Marshal(crafted)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cs.Path(), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.AcknowledgeEventIDs([]string{"e2"}); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	cp := cf.Sessions["w1"].Sync.Messages["wm1"]
	if cp.EventID != "e2" || cp.CommitOrder != 2 {
		t.Fatalf("non-zero commit must supersede the legacy zero-order checkpoint: %+v", cp)
	}
}
