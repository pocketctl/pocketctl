package zcode

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	_ "modernc.org/sqlite"
)

// observer_benchmark_test.go holds the deterministic performance fixtures:
// a large acknowledged fixture for steady-idle polling, a v1 cursor variant
// for the migration/backfill path, and the page-bounded persistence gate.
// All data is synthetic and lives only in a temporary database.

// benchObserver builds an observer with an opened store but no loop, for
// benchmark-driven polls.
func benchObserver(b *testing.B, storage string, cs *CursorStore, emit EmitFunc) *Observer {
	b.Helper()
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		History: HistoryAll, LookbackDays: 30,
		OpenStore:   func() (*Store, error) { return Open(storage) },
		CursorStore: cs,
		Emit:        emit,
	})
	store, err := Open(storage)
	if err != nil {
		b.Fatalf("open store: %v", err)
	}
	if err := store.Probe(context.Background()); err != nil {
		b.Fatalf("probe: %v", err)
	}
	journal := NewPreparedEventJournalAt(storage + "/prepared-events.jsonl")
	if err := journal.Open(); err != nil {
		b.Fatalf("open prepared journal: %v", err)
	}
	b.Cleanup(func() {
		_ = store.Close()
		_ = journal.Close()
	})
	o.store = store
	o.cursor = cs
	o.journal = journal
	o.reconcileRecovery()
	o.enabled = true
	return o
}

// buildLargeFixture seeds approximately 200 sessions, 8,000 messages and
// 30,000 parts with dense mutation timestamps (one shared time_updated per
// session's parts) in a temporary storage root.
func buildLargeFixture(tb testing.TB) string {
	tb.Helper()
	const sessions = 200
	const msgsPerSession = 40  // 8,000 messages
	const partsPerSession = 15 // 30,000 parts
	storage := tb.TempDir()
	dbDir := filepath.Join(storage, "db")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		tb.Fatal(err)
	}
	dbPath := filepath.Join(dbDir, "db.sqlite")
	db, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=journal_mode(WAL)")
	if err != nil {
		tb.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	exec := func(q string) {
		if _, err := db.ExecContext(ctx, q); err != nil {
			tb.Fatalf("fixture exec: %v\n%s", err, q)
		}
	}
	exec(`CREATE TABLE session (
		id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
		slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
		version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
		summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT,
		time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
		time_archived INTEGER, task_type TEXT NOT NULL DEFAULT 'interactive',
		title_source TEXT NOT NULL DEFAULT 'first_input', title_message_id TEXT,
		time_title_updated INTEGER, trace_id TEXT)`)
	exec(`CREATE TABLE message (
		id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
		time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER)`)
	exec(`CREATE TABLE part (
		id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
		time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER)`)
	exec(`CREATE TABLE todo (
		session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
		priority TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 2,
		time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
		PRIMARY KEY (session_id, content, position))`)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		tb.Fatal(err)
	}
	now := time.Now().UnixMilli()
	for s := 0; s < sessions; s++ {
		sesID := fmt.Sprintf("bench-ses-%03d", s)
		if _, err := tx.ExecContext(ctx, `INSERT INTO session
			(id, project_id, directory, slug, title, version, time_created, time_updated, time_archived)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			sesID, "proj", "/bench", "s"+sesID, fmt.Sprintf("title-%d", s), "v1", now, now, 0); err != nil {
			tx.Rollback()
			tb.Fatal(err)
		}
		for m := 1; m <= msgsPerSession; m++ {
			msgID := fmt.Sprintf("%s-m%03d", sesID, m)
			if m == 1 {
				if _, err := tx.ExecContext(ctx, `INSERT INTO message
					(id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)`,
					msgID, sesID, 0, 0, userMsgJSON(fmt.Sprintf("q-%d", s)), m); err != nil {
					tx.Rollback()
					tb.Fatal(err)
				}
				continue
			}
			// Remaining messages double as mutation candidates: a user text
			// per message at one dense, shared timestamp per session.
			if _, err := tx.ExecContext(ctx, `INSERT INTO message
				(id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)`,
				msgID, sesID, 0, now+int64(s), userMsgJSON(fmt.Sprintf("text-%d-%d", s, m)), m); err != nil {
				tx.Rollback()
				tb.Fatal(err)
			}
		}
		for p := 1; p <= partsPerSession; p++ {
			partID := fmt.Sprintf("%s-p%03d", sesID, p)
			if _, err := tx.ExecContext(ctx, `INSERT INTO part
				(id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				partID, fmt.Sprintf("%s-m001", sesID), sesID, 0, now+int64(s), textPartJSON(fmt.Sprintf("part-%d-%d", s, p)), p); err != nil {
				tx.Rollback()
				tb.Fatal(err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		tb.Fatal(err)
	}
	return storage
}

// ackEverything acknowledges every pending expected id in the cursor.
func ackEverything(tb testing.TB, cs *CursorStore) {
	tb.Helper()
	snap, err := cs.Snapshot()
	if err != nil {
		tb.Fatal(err)
	}
	var ids []string
	for _, s := range snap.File.Sessions {
		for _, pp := range s.Pending {
			ids = append(ids, pp.ExpectedEventIDs...)
		}
	}
	if len(ids) > 0 {
		if _, err := cs.AcknowledgeEventIDs(ids); err != nil {
			tb.Fatal(err)
		}
	}
}

// BenchmarkObserverIdlePollAcknowledgedLargeFixture measures a steady-idle
// poll over the large fixture from a fully acknowledged v2 cursor: bounded
// overlap scans only, no pending writes, no emissions.
func BenchmarkObserverIdlePollAcknowledgedLargeFixture(b *testing.B) {
	storage := buildLargeFixture(b)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := benchObserver(b, storage, cs, rec.fn())
	// Converge: backfill, acknowledge, repeat until a poll is outcome-free.
	for i := 0; i < 20; i++ {
		res := o.pollOnce(context.Background())
		ackEverything(b, cs)
		if i > 0 && !res.HasActiveWork() {
			break
		}
	}
	if pending := countPendingDirect(cs); pending != 0 {
		b.Fatalf("fixture not converged: %d pending remain", pending)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		o.pollOnce(context.Background())
	}
	b.StopTimer()
	if res := o.pollOnce(context.Background()); res.HasActiveWork() {
		b.Fatalf("steady-idle benchmark reported active work: %+v", res)
	}
}

// BenchmarkObserverV1MigrationBackfillLargeFixture measures one full v1
// migration plus backfill pass: cursor reset, scan, page persistence, and
// emission into an in-memory accepting sink.
func BenchmarkObserverV1MigrationBackfillLargeFixture(b *testing.B) {
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		storage := buildLargeFixture(b)
		cursorPath := storage + "/cursor.json"
		v1 := []byte(`{"version":1,"storage_path_hash":"stale","source_id":"` + testSourceID + `","schema_fingerprint":"old","sessions":{"w":{"ack_message_sequence":99}},"last_scan_unix_ms":1}`)
		if err := os.WriteFile(cursorPath, v1, 0o600); err != nil {
			b.Fatal(err)
		}
		cs := NewCursorStoreAt(cursorPath)
		rec := newEmitRecorder()
		o := benchObserver(b, storage, cs, rec.fn())
		b.StartTimer()
		res := o.pollOnce(context.Background())
		if res.Deferred {
			b.Fatalf("backfill deferred: %+v", res)
		}
		if res.Emitted == 0 || res.NewPending == 0 {
			b.Fatalf("backfill produced no work: %+v", res)
		}
	}
}

func countPendingDirect(cs *CursorStore) int {
	snap, err := cs.Snapshot()
	if err != nil {
		return -1
	}
	n := 0
	for _, s := range snap.File.Sessions {
		n += len(s.Pending)
	}
	return n
}

// TestObserver_BackfillPersistCountIsBoundedByPages asserts the durable
// pending-state persistence for a full backfill is bounded by the number of
// prepared pages, never by source-row count.
func TestObserver_BackfillPersistCountIsBoundedByPages(t *testing.T) {
	const messages = 250
	const parts = 1200
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/c", 1, 1, 0)
		insertMessage(ctx, db, "msg-seed", "ses1", 0, 0, 0, userMsgJSON("q"))
		for i := 1; i <= messages; i++ {
			insertMessage(ctx, db, fmt.Sprintf("bm%03d", i), "ses1", i, 1, 1, userMsgJSON(fmt.Sprintf("m-%d", i)))
		}
		for i := 1; i <= parts; i++ {
			insertPart(ctx, db, fmt.Sprintf("bp%04d", i), "msg-seed", "ses1", i, 1, 1, textPartJSON(fmt.Sprintf("p-%d", i)))
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	n := countPersists(cs)
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	res := o.pollOnce(context.Background())
	if res.Deferred {
		t.Fatalf("backfill deferred: %+v", res)
	}
	// Page accounting at the production page sizes:
	//   message insert pages: ceil(250/100)                      = 3
	//   part insert pages:    ceil(1200/500)                     = 3
	//   metadata pages:       discovered + status                = 2
	//   mutation pages:       scanned-only (no records)          = 0
	// plus the enumerated initialization allowance: identity write and the
	// first due LastScan stamp                    = 2
	const msgPages = (250 + messagePageSize - 1) / messagePageSize
	const partPages = (1200 + partPageSize - 1) / partPageSize
	const metaPages = 2
	const mutationPages = 0
	const initAllowance = 2
	want := msgPages + partPages + metaPages + mutationPages + initAllowance
	if got := int(n.Load()); got > want {
		t.Fatalf("backfill persisted %d times, want <= %d (page-bounded, not row-bounded: %d rows)", got, want, messages+parts)
	}
}

// BenchmarkObserverEmitPageLargePending proves the emit phase stays O(page)
// over a session carrying at least 4,000 pending commits: the discarded
// post-persist full hydration is gone, and the counter guard verifies no
// speculative rebuild happens per emit.
func BenchmarkObserverEmitPageLargePending(b *testing.B) {
	const pendingCount = 4000
	const rowsPerPage = 100
	storage := testdb(b)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	wire := WireSessionID(testSourceID, "ses1")
	pending := make(map[string]PendingPosition, pendingCount)
	for i := 0; i < pendingCount; i++ {
		key := fmt.Sprintf("k%04d", i)
		pending[key] = PendingPosition{
			Position:         SourcePosition{Kind: PositionMessageInsert, Order: uint64(i + 1), MessageSequence: int64(i + 1), NativeIDHash: fmt.Sprintf("mh%04d", i)},
			ExpectedEventIDs: []string{fmt.Sprintf("e%04d", i)},
		}
	}
	sess := SessionCursor{StateRevision: 7, Pending: pending, NextCommitOrder: pendingCount + 1}
	rows := make([]preparedRow, rowsPerPage)
	for i := range rows {
		rows[i] = preparedRow{
			Pending: PendingRecord{
				WireSessionID:    wire,
				Position:         SourcePosition{Kind: PositionMessageInsert, MessageSequence: int64(i + 1)},
				ExpectedEventIDs: []string{fmt.Sprintf("e%04d", i)},
			},
			Events: protocolEvents(fmt.Sprintf("e%04d", i)),
		}
	}
	rec := newEmitRecorder()
	o := benchObserver(b, storage, cs, rec.fn())
	plan := pagePlan{rows: rows, scanned: rowsPerPage}
	recorded := RecordedBatch{StateRevision: sess.StateRevision}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st := o.emitPage(wire, plan, recorded)
		if st.emitted != rowsPerPage {
			b.Fatalf("emitted = %d, want %d", st.emitted, rowsPerPage)
		}
	}
	b.StopTimer()
	if got := speculativeHydrations.Load(); got != 0 {
		b.Fatalf("emit phase performed %d speculative hydrations, want 0", got)
	}
}

// protocolEvents builds a minimal DaemonEvent slice for emit-path benchmarks.
func protocolEvents(id string) []protocol.DaemonEvent {
	return []protocol.DaemonEvent{{Type: "user_text", EventID: id, SessionID: "ses-wire"}}
}
