package zcode

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// testdb builds a fresh, fully sanitized SQLite fixture at <dir>/db/db.sqlite
// using the SAME modernc.org/sqlite driver the Store uses. It creates the four
// whitelisted tables (session/message/part/todo) with the real schema shape
// (verified against ~/.zcode/cli/db/db.sqlite on 2026-08-08). No real session
// content is used — every value is synthetic test data.
//
// It returns the storage directory (the parent of db/), so Store.Open can be
// pointed at it exactly as it would be at ~/.zcode/cli.
func testdb(t testing.TB, opts ...testdbOpt) string {
	t.Helper()
	cfg := testdbConfig{}
	for _, o := range opts {
		o(&cfg)
	}
	storage := t.TempDir()
	dbDir := filepath.Join(storage, "db")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(dbDir, "db.sqlite")
	dsn := "file:" + dbPath + "?_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open fixture db: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	exec := func(q string) {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatalf("fixture exec: %v\nquery: %s", err, q)
		}
	}
	exec(`CREATE TABLE session (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		workspace_id TEXT,
		parent_id TEXT,
		slug TEXT NOT NULL,
		directory TEXT NOT NULL,
		path TEXT,
		title TEXT NOT NULL,
		version TEXT NOT NULL,
		share_url TEXT,
		summary_additions INTEGER,
		summary_deletions INTEGER,
		summary_files INTEGER,
		summary_diffs TEXT,
		revert TEXT,
		permission TEXT,
		time_created INTEGER NOT NULL,
		time_updated INTEGER NOT NULL,
		time_compacting INTEGER,
		time_archived INTEGER,
		task_type TEXT NOT NULL DEFAULT 'interactive',
		title_source TEXT NOT NULL DEFAULT 'first_input',
		title_message_id TEXT,
		time_title_updated INTEGER,
		trace_id TEXT
	)`)
	exec(`CREATE TABLE message (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		time_created INTEGER NOT NULL,
		time_updated INTEGER NOT NULL,
		data TEXT NOT NULL,
		sequence INTEGER
	)`)
	exec(`CREATE TABLE part (
		id TEXT PRIMARY KEY,
		message_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		time_created INTEGER NOT NULL,
		time_updated INTEGER NOT NULL,
		data TEXT NOT NULL,
		sequence INTEGER
	)`)
	exec(`CREATE TABLE todo (
		session_id TEXT NOT NULL,
		content TEXT NOT NULL,
		status TEXT NOT NULL,
		priority TEXT NOT NULL,
		position INTEGER NOT NULL DEFAULT 2,
		time_created INTEGER NOT NULL,
		time_updated INTEGER NOT NULL,
		PRIMARY KEY (session_id, content, position)
	)`)
	if cfg.seed != nil {
		cfg.seed(ctx, db)
	}
	return storage
}

type testdbConfig struct {
	seed func(context.Context, *sql.DB)
}

type testdbOpt func(*testdbConfig)

func withSeed(seed func(context.Context, *sql.DB)) testdbOpt {
	return func(c *testdbConfig) { c.seed = seed }
}

// --- minimal sanitized seed helpers (no real content) ---

func insertSession(ctx context.Context, db *sql.DB, id, title, directory string, created, updated int64, archived int64) {
	if archived == 0 {
		archived = 0
	}
	_, err := db.ExecContext(ctx, `INSERT INTO session
		(id, project_id, directory, slug, title, version, time_created, time_updated, time_archived)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, "proj", directory, "s"+id, title, "v1", created, updated, archived)
	if err != nil {
		panic(fmt.Sprintf("insert session: %v", err))
	}
}

func nowMillis() int64 { return time.Now().UnixMilli() }

// insertMessage inserts a message row. dataJSON must already be valid JSON; the
// caller controls the shape (this is the sanitized fixture, not real content).
func insertMessage(ctx context.Context, db *sql.DB, id, sessionID string, sequence int, created, updated int64, dataJSON string) {
	_, err := db.ExecContext(ctx, `INSERT INTO message
		(id, session_id, time_created, time_updated, data, sequence)
		VALUES (?, ?, ?, ?, ?, ?)`,
		id, sessionID, created, updated, dataJSON, sequence)
	if err != nil {
		panic(fmt.Sprintf("insert message: %v", err))
	}
}

func insertPart(ctx context.Context, db *sql.DB, id, messageID, sessionID string, sequence int, created, updated int64, dataJSON string) {
	_, err := db.ExecContext(ctx, `INSERT INTO part
		(id, message_id, session_id, time_created, time_updated, data, sequence)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, messageID, sessionID, created, updated, dataJSON, sequence)
	if err != nil {
		panic(fmt.Sprintf("insert part: %v", err))
	}
}
