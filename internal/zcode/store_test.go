package zcode

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestStoreOpenProbeSuccess(t *testing.T) {
	storage := testdb(t)
	s, err := Open(storage)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if err := s.Probe(context.Background()); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if s.Fingerprint() == "" {
		t.Fatal("Fingerprint empty after Probe")
	}
}

func TestStoreReadOnlyRejectsWrite(t *testing.T) {
	storage := testdb(t)
	s, err := Open(storage)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	ctx := context.Background()
	// CREATE TABLE must fail under query_only=ON.
	if _, err := s.DB().ExecContext(ctx, "CREATE TABLE should_fail (x INTEGER)"); err == nil {
		t.Fatal("CREATE TABLE succeeded on a read-only store")
	}
	// UPDATE must fail.
	if _, err := s.DB().ExecContext(ctx, "UPDATE session SET title='x' WHERE 1=0"); err == nil {
		t.Fatal("UPDATE succeeded on a read-only store")
	}
	// INSERT must fail.
	if _, err := s.DB().ExecContext(ctx, "INSERT INTO session(id) VALUES(null)"); err == nil {
		t.Fatal("INSERT succeeded on a read-only store")
	}
}

func TestStoreWALCommittedRowVisible(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t)
	s, err := Open(storage)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Open a writable connection to the same DB file (simulating ZCode writing
	// + WAL commit) and confirm the read-only store sees the committed row.
	dbPath := filepath.Join(storage, dbRelPath)
	wdb, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatalf("open writable: %v", err)
	}
	defer wdb.Close()
	insertSession(ctx, wdb, "ses_wal_1", "title", "/cwd", nowMillis(), nowMillis(), 0)

	var got string
	if err := s.DB().QueryRowContext(ctx, "SELECT id FROM session WHERE id = ?", "ses_wal_1").Scan(&got); err != nil {
		t.Fatalf("read-only store did not see WAL-committed row: %v", err)
	}
	if got != "ses_wal_1" {
		t.Fatalf("got %q want ses_wal_1", got)
	}
}

func TestStoreSchemaMissingRequiredTable(t *testing.T) {
	storage := testdb(t)
	dbPath := filepath.Join(storage, dbRelPath)
	wdb, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open writable: %v", err)
	}
	defer wdb.Close()
	if _, err := wdb.ExecContext(context.Background(), "DROP TABLE todo"); err != nil {
		t.Fatal(err)
	}
	s, err := Open(storage)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if err := s.Probe(context.Background()); err == nil {
		t.Fatal("Probe should fail when a required table is missing")
	}
}

func TestStoreStorageNotFoundTyped(t *testing.T) {
	_, err := Open(filepath.Join(t.TempDir(), "missing"))
	if err == nil {
		t.Fatal("Open missing storage should error")
	}
	if !errors.Is(err, ErrStorageNotFound) {
		t.Fatalf("err = %v, want wrap ErrStorageNotFound", err)
	}
}

func TestStoreStorageIsDirectoryTyped(t *testing.T) {
	dir := t.TempDir()
	dbDir := filepath.Join(dir, "db")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// make db.sqlite a directory → not a regular file.
	if err := os.MkdirAll(filepath.Join(dbDir, "db.sqlite"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := Open(dir)
	if err == nil {
		t.Fatal("Open with directory db should error")
	}
	if !errors.Is(err, ErrStorageInaccessible) && !errors.Is(err, ErrStorageNotFound) {
		t.Fatalf("err = %v, want wrap ErrStorage(Inaccessible|NotFound)", err)
	}
}

func TestWireSessionID_FixedLengthStableIsolated(t *testing.T) {
	src := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // 32 hex
	native := "ses_abc"
	w1 := WireSessionID(src, native)
	if len(w1) != 38 {
		t.Fatalf("wire id len = %d, want 38 (got %q)", len(w1), w1)
	}
	if !strings.HasPrefix(w1, "zcode-") {
		t.Fatalf("wire id must start with zcode-: %q", w1)
	}
	if w1 == native {
		t.Fatal("wire id must not equal native id")
	}
	if len(w1) > 64 {
		t.Fatal("wire id exceeds Relay VARCHAR(64)")
	}
	if WireSessionID(src, native) != w1 {
		t.Fatal("wire id not stable for same source+native")
	}
	src2 := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	w2 := WireSessionID(src2, native)
	if w2 == w1 {
		t.Fatal("different source id must yield different wire id for same native")
	}
	if len(w2) != 38 {
		t.Fatalf("wire id 2 len = %d, want 38", len(w2))
	}
	w3 := WireSessionID(src, "ses_other")
	if w3 == w1 {
		t.Fatal("different native must yield different wire id")
	}
}

// --- Task 4: paging + filter tests ----------------------------------------

func TestListSessions_RecentAndAllPagination(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		// three sessions with distinct time_updated
		insertSession(ctx, db, "s_old", "old", "/o", now-10*24*60*60*1000, now-10*24*60*60*1000, 0)
		insertSession(ctx, db, "s_mid", "mid", "/m", now-5*24*60*60*1000, now-5*24*60*60*1000, 0)
		insertSession(ctx, db, "s_new", "new", "/n", now, now, 0)
	}))
	s, err := Open(storage)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// all scope: all three, newest first.
	page, err := s.ListSessions(ctx, HistoryScopeAll, 0, nil, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Sessions) != 3 || page.Sessions[0].ID != "s_new" {
		t.Fatalf("all scope order/len = %+v", page.Sessions)
	}
	// recent scope with 7-day lookback: only s_new (now) and s_mid (5d); s_old (10d) excluded.
	page, err = s.ListSessions(ctx, HistoryScopeRecent, 7, nil, 10)
	if err != nil {
		t.Fatal(err)
	}
	ids := make(map[string]bool, len(page.Sessions))
	for _, r := range page.Sessions {
		ids[r.ID] = true
	}
	if ids["s_old"] || !ids["s_new"] || !ids["s_mid"] {
		t.Fatalf("recent 7d scope = %+v", ids)
	}
}

func TestListSessions_KeysetPaging(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		for i := 0; i < 5; i++ {
			insertSession(ctx, db, "s"+itoa2(i), "t", "/d", now+int64(i), now+int64(i), 0)
		}
	}))
	s, _ := Open(storage)
	defer s.Close()
	// page size 2: newest two first.
	p1, err := s.ListSessions(ctx, HistoryScopeAll, 0, nil, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(p1.Sessions) != 2 || p1.NextCursor == nil {
		t.Fatalf("p1 = %+v", p1)
	}
	p2, err := s.ListSessions(ctx, HistoryScopeAll, 0, p1.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(p2.Sessions) != 2 || p2.NextCursor == nil {
		t.Fatalf("p2 = %+v", p2)
	}
	p3, err := s.ListSessions(ctx, HistoryScopeAll, 0, p2.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(p3.Sessions) != 1 || p3.NextCursor != nil {
		t.Fatalf("p3 = %+v", p3)
	}
}

// TestUploadOrderContract fixes the content-upload ordering contract:
//   - sessions discovered by time_updated DESC (most recently active first)
//   - within a session, messages by sequence ASC (conversation chronological order)
//   - within a message, parts by (message.sequence, part.sequence, part.id) ASC
//
// A ZCode observer backfill therefore surfaces your freshest session first, and
// inside any session the dialogue reads top-to-bottom in the order it happened.
func TestUploadOrderContract(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		base := nowMillis()
		// Three sessions with distinct last-activity times.
		insertSession(ctx, db, "old", "t", "/d", base-3000, base-3000, 0) // least recent
		insertSession(ctx, db, "mid", "t", "/d", base-2000, base-2000, 0)
		insertSession(ctx, db, "new", "t", "/d", base-1000, base-1000, 0) // most recent
		// In "new": three messages inserted out of sequence order.
		insertMessage(ctx, db, "m3", "new", 3, base, base, `{"role":"assistant"}`)
		insertMessage(ctx, db, "m1", "new", 1, base, base, `{"role":"user"}`)
		insertMessage(ctx, db, "m2", "new", 2, base, base, `{"role":"assistant"}`)
	}))
	s, err := Open(storage)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// Sessions: most recently active first (new, mid, old).
	page, err := s.ListSessions(ctx, HistoryScopeAll, 0, nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	wantSess := []string{"new", "mid", "old"}
	for i, w := range wantSess {
		if page.Sessions[i].ID != w {
			t.Fatalf("session[%d] = %s, want %s (DESC by time_updated)", i, page.Sessions[i].ID, w)
		}
	}

	// Messages within "new": sequence ASC (1, 2, 3), i.e. chronological.
	mp, err := s.ListMessages(ctx, "new", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	wantMsg := []int64{1, 2, 3}
	for i, w := range wantMsg {
		if mp.Messages[i].Sequence != w {
			t.Fatalf("message[%d].seq = %d, want %d (ASC conversation order)", i, mp.Messages[i].Sequence, w)
		}
	}
}

func TestListParts_CompositeCursorHandlesDuplicatePartSequence(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "t", "/d", now, now, 0)
		// One message, sequence=1.
		insertMessage(ctx, db, "m1", "ses1", 1, now, now, `{"role":"assistant"}`)
		// Two parts with the SAME sequence=1 but different ids (the verified
		// duplicate-part.sequence case). Composite cursor must return both.
		insertPart(ctx, db, "p1a", "m1", "ses1", 1, now, now, `{"type":"text","text":"a"}`)
		insertPart(ctx, db, "p1b", "m1", "ses1", 1, now, now, `{"type":"text","text":"b"}`)
		// Another message sequence=2 with one part.
		insertMessage(ctx, db, "m2", "ses1", 2, now, now, `{"role":"assistant"}`)
		insertPart(ctx, db, "p2a", "m2", "ses1", 1, now, now, `{"type":"text","text":"c"}`)
	}))
	s, _ := Open(storage)
	defer s.Close()
	page, err := s.ListParts(ctx, "ses1", nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Parts) != 3 {
		t.Fatalf("want 3 parts, got %d", len(page.Parts))
	}
	// Order: (m.seq=1,p.seq=1,p.id=p1a), (1,1,p1b), (2,1,p2a).
	want := []string{"p1a", "p1b", "p2a"}
	for i, w := range want {
		if page.Parts[i].ID != w {
			t.Fatalf("part[%d] = %s, want %s (full: %+v)", i, page.Parts[i].ID, w, page.Parts)
		}
	}
}

func TestListChangedParts_DetectsInPlaceUpdate(t *testing.T) {
	ctx := context.Background()
	seedNow := nowMillis()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "ses1", "t", "/d", seedNow, seedNow, 0)
		insertMessage(ctx, db, "m1", "ses1", 1, seedNow, seedNow, `{"role":"assistant"}`)
		// A part in pending state at sequence=1.
		insertPart(ctx, db, "p1", "m1", "ses1", 1, seedNow, seedNow, `{"type":"tool","state":"pending"}`)
	}))
	s, _ := Open(storage)
	defer s.Close()
	dbPath := filepath.Join(storage, dbRelPath)
	wdb, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer wdb.Close()
	// Simulate the SAME part transitioning pending→completed at the same
	// sequence (only time_updated + data change).
	later := seedNow + 5000
	if _, err := wdb.ExecContext(ctx, "UPDATE part SET time_updated=?, data=? WHERE id=?", later, `{"type":"tool","state":"completed"}`, "p1"); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListChangedParts(ctx, "ses1", MutationCursor{TimeUpdated: seedNow}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Parts) != 1 || page.Parts[0].ID != "p1" {
		t.Fatalf("ListChangedParts did not return the mutated part: %+v", page)
	}
}

func TestListMessages_SequenceOrder(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "t", "/d", now, now, 0)
		insertMessage(ctx, db, "m3", "ses1", 3, now, now, `{"role":"assistant"}`)
		insertMessage(ctx, db, "m1", "ses1", 1, now, now, `{"role":"user"}`)
		insertMessage(ctx, db, "m2", "ses1", 2, now, now, `{"role":"assistant"}`)
	}))
	s, _ := Open(storage)
	defer s.Close()
	page, err := s.ListMessages(ctx, "ses1", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{1, 2, 3}
	for i, w := range want {
		if page.Messages[i].Sequence != w {
			t.Fatalf("msg[%d].seq = %d, want %d", i, page.Messages[i].Sequence, w)
		}
	}
}

func TestListTodos(t *testing.T) {
	ctx := context.Background()
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "t", "/d", now, now, 0)
		mustExec(ctx, db, "INSERT INTO todo(session_id,content,status,priority,position,time_created,time_updated) VALUES(?,?,?,?,?,?,?)",
			"ses1", "do a", "pending", "high", 1, now, now)
		mustExec(ctx, db, "INSERT INTO todo(session_id,content,status,priority,position,time_created,time_updated) VALUES(?,?,?,?,?,?,?)",
			"ses1", "do b", "completed", "normal", 2, now, now)
	}))
	s, _ := Open(storage)
	defer s.Close()
	todos, err := s.ListTodos(ctx, "ses1")
	if err != nil {
		t.Fatal(err)
	}
	if len(todos) != 2 || todos[0].Position != 1 || todos[1].Position != 2 {
		t.Fatalf("todos = %+v", todos)
	}
}

func TestListSessions_ContextDeadlineEnforced(t *testing.T) {
	storage := testdb(t)
	s, _ := Open(storage)
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled
	if _, err := s.ListSessions(ctx, HistoryScopeAll, 0, nil, 10); err == nil {
		t.Fatal("cancelled context should error")
	}
}

// itoa2 is a tiny local int→string helper for test seeding.
func itoa2(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}

func mustExec(ctx context.Context, db *sql.DB, query string, args ...any) {
	if _, err := db.ExecContext(ctx, query, args...); err != nil {
		panic(err)
	}
}
