package zcode

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// fixtureFingerprint returns the real schema fingerprint of a test fixture.
func fixtureFingerprint(t *testing.T, storage string) string {
	t.Helper()
	store, err := Open(storage)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	return store.Fingerprint()
}

// newTestJournal builds an opened journal in the test storage dir.
func newTestJournal(t *testing.T, storage string) *PreparedEventJournal {
	t.Helper()
	j := NewPreparedEventJournalAt(storage + "/prepared-events.jsonl")
	if err := j.Open(); err != nil {
		t.Fatalf("open prepared journal: %v", err)
	}
	t.Cleanup(func() { _ = j.Close() })
	return j
}

func userMsgJSON(text string) string {
	return `{"role":"user","parts":[{"type":"text","text":"` + text + `"}]}`
}

func textPartJSON(text string) string {
	return `{"type":"text","text":"` + text + `"}`
}

// testObserver builds an observer with an opened store but WITHOUT starting
// the poll loop, so tests can drive pollOnce deterministically.
func testObserver(t *testing.T, storage string, cs *CursorStore, emit EmitFunc) *Observer {
	t.Helper()
	o := NewObserver(ObserverConfig{
		SourceID:     testSourceID,
		StorageDir:   storage,
		History:      HistoryAll,
		LookbackDays: 30,
		OpenStore:    func() (*Store, error) { return Open(storage) },
		CursorStore:  cs,
		Emit:         emit,
	})
	store, err := Open(storage)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	if err := store.Probe(context.Background()); err != nil {
		t.Fatalf("probe store: %v", err)
	}
	journal := NewPreparedEventJournalAt(storage + "/prepared-events.jsonl")
	if err := journal.Open(); err != nil {
		t.Fatalf("open prepared journal: %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
		_ = journal.Close()
	})
	o.store = store
	o.journal = journal
	o.reconcileRecovery()
	o.enabled = true // mirror Start(): testObserver drives pollOnce directly
	return o
}

type emitRecorder struct {
	mu     sync.Mutex
	events []protocol.DaemonEvent
	accept atomic.Int32 // -1 = accept all; otherwise accept first N
}

func newEmitRecorder() *emitRecorder {
	e := &emitRecorder{}
	e.accept.Store(-1)
	return e
}

func (e *emitRecorder) fn() EmitFunc {
	return func(ev protocol.DaemonEvent) bool {
		n := e.accept.Load()
		if n >= 0 && int32(len(e.snapshot())) >= n {
			return false
		}
		e.mu.Lock()
		e.events = append(e.events, ev)
		e.mu.Unlock()
		return true
	}
}

func (e *emitRecorder) snapshot() []protocol.DaemonEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]protocol.DaemonEvent(nil), e.events...)
}

func (e *emitRecorder) ids() []string {
	evs := e.snapshot()
	ids := make([]string, 0, len(evs))
	for _, ev := range evs {
		ids = append(ids, ev.EventID)
	}
	return ids
}

func (e *emitRecorder) countType(typ string) int {
	n := 0
	for _, ev := range e.snapshot() {
		if ev.Type == typ {
			n++
		}
	}
	return n
}

// seedIdentityAndScan pre-establishes cursor identity (with the real schema
// fingerprint) and a fresh scan stamp so a subsequent poll's persist count is
// purely page-driven.
func seedIdentityAndScan(t *testing.T, cs *CursorStore, storage string) {
	t.Helper()
	store, err := Open(storage)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	if err := store.Probe(context.Background()); err != nil {
		t.Fatalf("probe store: %v", err)
	}
	if err := cs.UpdateIdentity(CursorIdentity{
		StoragePathHash:   StoragePathHash(storage),
		SourceID:          testSourceID,
		SchemaFingerprint: store.Fingerprint(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := cs.TouchLastScan(time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

func seedSessionWithMessages(t *testing.T, n int) string {
	t.Helper()
	return testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "title", "/cwd", now, now, 0)
		for i := 1; i <= n; i++ {
			insertMessage(ctx, db, fmt.Sprintf("m%d", i), "ses1", i, now, now, userMsgJSON(fmt.Sprintf("hello %d", i)))
		}
	}))
}

func TestObserver_DisabledConfigDoesNotOpenStore(t *testing.T) {
	storage := testdb(t)
	opened := atomic.Bool{}
	o := NewObserver(ObserverConfig{
		SourceID:   testSourceID,
		StorageDir: storage,
		OpenStore: func() (*Store, error) {
			opened.Store(true)
			return Open(storage)
		},
		Emit: func(protocol.DaemonEvent) bool { return true },
	})
	// Never call Start → store never opened.
	if opened.Load() {
		t.Fatal("disabled config must not open store")
	}
	_ = o
}

func TestObserver_StartFailsClosedOnBadStore(t *testing.T) {
	o := NewObserver(ObserverConfig{
		SourceID:   testSourceID,
		StorageDir: "/no/such/storage",
		OpenStore:  func() (*Store, error) { return Open("/no/such/storage") },
		Emit:       func(protocol.DaemonEvent) bool { return true },
	})
	if err := o.Start(context.Background()); err == nil {
		t.Fatal("Start against missing storage must fail (fail-closed)")
	}
}

func TestObserver_EmitsSessionDiscoveredWithZcodeFields(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "title", "/cwd", now, now, 0)
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	journal := newTestJournal(t, storage)
	var mu sync.Mutex
	var got []protocol.DaemonEvent
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		History: HistoryAll, LookbackDays: 30,
		OpenStore:            func() (*Store, error) { return Open(storage) },
		CursorStore:          cs,
		PreparedEventJournal: journal,
		ActivePoll:           10 * time.Millisecond,
		Emit: func(ev protocol.DaemonEvent) bool {
			mu.Lock()
			got = append(got, ev)
			mu.Unlock()
			return true
		},
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer o.Stop()
	waitFor(t, time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, e := range got {
			if e.Type == "session_discovered" {
				if e.Agent != "zcode" || e.Source != "observer" || e.ControlMode != "legacy_read_only" {
					t.Fatalf("discovered fields wrong: %+v", e)
				}
				if len(e.Capabilities) != 1 || e.Capabilities[0] != "history_sync" {
					t.Fatalf("capabilities wrong: %v", e.Capabilities)
				}
				return true
			}
		}
		return false
	})
}

func TestObserver_LowWaterMarkYieldsAndKeepsPending(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	journal := newTestJournal(t, storage)
	var count atomic.Int32
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		History: HistoryAll, LookbackDays: 30,
		OpenStore:            func() (*Store, error) { return Open(storage) },
		CursorStore:          cs,
		PreparedEventJournal: journal,
		ActivePoll:           10 * time.Millisecond,
		Emit: func(ev protocol.DaemonEvent) bool {
			if count.Add(1) > 1 {
				return false // reject further
			}
			return true
		},
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer o.Stop()
	// Give it a few ticks; it must stay alive and not block, keeping durable
	// pending positions for the unemitted events.
	time.Sleep(80 * time.Millisecond)
	cf := mustSnapshot(t, cs)
	totalPending := 0
	for _, s := range cf.Sessions {
		totalPending += len(s.Pending)
	}
	if totalPending == 0 {
		t.Fatal("backpressured observer must keep durable pending positions")
	}
}

func TestObserver_DisableStopsEmissionWithinDeadline(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	journal := newTestJournal(t, storage)
	var count atomic.Int32
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		History: HistoryAll, LookbackDays: 30,
		OpenStore:            func() (*Store, error) { return Open(storage) },
		CursorStore:          cs,
		PreparedEventJournal: journal,
		ActivePoll:           10 * time.Millisecond,
		DisablePoll:          50 * time.Millisecond,
		Emit: func(ev protocol.DaemonEvent) bool {
			count.Add(1)
			return true
		},
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	before := count.Load()
	o.Disable()
	// After Disable + a few poll intervals, no new emissions beyond the one
	// in-flight poll (unacked events re-emit at-least-once, so a completing
	// poll can contribute up to its full page: discovered + status + 5 texts).
	time.Sleep(120 * time.Millisecond)
	after := count.Load()
	if after > before+7 {
		t.Fatalf("disable did not stop emission: before=%d after=%d", before, after)
	}
	o.Stop()
}

func TestObserver_StopNoGoroutineLeak(t *testing.T) {
	storage := testdb(t)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	journal := newTestJournal(t, storage)
	o := NewObserver(ObserverConfig{
		SourceID:             testSourceID,
		StorageDir:           storage,
		OpenStore:            func() (*Store, error) { return Open(storage) },
		CursorStore:          cs,
		PreparedEventJournal: journal,
		ActivePoll:           10 * time.Millisecond,
		Emit:                 func(protocol.DaemonEvent) bool { return true },
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	o.Stop()
	select {
	case <-o.done:
	case <-time.After(time.Second):
		t.Fatal("Stop did not close done channel (goroutine leak)")
	}
}

func TestObserver_AcknowledgeEventIDsAdvancesCursor(t *testing.T) {
	storage := testdb(t)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	recordBatchAt(t, cs, "w1", time.Now().UnixMilli(), PendingRecord{
		WireSessionID:    "w1",
		Position:         SourcePosition{Kind: PositionMetadata, NativeIDHash: hashID("w1")},
		ExpectedEventIDs: []string{"e1"},
	})
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		CursorStore: cs,
		Emit:        func(protocol.DaemonEvent) bool { return true },
	})
	o.AcknowledgeEventIDs([]string{"e1"})
	cf := mustSnapshot(t, cs)
	if len(cf.Sessions["w1"].Pending) != 0 {
		t.Fatalf("ACK should clear pending: %+v", cf.Sessions["w1"])
	}
}

func TestObserver_QueueResyncDoesNotBurstAllContent(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		for i := 0; i < 3; i++ {
			insertSession(ctx, db, fmt.Sprintf("ses%d", i), "t", "/c", now, now, 0)
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	seedIdentityAndScan(t, cs, storage)
	for i := 0; i < 3; i++ {
		w := WireSessionID(testSourceID, fmt.Sprintf("ses%d", i))
		recordBatchAt(t, cs, w, time.Now().UnixMilli(), PendingRecord{
			WireSessionID: w,
			Position:      SourcePosition{Kind: PositionMetadata, NativeIDHash: hashID(w)},
			SkippedReason: "seed_resync_session",
		})
	}
	var mu sync.Mutex
	var resyncCount int
	journal := newTestJournal(t, storage)
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		OpenStore:            func() (*Store, error) { return Open(storage) },
		CursorStore:          cs,
		PreparedEventJournal: journal,
		ActivePoll:           200 * time.Millisecond, // slow so resync dominates
		Emit: func(ev protocol.DaemonEvent) bool {
			if ev.Resync {
				mu.Lock()
				resyncCount++
				mu.Unlock()
			}
			return true
		},
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer o.Stop()
	o.QueueResync()
	waitFor(t, time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return resyncCount >= 3
	})
}

// --- paged scan tests --------------------------------------------------------

func TestObserver_PagePendingPersistsOnceBeforeFirstEmit(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	seedIdentityAndScan(t, cs, storage)
	n := countPersists(cs)
	pendingAtFirstEmit := -1
	var firstEmitDone atomic.Bool
	rec := newEmitRecorder()
	rec.fn() // build closure
	emit := func(ev protocol.DaemonEvent) bool {
		if !firstEmitDone.Load() {
			cf := mustSnapshot(t, cs)
			pending := 0
			for _, s := range cf.Sessions {
				pending += len(s.Pending)
			}
			pendingAtFirstEmit = pending
			firstEmitDone.Store(true)
		}
		return rec.fn()(ev)
	}
	o := testObserver(t, storage, cs, emit)
	res := o.pollOnce(context.Background())
	if res.Emitted != 8 { // session_discovered + turn_status(running) + 5 user_text + session_status
		t.Fatalf("emitted = %d, want 8: %v", res.Emitted, rec.ids())
	}
	if pendingAtFirstEmit < 1 {
		t.Fatalf("pending must be durable BEFORE the first emit, got %d", pendingAtFirstEmit)
	}
	// One persist each for the metadata, message and status pages — bounded by
	// pages, not by the 5 source rows.
	if got := n.Load(); got != 3 {
		t.Fatalf("persist calls = %d, want 3 (page-bounded)", got)
	}
}

func TestObserver_PagePersistFailureEmitsNothing(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	seedIdentityAndScan(t, cs, storage)
	var successes atomic.Int32
	cs.persist = func(cf CursorFile) error {
		if successes.Add(1) > 1 {
			return fmt.Errorf("disk full")
		}
		return cs.writeCursor(cf)
	}
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	res := o.pollOnce(context.Background())
	// The metadata page persists and emits; the message page persist fails so
	// none of its events are emitted.
	if got := rec.countType("user_text"); got != 0 {
		t.Fatalf("failed page emitted %d user_text events, want 0", got)
	}
	if got := rec.countType("session_discovered"); got != 1 {
		t.Fatalf("discovered = %d, want 1", got)
	}
	if !res.Deferred {
		t.Fatal("persist failure must defer the stream")
	}
	// The failed pages must leave no durable pending state at all: only the
	// successful metadata page is recorded.
	cf := mustSnapshot(t, cs)
	for _, s := range cf.Sessions {
		for key, pp := range s.Pending {
			if pp.Position.Kind != PositionMetadata {
				t.Fatalf("failed page leaked durable pending: key %s entry %+v", key, pp)
			}
		}
	}
	// Recover the disk and retry: the messages must now flow.
	cs.persist = nil
	res = o.pollOnce(context.Background())
	if got := rec.countType("user_text"); got != 5 {
		t.Fatalf("after recovery user_text = %d, want 5 (emitted %v)", got, rec.ids())
	}
	if res.Deferred {
		t.Fatal("recovered poll must not defer")
	}
}

func TestObserver_BackpressureStopsLaterPageEvents(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	rec.accept.Store(3) // accept discovered + turn_status + first user_text, reject the rest
	o := testObserver(t, storage, cs, rec.fn())
	res := o.pollOnce(context.Background())
	if !res.Deferred {
		t.Fatal("rejected emit must defer")
	}
	ids := rec.ids()
	if len(ids) != 3 {
		t.Fatalf("emitted %d events after backpressure, want 3: %v", len(ids), ids)
	}
	if rec.countType("user_text") != 1 {
		t.Fatalf("user_text emitted = %d, want 1", rec.countType("user_text"))
	}
}

func TestObserver_BackpressureKeepsDurablePending(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	rec.accept.Store(2)
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	cf := mustSnapshot(t, cs)
	wire := WireSessionID(testSourceID, "ses1")
	pendingBefore := len(cf.Sessions[wire].Pending)
	if pendingBefore == 0 {
		t.Fatal("backpressured page must keep durable pending")
	}
	// Retry with an accepting gate: unacked events are re-emitted with the
	// SAME event ids (stable identity, at-least-once).
	rec.accept.Store(-1)
	before := len(rec.snapshot())
	res := o.pollOnce(context.Background())
	if res.Deferred {
		t.Fatal("retry with capacity must not defer")
	}
	secondRound := rec.snapshot()[before:]
	seen := map[string]bool{}
	for _, ev := range secondRound {
		if ev.Type != "user_text" {
			continue
		}
		if seen[ev.EventID] {
			t.Fatalf("user_text %s re-emitted twice in one retry", ev.EventID)
		}
		seen[ev.EventID] = true
	}
	if len(seen) != 5 {
		ids := make([]string, 0, len(secondRound))
		for _, ev := range secondRound {
			ids = append(ids, ev.EventID)
		}
		t.Fatalf("re-emitted user_text events = %d, want 5: %v", len(seen), ids)
	}
	// Acknowledge everything: pending clears and the high-water advances.
	var allIDs []string
	for _, s := range mustSnapshot(t, cs).Sessions {
		for _, pp := range s.Pending {
			allIDs = append(allIDs, pp.ExpectedEventIDs...)
		}
	}
	if _, err := cs.AcknowledgeEventIDs(allIDs); err != nil {
		t.Fatal(err)
	}
	res = o.pollOnce(context.Background())
	if res.Emitted != 0 || res.NewPending != 0 {
		t.Fatalf("converged poll emitted %d/newPending %d, want 0/0", res.Emitted, res.NewPending)
	}
	cf = mustSnapshot(t, cs)
	if got := cf.Sessions[wire].AckMessageSequence; got != 5 {
		t.Fatalf("AckMessageSequence = %d, want 5", got)
	}
}

func TestObserver_SkippedInvalidRowAdvancesAfterDurableSkip(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "t", "/c", now, now, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, now, now, userMsgJSON("one"))
		insertMessage(ctx, db, "m2", "ses1", 2, now, now, `{"role":"assistant","synthetic":true}`)
		insertMessage(ctx, db, "m3", "ses1", 3, now, now, userMsgJSON("three"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	res := o.pollOnce(context.Background())
	if got := rec.countType("user_text"); got != 2 {
		t.Fatalf("user_text = %d, want 2 (synthetic row skipped)", got)
	}
	wire := WireSessionID(testSourceID, "ses1")
	cf := mustSnapshot(t, cs)
	skips := 0
	for _, pp := range cf.Sessions[wire].Pending {
		if pp.SkippedReason != "" {
			skips++
		}
	}
	if skips != 1 {
		t.Fatalf("durable skip records = %d, want 1", skips)
	}
	// Acknowledge the emitted events: the skipped row closes with the
	// contiguous prefix and the high-water passes it.
	var ids []string
	for _, ev := range rec.snapshot() {
		ids = append(ids, ev.EventID)
	}
	if _, err := cs.AcknowledgeEventIDs(ids); err != nil {
		t.Fatal(err)
	}
	cf = mustSnapshot(t, cs)
	if got := cf.Sessions[wire].AckMessageSequence; got != 3 {
		t.Fatalf("AckMessageSequence = %d, want 3 (skip advances with prefix)", got)
	}
	// A pure-skip page advances immediately after durable skip recording,
	// without waiting for any ACK.
	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer wdb.Close()
	ctx := context.Background()
	insertMessage(ctx, wdb, "m4", "ses1", 4, nowMillis(), nowMillis(), `{"role":"assistant","synthetic":true}`)
	res = o.pollOnce(context.Background())
	if res.Emitted != 0 {
		t.Fatalf("skip-only poll emitted %d events, want 0", res.Emitted)
	}
	cf = mustSnapshot(t, cs)
	if got := cf.Sessions[wire].AckMessageSequence; got != 4 {
		t.Fatalf("AckMessageSequence after pure-skip page = %d, want 4 (advanced at record time)", got)
	}
}

func TestObserver_AckedSubagentDiscoveryConverges(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "parent", "parent", "/c", 1, 1, 0)
		insertSession(ctx, db, "child", "child", "/c", 2, 2, 0)
		if _, err := db.ExecContext(ctx, "UPDATE session SET parent_id = ?, task_type = ? WHERE id = ?", "parent", "subagent_child", "child"); err != nil {
			t.Fatalf("mark child session: %v", err)
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())

	o.pollOnce(context.Background())
	if got := rec.countType("subagent_discovered"); got != 1 {
		t.Fatalf("initial subagent_discovered = %d, want 1", got)
	}
	o.pollOnce(context.Background())
	if got := rec.countType("subagent_discovered"); got != 2 {
		t.Fatalf("unACKed subagent discovery should retry once per poll, got total %d", got)
	}
	o.AcknowledgeEventIDs(rec.ids())
	before := rec.countType("subagent_discovered")
	second := o.pollOnce(context.Background())
	if got := rec.countType("subagent_discovered"); got != before {
		t.Fatalf("ACKed subagent discovery re-emitted: before=%d after=%d", before, got)
	}
	if second.HasActiveWork() {
		t.Fatalf("ACKed subagent session did not converge: %+v", second)
	}
}

func TestObserver_AckedInsertDoesNotRescanFromZero(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	var ids []string
	for _, ev := range rec.snapshot() {
		ids = append(ids, ev.EventID)
	}
	if _, err := cs.AcknowledgeEventIDs(ids); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	wire := WireSessionID(testSourceID, "ses1")
	if got := cf.Sessions[wire].AckMessageSequence; got != 5 {
		t.Fatalf("AckMessageSequence = %d, want 5", got)
	}
	// Append one new message: exactly its event may be emitted. Rescanning
	// from zero would duplicate all five user_text events.
	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer wdb.Close()
	insertMessage(context.Background(), wdb, "m6", "ses1", 6, nowMillis(), nowMillis(), userMsgJSON("six"))
	before := rec.countType("user_text")
	res := o.pollOnce(context.Background())
	if got := rec.countType("user_text") - before; got != 1 {
		t.Fatalf("second poll emitted %d new user_text events, want 1 (rescan from zero would duplicate all five)", got)
	}
	if res.Emitted != 1 || res.NewPending != 1 {
		t.Fatalf("second poll emitted %d / newPending %d, want 1/1 (the durable active turn keeps the appended user message as an addendum)", res.Emitted, res.NewPending)
	}
}

func seedSessionWithParts(t *testing.T, parts [][2]string) string {
	t.Helper() // parts: {id, text} all attached to message msg1 at sequence 1
	return testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "t", "/c", now, now, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, now, now, userMsgJSON("q"))
		for _, p := range parts {
			insertPart(ctx, db, p[0], "msg1", "ses1", 1, now, now, textPartJSON(p[1]))
		}
	}))
}

func TestObserver_PartInsertPagesUseInclusiveHashAnchor(t *testing.T) {
	storage := seedSessionWithParts(t, [][2]string{{"pa", "a"}, {"pb", "b"}})
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	wire := WireSessionID(testSourceID, "ses1")
	var ids []string
	for _, ev := range rec.snapshot() {
		ids = append(ids, ev.EventID)
	}
	if _, err := cs.AcknowledgeEventIDs(ids); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	s := cf.Sessions[wire]
	if s.AckPartSequence != 1 || s.AckPartIDHash != hashID("pb") {
		t.Fatalf("anchor = (%d,%s), want (1,%s)", s.AckPartSequence, s.AckPartIDHash, hashID("pb"))
	}
	// Two more parts at the SAME numeric tuple after the anchor row, plus one
	// at the next tuple: all three must be discovered.
	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer wdb.Close()
	ctx := context.Background()
	now := nowMillis()
	insertPart(ctx, wdb, "pc", "msg1", "ses1", 1, now, now, textPartJSON("c"))
	insertPart(ctx, wdb, "pd", "msg1", "ses1", 1, now, now, textPartJSON("d"))
	insertPart(ctx, wdb, "pe", "msg1", "ses1", 2, now, now, textPartJSON("e"))
	before := rec.countType("agent_text")
	res := o.pollOnce(context.Background())
	if got := rec.countType("agent_text") - before; got != 3 {
		t.Fatalf("anchored resume discovered %d new parts, want 3 (emitted %v)", got, rec.ids())
	}
	if res.Deferred {
		t.Fatal("anchored resume must not defer")
	}
}

func TestObserver_MissingPartAnchorReplaysConservatively(t *testing.T) {
	storage := seedSessionWithParts(t, [][2]string{{"pa", "a"}, {"pb", "b"}})
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	var ids []string
	for _, ev := range rec.snapshot() {
		ids = append(ids, ev.EventID)
	}
	if _, err := cs.AcknowledgeEventIDs(ids); err != nil {
		t.Fatal(err)
	}
	// Delete the acknowledged anchor row and add a new part at the same tuple.
	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer wdb.Close()
	ctx := context.Background()
	if _, err := wdb.ExecContext(ctx, "DELETE FROM part WHERE id = 'pb'"); err != nil {
		t.Fatal(err)
	}
	insertPart(ctx, wdb, "pc", "msg1", "ses1", 1, nowMillis(), nowMillis(), textPartJSON("c"))
	before := rec.countType("agent_text")
	res := o.pollOnce(context.Background())
	// pa is re-visited (conservative replay) but NOT re-emitted; pc is new.
	if got := rec.countType("agent_text") - before; got != 1 {
		t.Fatalf("conservative replay emitted %d parts, want 1 (pc only): %v", got, rec.ids())
	}
	if res.Deferred {
		t.Fatal("conservative replay must not defer")
	}
	// Ack pc: the anchor re-establishes to the newest row at the tuple.
	ids = nil
	for _, ev := range rec.snapshot() {
		ids = append(ids, ev.EventID)
	}
	if _, err := cs.AcknowledgeEventIDs(ids); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	if got := cf.Sessions[WireSessionID(testSourceID, "ses1")].AckPartIDHash; got != hashID("pc") {
		t.Fatalf("anchor hash = %s, want hashID(pc)", got)
	}
}

func TestObserver_ACKDuringPollCannotBeOverwritten(t *testing.T) {
	storage := seedSessionWithMessages(t, 3)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	wire := WireSessionID(testSourceID, "ses1")
	var acked atomic.Bool
	var o *Observer
	rec := newEmitRecorder()
	emit := func(ev protocol.DaemonEvent) bool {
		ok := rec.fn()(ev)
		if ok && ev.Type == "session_discovered" && !acked.Load() {
			acked.Store(true)
			// Simulate the relay ACK racing the poll loop: this must NOT be
			// clobbered by a later caller-owned cursor save.
			o.AcknowledgeEventIDs([]string{ev.EventID})
		}
		return ok
	}
	o = testObserver(t, storage, cs, emit)
	res := o.pollOnce(context.Background())
	if !acked.Load() {
		t.Fatal("test did not exercise the ACK race")
	}
	if res.Deferred {
		t.Fatal("ACK during poll must not defer the stream")
	}
	if got := rec.countType("user_text"); got != 3 {
		t.Fatalf("user_text = %d, want 3: %v", got, rec.ids())
	}
	cf := mustSnapshot(t, cs)
	s := cf.Sessions[wire]
	for key, pp := range s.Pending {
		for _, eid := range pp.ExpectedEventIDs {
			if eid == rec.snapshot()[0].EventID {
				t.Fatalf("acked discovered entry survived (caller-owned overwrite): key %s", key)
			}
		}
	}
	if got := len(s.Pending); got != 4 {
		t.Fatalf("pending = %d, want 4 (3 messages + 1 status)", got)
	}
}

func TestObserver_ACKDuringPagePreparationCausesFreshRebuild(t *testing.T) {
	storage := seedSessionWithMessages(t, 3)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	// First poll under backpressure: the metadata and message pages are
	// recorded but only the discovered event is emitted.
	rec := newEmitRecorder()
	rec.accept.Store(1)
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	discoveredID := rec.snapshot()[0].EventID
	wire := WireSessionID(testSourceID, "ses1")
	// Add a new message so the second poll's message page contains a NEW
	// record prepared from the snapshot revision the hook is about to stale.
	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer wdb.Close()
	insertMessage(context.Background(), wdb, "m4", "ses1", 4, nowMillis(), nowMillis(), userMsgJSON("four"))
	// Second poll: acknowledge the discovered event DURING message page
	// preparation. The page was prepared from a stale revision and must be
	// rebuilt from a fresh snapshot.
	var hooked atomic.Bool
	o.testHookPagePrep = func(kind PositionKind) {
		if kind != PositionMessageInsert || !hooked.CompareAndSwap(false, true) {
			return
		}
		if _, err := cs.AcknowledgeEventIDs([]string{discoveredID}); err != nil {
			t.Errorf("hook ack: %v", err)
		}
	}
	rec.accept.Store(-1)
	res := o.pollOnce(context.Background())
	if res.ConflictRetries < 1 {
		t.Fatal("stale prepared page must be rebuilt after conflict")
	}
	if got := rec.countType("user_text"); got != 4 {
		t.Fatalf("user_text after rebuild = %d, want 4: %v", got, rec.ids())
	}
	if res.Deferred {
		t.Fatal("rebuilt page must emit")
	}
	cf := mustSnapshot(t, cs)
	for _, pp := range cf.Sessions[wire].Pending {
		for _, eid := range pp.ExpectedEventIDs {
			if eid == discoveredID {
				t.Fatal("acked discovered entry still pending after rebuild")
			}
		}
	}
}

func TestObserver_CursorConflictEmitsNothingFromStalePage(t *testing.T) {
	storage := seedSessionWithMessages(t, 3)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	dummy := 0
	o.testHookPagePrep = func(kind PositionKind) {
		if kind != PositionMessageInsert {
			return
		}
		dummy++
		// Bump the session revision on every preparation attempt so the
		// message page can never win its race.
		snap := mustSnapshot(t, cs)
		wire := WireSessionID(testSourceID, "ses1")
		_, err := cs.RecordPendingBatch(PendingBatchRequest{
			WireSessionID:         wire,
			ExpectedStateRevision: snap.Sessions[wire].StateRevision,
			Records: []PendingRecord{{
				WireSessionID:    wire,
				Position:         SourcePosition{Kind: PositionPartMutation, MutationTime: int64(dummy), NativeIDHash: hashID("hook")},
				ExpectedEventIDs: []string{fmt.Sprintf("hook-ev-%d", dummy)},
				PayloadDurable:   true,
			}},
		}, time.Now().UnixMilli())
		if err != nil {
			t.Errorf("hook record: %v", err)
		}
	}
	res := o.pollOnce(context.Background())
	if !res.Deferred {
		t.Fatal("exhausted conflict retries must defer")
	}
	if got := rec.countType("user_text"); got != 0 {
		t.Fatalf("stale page emitted %d user_text events, want 0", got)
	}
	if got := rec.countType("session_discovered"); got != 1 {
		t.Fatalf("metadata page emitted = %d, want 1 (only the message page conflicts)", got)
	}
	wire := WireSessionID(testSourceID, "ses1")
	cf := mustSnapshot(t, cs)
	for key, pp := range cf.Sessions[wire].Pending {
		if pp.Position.Kind == PositionMessageInsert {
			t.Fatalf("stale message page leaked durable pending: key %s entry %+v", key, pp)
		}
	}
}

// waitFor polls cond until it returns true or the deadline elapses.
func waitFor(t *testing.T, max time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within deadline")
}

func TestDeriveSessionStatus(t *testing.T) {
	now := time.Now().UnixMilli()
	tests := []struct {
		name    string
		finish  string
		tool    string
		updated int64
		want    string
	}{
		{"tool running → running", "tool-calls", "running", now, protocol.StatusRunning},
		{"tool pending → running", "tool-calls", "pending", now, protocol.StatusRunning},
		{"finish stop + tool completed → completed", "stop", "completed", now, protocol.StatusCompleted},
		{"finish completed + tool completed → completed", "completed", "completed", now, protocol.StatusCompleted},
		{"finish empty + tool empty + recent → running", "", "", now, protocol.StatusRunning},
		{"finish empty + tool empty + stale → completed", "", "", now - 10*60*1000, protocol.StatusCompleted},
		{"finish empty + tool completed → completed", "", "completed", now, protocol.StatusCompleted},
		{"finish empty + tool error → completed", "", "error", now, protocol.StatusCompleted},
		{"default all empty + no timestamp → completed", "", "", 0, protocol.StatusCompleted},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deriveSessionStatus(tt.finish, tt.tool, tt.updated)
			if got != tt.want {
				t.Fatalf("deriveSessionStatus(%q,%q,%d) = %q, want %q", tt.finish, tt.tool, tt.updated, got, tt.want)
			}
		})
	}
}

// --- mutation stream tests ---------------------------------------------------

// mutateMessages updates the given messages' data and time_updated in place.
func mutateMessages(t *testing.T, storage, sessionID string, ids []string, newText string, updatedAt int64) {
	t.Helper()
	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer wdb.Close()
	ctx := context.Background()
	for _, id := range ids {
		if _, err := wdb.ExecContext(ctx, "UPDATE message SET data = ?, time_updated = ? WHERE id = ?",
			userMsgJSON(newText), updatedAt, id); err != nil {
			t.Fatalf("mutate message %s: %v", id, err)
		}
	}
}

// mutateParts updates the given parts' data and time_updated in place.
func mutateParts(t *testing.T, storage string, ids []string, newText string, updatedAt int64) {
	t.Helper()
	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer wdb.Close()
	ctx := context.Background()
	for _, id := range ids {
		if _, err := wdb.ExecContext(ctx, "UPDATE part SET data = ?, time_updated = ? WHERE id = ?",
			textPartJSON(newText), updatedAt, id); err != nil {
			t.Fatalf("mutate part %s: %v", id, err)
		}
	}
}

func ackAllEmitted(t *testing.T, cs *CursorStore, rec *emitRecorder) {
	t.Helper()
	ids := make([]string, 0, len(rec.snapshot()))
	for _, ev := range rec.snapshot() {
		ids = append(ids, ev.EventID)
	}
	if _, err := cs.AcknowledgeEventIDs(ids); err != nil {
		t.Fatal(err)
	}
}

func TestObserver_MessageMutationPagesPastOneHundredSameTimestamp(t *testing.T) {
	const n = 101
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		for i := 1; i <= n; i++ {
			insertMessage(ctx, db, fmt.Sprintf("m%03d", i), "ses1", i, 0, 0, userMsgJSON(fmt.Sprintf("v1-%d", i)))
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	// Insert stream delivered the initial content; time_updated=0 rows are
	// pre-baseline for the mutation streams (no mutation candidates yet).
	if got := rec.countType("user_text"); got != n {
		t.Fatalf("insert round user_text = %d, want %d", got, n)
	}
	ackAllEmitted(t, cs, rec)
	// Mutate every message to new content at ONE shared timestamp: the stream
	// must page past the single-timestamp cluster (101 rows > 100 page size).
	mutateTimestamp := int64(1_700_000_100_000)
	ids := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		ids = append(ids, fmt.Sprintf("m%03d", i))
	}
	mutateMessages(t, storage, "ses1", ids, "v2", mutateTimestamp)
	before := rec.countType("user_text")
	res := o.pollOnce(context.Background())
	if got := rec.countType("user_text") - before; got != n {
		t.Fatalf("mutation pages discovered %d of %d events: %v", got, n, rec.ids())
	}
	if res.Deferred {
		t.Fatal("mutation paging must not defer")
	}
	seen := map[string]bool{}
	for _, ev := range rec.snapshot()[len(rec.snapshot())-(before*0+rec.countType("user_text")-before):] {
		_ = ev
	}
	_ = seen
	ackAllEmitted(t, cs, rec)
	cf := mustSnapshot(t, cs)
	s := cf.Sessions[WireSessionID(testSourceID, "ses1")]
	if got := len(s.Pending); got != 0 {
		t.Fatalf("pending = %d, want 0 after ack", got)
	}
	if s.AckMessageMutationTime != mutateTimestamp {
		t.Fatalf("AckMessageMutationTime = %d, want %d", s.AckMessageMutationTime, mutateTimestamp)
	}
}

func TestObserver_PartMutationPagesPastFiveHundredSameTimestamp(t *testing.T) {
	const n = 501
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		for i := 1; i <= n; i++ {
			insertPart(ctx, db, fmt.Sprintf("p%03d", i), "msg1", "ses1", i, 0, 0, textPartJSON(fmt.Sprintf("v1-%d", i)))
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	if got := rec.countType("agent_text"); got != n {
		t.Fatalf("insert round agent_text = %d, want %d", got, n)
	}
	ackAllEmitted(t, cs, rec)
	mutateTimestamp := int64(1_700_000_200_000)
	ids := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		ids = append(ids, fmt.Sprintf("p%03d", i))
	}
	mutateParts(t, storage, ids, "v2", mutateTimestamp)
	before := rec.countType("agent_text")
	res := o.pollOnce(context.Background())
	if got := rec.countType("agent_text") - before; got != n {
		t.Fatalf("mutation pages discovered %d of %d events", got, n)
	}
	if res.Deferred {
		t.Fatal("mutation paging must not defer")
	}
	ackAllEmitted(t, cs, rec)
	cf := mustSnapshot(t, cs)
	s := cf.Sessions[WireSessionID(testSourceID, "ses1")]
	if got := len(s.Pending); got != 0 {
		t.Fatalf("pending = %d, want 0 after ack", got)
	}
	if s.AckPartMutationTime != mutateTimestamp {
		t.Fatalf("AckPartMutationTime = %d, want %d", s.AckPartMutationTime, mutateTimestamp)
	}
	// Every mutated part advanced to revision 2 in the durable checkpoint.
	for i := 1; i <= n; i++ {
		wp := WirePartID(testSourceID, fmt.Sprintf("p%03d", i))
		if got := s.Sync.Parts[wp].Revision; got != 2 {
			t.Fatalf("part %s revision = %d, want 2", fmt.Sprintf("p%03d", i), got)
		}
	}
}

func TestObserver_MutationOverlapDoesNotRegressHighWater(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		for i := 1; i <= 3; i++ {
			insertPart(ctx, db, fmt.Sprintf("p%d", i), "msg1", "ses1", i, 0, 0, textPartJSON(fmt.Sprintf("v1-%d", i)))
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)
	later := int64(1_700_000_300_000)
	mutateParts(t, storage, []string{"p2"}, "v2", later)
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)
	wire := WireSessionID(testSourceID, "ses1")
	if got := mustSnapshot(t, cs).Sessions[wire].AckPartMutationTime; got != later {
		t.Fatalf("baseline AckPartMutationTime = %d, want %d", got, later)
	}
	// A mutation INSIDE the overlap window but with an earlier timestamp must
	// still be delivered while the durable high-water stays at the newer time.
	earlier := later - 1000
	mutateParts(t, storage, []string{"p3"}, "v2-earlier", earlier)
	before := rec.countType("agent_text")
	o.pollOnce(context.Background())
	if got := rec.countType("agent_text") - before; got != 1 {
		t.Fatalf("overlap mutation delivered %d events, want 1", got)
	}
	ackAllEmitted(t, cs, rec)
	cf := mustSnapshot(t, cs)
	if got := cf.Sessions[wire].AckPartMutationTime; got != later {
		t.Fatalf("high-water regressed to %d, want %d", got, later)
	}
}

func TestObserver_UnchangedOverlapCreatesNoPending(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		for i := 1; i <= 3; i++ {
			insertPart(ctx, db, fmt.Sprintf("p%d", i), "msg1", "ses1", i, 0, 0, textPartJSON(fmt.Sprintf("v1-%d", i)))
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)
	ts := int64(1_700_000_400_000)
	mutateParts(t, storage, []string{"p1", "p2", "p3"}, "v2", ts)
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)
	// Repeated scans of the unchanged overlap rows: no pending entries, no
	// emission, and no durable high-water change.
	for round := 0; round < 3; round++ {
		res := o.pollOnce(context.Background())
		if got := res.NewPending; got != 0 {
			t.Fatalf("round %d: unchanged overlap created %d pending entries", round, got)
		}
		if got := res.Emitted; got != 0 {
			t.Fatalf("round %d: unchanged overlap emitted %d events", round, got)
		}
	}
	cf := mustSnapshot(t, cs)
	s := cf.Sessions[WireSessionID(testSourceID, "ses1")]
	if got := len(s.Pending); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
	if s.AckPartMutationTime != ts {
		t.Fatalf("AckPartMutationTime = %d, want %d (unchanged)", s.AckPartMutationTime, ts)
	}
}

func TestObserver_UnmappedPartInsideMutationOverlapConverges(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		insertPart(ctx, db, "p1", "msg1", "ses1", 1, 0, 0, textPartJSON("one"))
		insertPart(ctx, db, "p2", "msg1", "ses1", 2, 0, 0, textPartJSON("two"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)

	base := int64(1_700_000_450_000)
	mutateParts(t, storage, []string{"p1"}, "one-new", base)
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)

	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wdb.ExecContext(context.Background(),
		"UPDATE part SET data = ?, time_updated = ? WHERE id = ?",
		`{"type":"timeline"}`, base-1000, "p2"); err != nil {
		wdb.Close()
		t.Fatal(err)
	}
	if err := wdb.Close(); err != nil {
		t.Fatal(err)
	}

	first := o.pollOnce(context.Background())
	if first.Emitted != 0 {
		t.Fatalf("unmapped overlap emitted %d events", first.Emitted)
	}
	for round := 0; round < 3; round++ {
		poll := o.pollOnce(context.Background())
		if poll.HasActiveWork() {
			t.Fatalf("round %d: unmapped part overlap did not converge: %+v", round, poll)
		}
	}
}

func TestObserver_MutationPaginationRejectsNonAdvancingCursor(t *testing.T) {
	base := int64(1_700_000_500_000)
	// A page whose last tuple does not strictly advance the query tuple must
	// fail closed instead of looping forever.
	if _, err := advanceTransientCursor(MutationCursor{TimeUpdated: base, ID: "a"}, MutationCursor{TimeUpdated: base, ID: "a"}); !errors.Is(err, ErrMutationStall) {
		t.Fatalf("identical tuple error = %v, want ErrMutationStall", err)
	}
	if _, err := advanceTransientCursor(MutationCursor{TimeUpdated: base, ID: "b"}, MutationCursor{TimeUpdated: base - 1, ID: "z"}); !errors.Is(err, ErrMutationStall) {
		t.Fatalf("regressing tuple error = %v, want ErrMutationStall", err)
	}
	next, err := advanceTransientCursor(MutationCursor{TimeUpdated: base, ID: "a"}, MutationCursor{TimeUpdated: base, ID: "b"})
	if err != nil || next.ID != "b" {
		t.Fatalf("advancing tuple rejected: %v %+v", err, next)
	}
	next, err = advanceTransientCursor(MutationCursor{TimeUpdated: base, ID: "a"}, MutationCursor{TimeUpdated: base + 1, ID: "a"})
	if err != nil || next.TimeUpdated != base+1 {
		t.Fatalf("time-advancing tuple rejected: %v %+v", err, next)
	}
}

func TestObserver_TwoPartMutationsBeforeFirstAckRemainDistinct(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		insertPart(ctx, db, "p1", "msg1", "ses1", 1, 0, 0, textPartJSON("v1"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec) // insert revision 1 durable; no ACK for mutations below
	ts := int64(1_700_000_600_000)
	mutateParts(t, storage, []string{"p1"}, "v2", ts)
	o.pollOnce(context.Background()) // generation 2 recorded + emitted, unacked
	wp := WirePartID(testSourceID, "p1")
	var ev2 string
	for _, ev := range rec.snapshot() {
		if ev.PartID == wp && ev.Text == "v2" {
			ev2 = ev.EventID
		}
	}
	if ev2 == "" {
		t.Fatal("generation 2 was not emitted")
	}
	// Second mutation of the same part before any ACK: distinct pending key,
	// revision 3, PreviousEventID chained through generation 2.
	mutateParts(t, storage, []string{"p1"}, "v3", ts)
	o.pollOnce(context.Background())
	var ev3 string
	for _, ev := range rec.snapshot() {
		if ev.PartID == wp && ev.Text == "v3" {
			ev3 = ev.EventID
		}
	}
	if ev3 == "" {
		t.Fatal("generation 3 was not emitted")
	}
	wire := WireSessionID(testSourceID, "ses1")
	cf := mustSnapshot(t, cs)
	mutEntries := 0
	for _, pp := range cf.Sessions[wire].Pending {
		if pp.Position.Kind == PositionPartMutation {
			mutEntries++
		}
	}
	if mutEntries != 2 {
		t.Fatalf("pending mutation generations = %d, want 2", mutEntries)
	}
	// ACK generation 3 first: both remain (prefix blocked by generation 2).
	if _, err := cs.AcknowledgeEventIDs([]string{ev3}); err != nil {
		t.Fatal(err)
	}
	if got := len(mustSnapshot(t, cs).Sessions[wire].Pending); got < 2 {
		t.Fatalf("out-of-order generation ack advanced prefix: pending = %d", got)
	}
	if _, err := cs.AcknowledgeEventIDs([]string{ev2}); err != nil {
		t.Fatal(err)
	}
	cf = mustSnapshot(t, cs)
	s := cf.Sessions[wire]
	if got := len(s.Pending); got != 0 {
		t.Fatalf("pending = %d after both acks", got)
	}
	if got := s.Sync.Parts[wp].Revision; got != 3 {
		t.Fatalf("part revision = %d, want 3", got)
	}
	if s.AckPartMutationTime != ts {
		t.Fatalf("AckPartMutationTime = %d, want %d", s.AckPartMutationTime, ts)
	}
}

func TestObserver_PartMutationRestartKeepsRevisionAndEventID(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		insertPart(ctx, db, "p1", "msg1", "ses1", 1, 0, 0, textPartJSON("v1"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	recA := newEmitRecorder()
	oA := testObserver(t, storage, cs, recA.fn())
	oA.pollOnce(context.Background())
	ackAllEmitted(t, cs, recA)
	ts := int64(1_700_000_700_000)
	mutateParts(t, storage, []string{"p1"}, "v2", ts)
	oA.pollOnce(context.Background()) // generation 2 durable, unacked
	wp := WirePartID(testSourceID, "p1")
	ev2 := ""
	for _, ev := range recA.snapshot() {
		if ev.PartID == wp && ev.Text == "v2" {
			ev2 = ev.EventID
		}
	}
	if ev2 == "" {
		t.Fatal("generation 2 not emitted before restart")
	}
	// Restart: a brand-new observer rebuilds from the same durable cursor.
	// The source row has moved on to v3, so generation 2's payload cannot be
	// regenerated (plan §10 boundary); its durable pending entry survives and
	// the restart continues the revision chain from it.
	mutateParts(t, storage, []string{"p1"}, "v3", ts)
	recB := newEmitRecorder()
	oB := testObserver(t, storage, cs, recB.fn())
	res := oB.pollOnce(context.Background())
	if res.Deferred {
		t.Fatal("restart poll must not defer")
	}
	ev3 := ""
	for _, ev := range recB.snapshot() {
		if ev.PartID == wp && ev.Text == "v3" {
			ev3 = ev.EventID
			if ev.Revision != 3 {
				t.Fatalf("generation 3 revision = %d, want 3 (continues pending chain)", ev.Revision)
			}
			if ev.PreviousEventID != ev2 {
				t.Fatalf("generation 3 PreviousEventID = %q, want %q", ev.PreviousEventID, ev2)
			}
		}
	}
	if ev3 == "" {
		t.Fatal("generation 3 not emitted after restart")
	}
	wire := WireSessionID(testSourceID, "ses1")
	gen2Alive := false
	for _, pp := range mustSnapshot(t, cs).Sessions[wire].Pending {
		if pp.Position.Kind == PositionPartMutation && sameStringSet(pp.ExpectedEventIDs, []string{ev2}) {
			gen2Alive = true
		}
	}
	if !gen2Alive {
		t.Fatal("restart lost the unacknowledged generation 2 pending entry")
	}
}

// --- scheduler tests ---------------------------------------------------------

// fakeTimer replaces the observer's real timer: tests fire ticks manually and
// inspect the interval the loop selected, without sleeping.
type fakeTimer struct {
	mu       sync.Mutex
	interval time.Duration
	ch       chan time.Time
	stopped  int
}

func newFakeTimer() *fakeTimer {
	return &fakeTimer{ch: make(chan time.Time, 16)}
}

func (f *fakeTimer) C() <-chan time.Time { return f.ch }

func (f *fakeTimer) Reset(d time.Duration) {
	f.mu.Lock()
	f.interval = d
	f.mu.Unlock()
}

func (f *fakeTimer) Stop() {
	f.mu.Lock()
	f.stopped++
	f.mu.Unlock()
}

func (f *fakeTimer) fire() {
	select {
	case f.ch <- time.Now():
	default:
	}
}

func (f *fakeTimer) current() (time.Duration, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.interval, f.stopped
}

// startedObserver wires an observer with a fake timer and a started loop.
func startedObserver(t *testing.T, storage string, cs *CursorStore, emit EmitFunc) (*Observer, *fakeTimer) {
	t.Helper()
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		History: HistoryAll, LookbackDays: 30,
		OpenStore:   func() (*Store, error) { return Open(storage) },
		CursorStore: cs,
		ActivePoll:  time.Second,
		IdlePoll:    5 * time.Second,
		Emit:        emit,
	})
	ft := newFakeTimer()
	o.timerFn = func(time.Duration) pollTimer { return ft }
	store, err := Open(storage)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	journal := NewPreparedEventJournalAt(storage + "/prepared-events.jsonl")
	if err := journal.Open(); err != nil {
		t.Fatalf("open prepared journal: %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
		_ = journal.Close()
		o.Stop()
	})
	o.store = store
	o.cursor = cs
	o.journal = journal
	o.reconcileRecovery()
	o.enabled = true
	go o.loop(context.Background())
	return o, ft
}

// convergePolls drains a fresh fixture: poll, ack everything emitted, repeat
// until a poll produces no outcomes.
func convergePolls(t *testing.T, o *Observer, cs *CursorStore, rec *emitRecorder, maxRounds int) {
	t.Helper()
	for i := 0; i < maxRounds; i++ {
		res := o.pollOnce(context.Background())
		ackAllEmitted(t, cs, rec)
		if !res.HasActiveWork() {
			return
		}
	}
	t.Fatal("fixture did not converge within the poll budget")
}

func TestObserver_UnchangedOverlapUsesIdleInterval(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		for i := 1; i <= 3; i++ {
			insertPart(ctx, db, fmt.Sprintf("p%d", i), "msg1", "ses1", i, 0, 0, textPartJSON(fmt.Sprintf("v1-%d", i)))
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o, ft := startedObserver(t, storage, cs, rec.fn())
	convergePolls(t, o, cs, rec, 10)
	// Fire the timer: the poll sees only unchanged overlap rows and must
	// select the idle interval.
	ft.fire()
	waitFor(t, time.Second, func() bool {
		d, _ := ft.current()
		return d == 5*time.Second
	})
}

func TestObserver_NewPendingUsesActiveInterval(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, 1, 1, userMsgJSON("hello"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o, ft := startedObserver(t, storage, cs, rec.fn())
	ft.fire()
	waitFor(t, time.Second, func() bool {
		d, _ := ft.current()
		return d == time.Second
	})
	res := o.pollOnce(context.Background())
	if !res.HasActiveWork() {
		t.Fatalf("new pending must count as active work: %+v", res)
	}
}

func TestObserver_BackpressureUsesActiveInterval(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	rec.accept.Store(0) // reject everything
	_, ft := startedObserver(t, storage, cs, rec.fn())
	ft.fire()
	waitFor(t, time.Second, func() bool {
		d, _ := ft.current()
		return d == time.Second
	})
}

func TestObserver_ResyncWakesIdleTimer(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, 0, 0, userMsgJSON("q"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o, ft := startedObserver(t, storage, cs, rec.fn())
	convergePolls(t, o, cs, rec, 10)
	resyncSeen := atomic.Bool{}
	o.cfg.Emit = func(ev protocol.DaemonEvent) bool {
		if ev.Resync {
			resyncSeen.Store(true)
		}
		return rec.fn()(ev)
	}
	// Drop to the idle interval, then plant new content and wake via resync:
	// the immediate poll must discover it without waiting out five seconds.
	ft.Reset(5 * time.Second)
	mutateMessages(t, storage, "ses1", []string{"m1"}, "wake-up", nowMillis())
	o.QueueResync()
	waitFor(t, 2*time.Second, func() bool { return resyncSeen.Load() })
	waitFor(t, 2*time.Second, func() bool {
		return rec.countType("user_text") >= 2
	})
	// The wake poll itself found active work: back to the active interval.
	waitFor(t, time.Second, func() bool {
		d, _ := ft.current()
		return d == time.Second
	})
}

func TestObserver_StopDoesNotLeakTimerOrGoroutine(t *testing.T) {
	storage := testdb(t)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	o, ft := startedObserver(t, storage, cs, func(protocol.DaemonEvent) bool { return true })
	o.Stop()
	select {
	case <-o.done:
	case <-time.After(time.Second):
		t.Fatal("Stop did not close done channel (goroutine leak)")
	}
	if _, stopped := ft.current(); stopped < 1 {
		t.Fatal("Stop must stop the poll timer")
	}
	// A second Stop is a safe no-op.
	o.Stop()
}

func TestObserver_EmptyIdlePollDoesNotPersistEveryFiveSeconds(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		insertPart(ctx, db, "p1", "msg1", "ses1", 1, 0, 0, textPartJSON("v1"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o, _ := startedObserver(t, storage, cs, rec.fn())
	convergePolls(t, o, cs, rec, 10)
	n := countPersists(cs)
	// Simulate several idle polls: no cursor write may happen (LastScan is
	// throttled and nothing else changes state).
	for i := 0; i < 3; i++ {
		res := o.pollOnce(context.Background())
		if res.HasActiveWork() {
			t.Fatalf("idle poll %d reported active work: %+v", i, res)
		}
	}
	if got := n.Load(); got != 0 {
		t.Fatalf("idle polls persisted the cursor %d times, want 0", got)
	}
}

// --- recovery hardening: full message mutation overlap ------------------------

func TestObserver_MessageMutationOverlapInsideWindowEmittedOnce(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		for i := 1; i <= 2; i++ {
			insertMessage(ctx, db, fmt.Sprintf("m%d", i), "ses1", i, 0, 0, userMsgJSON(fmt.Sprintf("v1-%d", i)))
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)
	// Establish the acknowledged mutation baseline at time T.
	base := int64(1_700_000_800_000)
	mutateMessages(t, storage, "ses1", []string{"m1"}, "v2", base)
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)
	wire := WireSessionID(testSourceID, "ses1")
	if got := mustSnapshot(t, cs).Sessions[wire].AckMessageMutationTime; got != base {
		t.Fatalf("baseline AckMessageMutationTime = %d, want %d", got, base)
	}
	// A message mutation INSIDE the overlap window (1s before the ack time)
	// must still be a candidate and be emitted exactly once.
	mutateMessages(t, storage, "ses1", []string{"m2"}, "v2-early", base-1000)
	before := rec.countType("user_text")
	res := o.pollOnce(context.Background())
	if got := rec.countType("user_text") - before; got != 1 {
		t.Fatalf("overlap mutation emitted %d events, want 1 (full overlap semantics)", got)
	}
	ackAllEmitted(t, cs, rec)
	if got := mustSnapshot(t, cs).Sessions[wire].AckMessageMutationTime; got != base {
		t.Fatalf("overlap emission regressed the mutation high-water to %d", got)
	}
	if res.Deferred {
		t.Fatal("overlap mutation must not defer")
	}
	// The durable high-water stays at the newer acknowledged time.
	for round := 0; round < 3; round++ {
		poll := o.pollOnce(context.Background())
		if poll.HasActiveWork() {
			t.Fatalf("round %d: unchanged overlap rows produced active work: %+v", round, poll)
		}
	}
	cf := mustSnapshot(t, cs)
	if got := cf.Sessions[wire].AckMessageMutationTime; got != base {
		t.Fatalf("repeated overlap scans moved the high-water to %d, want %d", got, base)
	}
	if got := len(cf.Sessions[wire].Pending); got != 0 {
		t.Fatalf("repeated overlap scans created %d pending entries", got)
	}
}

func TestObserver_FilteredMessageInsideMutationOverlapConverges(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, 0, 0, userMsgJSON("one"))
		insertMessage(ctx, db, "m2", "ses1", 2, 0, 0, userMsgJSON("two"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)

	base := int64(1_700_000_850_000)
	mutateMessages(t, storage, "ses1", []string{"m1"}, "one-new", base)
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)

	wdb, err := sql.Open("sqlite", "file:"+storage+"/db/db.sqlite?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wdb.ExecContext(context.Background(),
		"UPDATE message SET data = ?, time_updated = ? WHERE id = ?",
		`{"role":"assistant","synthetic":true}`, base-1000, "m2"); err != nil {
		wdb.Close()
		t.Fatal(err)
	}
	if err := wdb.Close(); err != nil {
		t.Fatal(err)
	}

	first := o.pollOnce(context.Background())
	if first.Emitted != 0 {
		t.Fatalf("filtered overlap emitted %d events", first.Emitted)
	}
	for round := 0; round < 3; round++ {
		poll := o.pollOnce(context.Background())
		if poll.HasActiveWork() {
			wire := WireSessionID(testSourceID, "ses1")
			t.Fatalf("round %d: filtered overlap did not converge: poll=%+v cursor=%+v", round, poll, mustSnapshot(t, cs).Sessions[wire])
		}
	}
}

func TestObserver_UnchangedMessageOverlapSelectsIdleInterval(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, 0, 0, userMsgJSON("q"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o, ft := startedObserver(t, storage, cs, rec.fn())
	convergePolls(t, o, cs, rec, 10)
	base := int64(1_700_000_900_000)
	mutateMessages(t, storage, "ses1", []string{"m1"}, "v2", base)
	ft.fire()
	waitFor(t, 2*time.Second, func() bool { return rec.countType("user_text") >= 2 })
	ackAllEmitted(t, cs, rec)
	// The mutated row sits inside the overlap window below the acknowledged
	// time: repeated scans must be outcome-free and select the idle interval.
	ft.fire()
	waitFor(t, 2*time.Second, func() bool {
		d, _ := ft.current()
		return d == 5*time.Second
	})
}

// --- recovery hardening: projection performance --------------------------------

func TestObserver_EmitPageDoesNotHydrateProjection(t *testing.T) {
	storage := seedSessionWithMessages(t, 1)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	plan := pagePlan{
		rows: []preparedRow{{
			Pending: PendingRecord{
				WireSessionID:    "w1",
				Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
				ExpectedEventIDs: []string{"e1"},
			},
			Events: []protocol.DaemonEvent{{Type: "user_text", EventID: "e1"}},
		}},
	}
	recorded := RecordedBatch{StateRevision: 1}
	before := speculativeHydrations.Load()
	st := o.emitPage("w1", plan, recorded)
	if st.emitted != 1 || st.deferred {
		t.Fatalf("emitPage stats = %+v", st)
	}
	if got := speculativeHydrations.Load() - before; got != 0 {
		t.Fatalf("emitPage performed %d discarded speculative hydrations, want 0", got)
	}
}

func TestObserver_SpeculativeCommitConflictFailsPage(t *testing.T) {
	storage := seedSessionWithMessages(t, 1)
	wire := WireSessionID(testSourceID, "ses1")
	// Craft a session cursor whose pending commits collide: two message
	// commits with the same order but different identities. The timeline
	// replay during page preparation must surface the conflict instead of
	// swallowing it.
	pending := map[string]PendingPosition{}
	for i := 0; i < 2; i++ {
		key := fmt.Sprintf("k%d", i)
		pending[key] = PendingPosition{
			Position: SourcePosition{
				Kind:         PositionMessageMutation,
				Order:        uint64(i + 1),
				MutationTime: int64(1000 + i),
				NativeIDHash: fmt.Sprintf("mh%d", i),
			},
			ExpectedEventIDs: []string{fmt.Sprintf("e%d", i)},
			Commit: SyncCommit{
				CommitOrder: 7,
				Message: &MessageCommit{
					WireMessageID: "wm-collide",
					EventID:       fmt.Sprintf("e%d", i),
					SemanticHash:  fmt.Sprintf("s%d", i),
				},
			},
		}
	}
	crafted := CursorFile{
		Version: CursorVersion,
		Sessions: map[string]SessionCursor{
			wire: {StateRevision: 5, NextCommitOrder: 8, Pending: pending},
		},
	}
	cs := NewCursorStoreAt(storage + "/cursor.json")
	data, err := json.Marshal(crafted)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cs.Path(), data, 0o600); err != nil {
		t.Fatal(err)
	}
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	sess := mustSnapshot(t, cs).Sessions[wire]
	_, err = o.planMessageMutationPage(context.Background(), wire, "ses1", sess, MutationCursor{})
	if !errors.Is(err, ErrCursorMessageConflict) {
		t.Fatalf("planner error = %v, want ErrCursorMessageConflict (conflict must propagate, not be swallowed)", err)
	}
}

// --- recovery hardening: prepared replay and blocked sessions -----------------

func TestObserver_RestartReplaysExactJournalPayload(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg1", "ses1", 1, 0, 0, userMsgJSON("q"))
		insertPart(ctx, db, "p1", "msg1", "ses1", 1, 0, 0, textPartJSON("v1"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	wp := WirePartID(testSourceID, "p1")
	// Round 1: converge the seed content so the later v2 change is a true
	// mutation against an acknowledged baseline.
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	ackAllEmitted(t, cs, rec)
	// Round 2: the source mutates to v2 and the gate rejects EVERYTHING —
	// the mutation becomes durable pending with a journal payload but never
	// leaves the observer.
	ts := int64(1_700_001_000_000)
	mutateParts(t, storage, []string{"p1"}, "v2", ts)
	rec.accept.Store(0)
	o.pollOnce(context.Background())
	wire := WireSessionID(testSourceID, "ses1")
	var gen2 string
	for _, pp := range mustSnapshot(t, cs).Sessions[wire].Pending {
		if pp.Position.Kind == PositionPartMutation && pp.PayloadDurable {
			for _, eid := range pp.ExpectedEventIDs {
				if !containsStr(pp.AckedEventIDs, eid) {
					gen2 = eid
				}
			}
		}
	}
	if gen2 == "" {
		t.Fatal("durable pending mutation missing after backpressured poll")
	}
	// Round 2: the source advances BEFORE any delivery or ACK. A fresh
	// observer (restart) must replay the EXACT prepared v2 payload, not a
	// regeneration from the v3 source row, then chain generation 3.
	mutateParts(t, storage, []string{"p1"}, "v3", ts)
	recB := newEmitRecorder()
	oB := testObserver(t, storage, cs, recB.fn())
	res := oB.pollOnce(context.Background())
	if res.Deferred {
		t.Fatal("restart replay poll must not defer")
	}
	var sawV2, sawV3 string
	for _, ev := range recB.snapshot() {
		if ev.PartID == wp && ev.Text == "v2" {
			sawV2 = ev.EventID
		}
		if ev.PartID == wp && ev.Text == "v3" {
			sawV3 = ev.EventID
		}
	}
	if sawV2 != gen2 {
		t.Fatalf("restart did not replay the exact prepared payload: got id %q for v2, want %q", sawV2, gen2)
	}
	if sawV3 == "" {
		t.Fatal("generation 3 not emitted after replay")
	}
	// ACK old then new generation: pending drains and the high-water advances.
	if _, err := cs.AcknowledgeEventIDs([]string{sawV2}); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.AcknowledgeEventIDs([]string{sawV3}); err != nil {
		t.Fatal(err)
	}
	cf := mustSnapshot(t, cs)
	s := cf.Sessions[wire]
	if got := len(s.Pending); got != 0 {
		t.Fatalf("pending = %d after both ACKs, want 0", got)
	}
	if s.AckPartMutationTime != ts {
		t.Fatalf("AckPartMutationTime = %d, want %d", s.AckPartMutationTime, ts)
	}
	if got := s.Sync.Parts[wp].Revision; got != 3 {
		t.Fatalf("part revision = %d, want 3", got)
	}
}

func TestObserver_RestartAfterEnqueueReplaysSameEventID(t *testing.T) {
	storage := seedSessionWithMessages(t, 3)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	// Round 1: the gate ACCEPTS (event reaches outputCh = enqueued) but no ACK
	// ever returns; the process "crashes" before WebSocket consumption.
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	firstUser := ""
	for _, ev := range rec.snapshot() {
		if ev.Type == "user_text" {
			firstUser = ev.EventID
			break
		}
	}
	if firstUser == "" {
		t.Fatal("no user_text enqueued in round 1")
	}
	// Round 2: a fresh observer replays the same EventID from the journal.
	recB := newEmitRecorder()
	oB := testObserver(t, storage, cs, recB.fn())
	oB.pollOnce(context.Background())
	replayed := false
	for _, ev := range recB.snapshot() {
		if ev.Type == "user_text" && ev.EventID == firstUser {
			replayed = true
		}
	}
	if !replayed {
		t.Fatalf("restart did not replay enqueued event %s", firstUser)
	}
}

func TestObserver_JournalMissingPayloadBlocksSession(t *testing.T) {
	storage := seedSessionWithMessages(t, 2)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	wire := WireSessionID(testSourceID, "ses1")
	// Record one durable pending entry through a normal poll, then corrupt
	// recovery by removing the journal file entirely (simulating a lost
	// prepared journal).
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	if err := o.journal.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(o.journal.Path()); err != nil {
		t.Fatal(err)
	}
	// Restart with an empty journal: the durable pending entry references a
	// payload that no longer exists.
	oB := testObserver(t, storage, cs, recB_EmitAll(t))
	if !oB.isRecoveryBlocked(wire) {
		t.Fatal("missing prepared payload must block the session at startup")
	}
	// The blocked session contributes no outcomes and never spins.
	for round := 0; round < 3; round++ {
		res := oB.pollOnce(context.Background())
		if res.HasActiveWork() {
			t.Fatalf("blocked session produced active work: %+v", res)
		}
	}
	// No new mutation generations may appear behind the gap: mutate and poll.
	mutateMessages(t, storage, "ses1", []string{"m1"}, "v2", nowMillis())
	res := oB.pollOnce(context.Background())
	if res.NewPending != 0 || res.Emitted != 0 {
		t.Fatalf("blocked session created work behind the recovery gap: %+v", res)
	}
	if got := len(mustSnapshot(t, cs).Sessions[wire].Pending); got == 0 {
		t.Fatal("recovery blocking must not silently clear pending state")
	}
}

func recB_EmitAll(t *testing.T) EmitFunc {
	t.Helper()
	return func(protocol.DaemonEvent) bool { return true }
}

func TestObserver_LegacyPendingMismatchBlocksSession(t *testing.T) {
	storage := seedSessionWithMessages(t, 1)
	wire := WireSessionID(testSourceID, "ses1")
	cs := NewCursorStoreAt(storage + "/cursor.json")
	// Craft a legacy (PayloadDurable=false) pending entry whose expected
	// event does not match what the source can regenerate. The identity must
	// match the observer's so the first poll does not reset sessions.
	ident := CursorIdentity{
		StoragePathHash:   StoragePathHash(storage),
		SourceID:          testSourceID,
		SchemaFingerprint: fixtureFingerprint(t, storage),
	}
	crafted := CursorFile{
		Version:           CursorVersion,
		StoragePathHash:   ident.StoragePathHash,
		SourceID:          ident.SourceID,
		SchemaFingerprint: ident.SchemaFingerprint,
		Sessions: map[string]SessionCursor{
			wire: {
				StateRevision:   5,
				NextCommitOrder: 2,
				Pending: map[string]PendingPosition{
					"legacy": {
						Position:         SourcePosition{Kind: PositionMessageInsert, Order: 1, MessageSequence: 1, NativeIDHash: hashID("m1")},
						ExpectedEventIDs: []string{"legacy-unmatchable-event"},
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
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	res := o.pollOnce(context.Background())
	if !o.isRecoveryBlocked(wire) {
		t.Fatal("legacy pending mismatch must block the session")
	}
	// Only the metadata page (which runs before the gap is discovered) may
	// have produced work; no message content is emitted or recorded.
	if got := rec.countType("user_text"); got != 0 {
		t.Fatalf("legacy mismatch emitted %d message events", got)
	}
	// Pending contains the crafted legacy entry plus at most the session
	// metadata — never a new generation behind the gap.
	cf := mustSnapshot(t, cs)
	for _, pp := range cf.Sessions[wire].Pending {
		if pp.Position.Kind != PositionMetadata && pp.Position.Kind != PositionMessageInsert {
			t.Fatalf("new generation created behind the recovery gap: %+v", pp)
		}
	}
	// Subsequent polls contribute nothing.
	res = o.pollOnce(context.Background())
	if res.HasActiveWork() {
		t.Fatalf("blocked session still produced work: %+v", res)
	}
}

func TestObserver_PrepareBatchOncePerEventPage(t *testing.T) {
	storage := seedSessionWithMessages(t, 5)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.pollOnce(context.Background())
	// Event-producing pages: metadata (discovered), messages (one page of 5),
	// status (running) — three journal appends, never one per event.
	if got := o.journal.appendCount; got != 3 {
		t.Fatalf("journal appends = %d, want 3 (one per event-producing page)", got)
	}
	if got := o.journal.syncCount; got != 3 {
		t.Fatalf("journal syncs = %d, want 3", got)
	}
	// A converged poll with pure-skip pages appends nothing.
	ackAllEmitted(t, cs, rec)
	before := o.journal.appendCount
	res := o.pollOnce(context.Background())
	if res.HasActiveWork() {
		t.Fatalf("converged poll active: %+v", res)
	}
	if got := o.journal.appendCount; got != before {
		t.Fatalf("converged poll appended to the journal %d times", got-before)
	}
}

func TestObserver_StartResetsIdentityBeforeJournalReconcile(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	if err := cs.UpdateIdentity(CursorIdentity{
		StoragePathHash:   "old-storage",
		SourceID:          testSourceID,
		SchemaFingerprint: "old-schema",
	}); err != nil {
		t.Fatal(err)
	}
	wire := WireSessionID(testSourceID, "ses1")
	recordBatchAt(t, cs, wire, 1_000_000, PendingRecord{
		WireSessionID:    wire,
		Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: 1},
		ExpectedEventIDs: []string{"missing-old-payload"},
		Commit:           SyncCommit{LastEventID: "missing-old-payload"},
	})

	j := NewPreparedEventJournalAt(storage + "/prepared-events.jsonl")
	o := NewObserver(ObserverConfig{
		SourceID:             testSourceID,
		StorageDir:           storage,
		History:              HistoryAll,
		LookbackDays:         30,
		OpenStore:            func() (*Store, error) { return Open(storage) },
		CursorStore:          cs,
		PreparedEventJournal: j,
		Emit:                 func(protocol.DaemonEvent) bool { return true },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := o.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer o.Stop()

	if o.isRecoveryBlocked(wire) {
		t.Fatal("stale identity pending blocked the reset session")
	}
	if got := len(mustSnapshot(t, cs).Sessions); got != 0 {
		t.Fatalf("identity reset left %d stale sessions before recovery", got)
	}
}
