package discovery

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// zcodeTestDB wraps a *sql.DB for fixture creation in the discovery package's
// tests (which cannot reach internal/zcode's unexported testdb helper).
type zcodeTestDB struct {
	db *sql.DB
}

func openZcodeDB(t *testing.T, dsn string) *zcodeTestDB {
	t.Helper()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open fixture db: %v", err)
	}
	return &zcodeTestDB{db: db}
}

func (z *zcodeTestDB) Close() error { return z.db.Close() }

func (z *zcodeTestDB) exec(ctx context.Context, query string) error {
	_, err := z.db.ExecContext(ctx, query)
	return err
}

// zcodeSchemaSQL mirrors the real ZCode schema shape (verified 2026-08-08) for
// the four whitelisted tables. Sanitized — no real content.
var zcodeSchemaSQL = []string{
	`CREATE TABLE session (
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
	)`,
	`CREATE TABLE message (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		time_created INTEGER NOT NULL,
		time_updated INTEGER NOT NULL,
		data TEXT NOT NULL,
		sequence INTEGER
	)`,
	`CREATE TABLE part (
		id TEXT PRIMARY KEY,
		message_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		time_created INTEGER NOT NULL,
		time_updated INTEGER NOT NULL,
		data TEXT NOT NULL,
		sequence INTEGER
	)`,
	`CREATE TABLE todo (
		session_id TEXT NOT NULL,
		content TEXT NOT NULL,
		status TEXT NOT NULL,
		priority TEXT NOT NULL,
		position INTEGER NOT NULL DEFAULT 2,
		time_created INTEGER NOT NULL,
		time_updated INTEGER NOT NULL,
		PRIMARY KEY (session_id, content, position)
	)`,
}
