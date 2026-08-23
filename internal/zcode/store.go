package zcode

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	_ "modernc.org/sqlite" // pure-Go SQLite driver; no CGO
)

// Storage-relative location of the canonical ZCode session DB.
const (
	dbRelPath        = "db/db.sqlite"
	queryTimeout     = 2 * time.Second
	busyTimeoutMs    = 500
	schemaVersionKey = "schema_fingerprint"
)

// Schema error sentinels — typed so callers (observer / discovery / CLI) can
// branch on them without parsing strings.
var (
	ErrStorageNotFound     = errors.New("zcode storage not found")
	ErrStorageInaccessible = errors.New("zcode storage inaccessible")
	ErrSchemaIncompatible  = errors.New("zcode schema incompatible")
	ErrDatabaseCorrupt     = errors.New("zcode database corrupt")
	ErrDatabaseBusy        = errors.New("zcode database busy")
)

// requiredColumns is the minimum column set Store accepts per table (see design
// §5.3). Extra columns are tolerated; missing required columns are not.
var requiredColumns = map[string][]string{
	"session": {"id", "title", "directory", "time_created", "time_updated", "time_archived"},
	"message": {"id", "session_id", "data", "sequence"},
	"part":    {"id", "message_id", "session_id", "data", "sequence"},
	"todo":    {"session_id", "content", "status", "priority", "position"},
}

// Store is a read-only handle to the ZCode session SQLite database. It owns a
// single sql.DB connection configured mode=ro + query_only, and never writes.
// All queries carry a per-call context deadline (default 2s).
type Store struct {
	db           *sql.DB
	storageDir   string
	fingerprint  string // canonical schema fingerprint (sorted table→columns)
	queryTimeout time.Duration
}

// Option configures a Store (mainly for tests to inject shorter timeouts).
type Option func(*Store)

// WithQueryTimeout overrides the default per-query timeout.
func WithQueryTimeout(d time.Duration) Option {
	return func(s *Store) { s.queryTimeout = d }
}

// Open opens the ZCode DB at <storageDir>/db/db.sqlite in read-only mode. It
// validates that the path is a regular file (not a directory/device), that the
// current user can read it, and that the connection is read-only. It does NOT
// require db.sqlite-wal to exist (the driver reads the WAL view itself) and does
// NOT use immutable=1 (which would ignore an active WAL).
func Open(storageDir string, opts ...Option) (*Store, error) {
	abs, err := filepath.Abs(storageDir)
	if err != nil {
		return nil, fmt.Errorf("resolve storage dir: %w", err)
	}
	dbPath := filepath.Join(abs, dbRelPath)
	info, err := os.Stat(dbPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s", ErrStorageNotFound, dbPath)
		}
		return nil, fmt.Errorf("%w: %s", ErrStorageInaccessible, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%w: %s is a directory", ErrStorageInaccessible, dbPath)
	}
	if err := checkReadable(dbPath); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrStorageInaccessible, err)
	}

	// mode=ro + query_only via PRAGMA after open. _pragma query_only is set in
	// the DSN where supported; modernc honors the `?_pragma=query_only(on)` form
	// via its _pragma query param, but to be robust across driver builds we also
	// execute PRAGMA query_only=ON immediately after Open (see probe).
	q := url.Values{}
	q.Set("mode", "ro")
	q.Set("_pragma", "busy_timeout("+strconv.Itoa(busyTimeoutMs)+")")
	dsn := "file:" + dbPath + "?" + q.Encode()

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	s := &Store{
		db:           db,
		storageDir:   abs,
		queryTimeout: queryTimeout,
	}
	for _, o := range opts {
		o(s)
	}
	// Enforce read-only at the connection level immediately. A failure here means
	// the driver/DB rejected the pragma — treat as incompatible (fail-closed).
	ctx, cancel := context.WithTimeout(context.Background(), s.queryTimeout)
	defer cancel()
	if _, err := db.ExecContext(ctx, "PRAGMA query_only=ON"); err != nil {
		db.Close()
		return nil, fmt.Errorf("%w: cannot set query_only: %s", ErrSchemaIncompatible, err)
	}
	return s, nil
}

// Close releases the database handle.
func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

// StorageDir returns the absolute storage directory the store was opened from.
func (s *Store) StorageDir() string { return s.storageDir }

// Fingerprint returns the canonical schema fingerprint (stable across
// reordered columns). Computed by Probe and cached.
func (s *Store) Fingerprint() string { return s.fingerprint }

// Probe validates the schema against the required-column whitelist and computes
// the canonical schema fingerprint. It reads ONLY PRAGMA table_info (metadata),
// never message/part content. Returns ErrSchemaIncompatible if any required
// table or column is missing.
func (s *Store) Probe(ctx context.Context) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	var parts []string
	for _, table := range []string{"session", "message", "part", "todo"} {
		cols, err := s.tableColumns(ctx, table)
		if err != nil {
			return err
		}
		have := make(map[string]bool, len(cols))
		for _, c := range cols {
			have[c] = true
		}
		for _, want := range requiredColumns[table] {
			if !have[want] {
				return fmt.Errorf("%w: table %s missing column %s", ErrSchemaIncompatible, table, want)
			}
		}
		parts = append(parts, table+"("+strings.Join(cols, ",")+")")
	}
	s.fingerprint = fingerprintStrings(parts)
	return nil
}

// tableColumns returns the column names of a table in storage order, via
// PRAGMA table_info (metadata only — no row data, no SELECT *).
func (s *Store) tableColumns(ctx context.Context, table string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s)", quoteIdent(table)))
	if err != nil {
		return nil, fmt.Errorf("%w: table_info %s: %s", ErrSchemaIncompatible, table, err)
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return nil, fmt.Errorf("%w: scan table_info %s: %s", ErrSchemaIncompatible, table, err)
		}
		cols = append(cols, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: table_info %s: %s", ErrSchemaIncompatible, table, err)
	}
	if len(cols) == 0 {
		return nil, fmt.Errorf("%w: table %s missing or empty", ErrSchemaIncompatible, table)
	}
	return cols, nil
}

// DB exposes the underlying handle for the higher-layer Store methods (List*
// queries) added in a later task. Callers MUST treat it as read-only; the
// connection has query_only=ON enforced.
func (s *Store) DB() *sql.DB { return s.db }

// QueryTimeout returns the per-query deadline used by the higher-layer methods.
func (s *Store) QueryTimeout() time.Duration { return s.queryTimeout }

// --- wire session id -----------------------------------------------------

// WireSessionID computes the fixed-length (38-char) wire session id for a native
// ZCode session id under a given source id:
//
//	"zcode-" + sha256(source_id || 0x00 || native)[:32hex]   (6 + 32 = 38)
//
// It never reveals the native id, never exceeds Relay's VARCHAR(64), and is
// stable across restarts (same source_id + native → same wire id). Different
// source ids (different storage roots) yield different wire ids even for the
// same native id.
func WireSessionID(sourceID, nativeSessionID string) string {
	h := sha256.New()
	h.Write([]byte(sourceID))
	h.Write([]byte{0x00})
	h.Write([]byte(nativeSessionID))
	sum := h.Sum(nil)
	return "zcode-" + hex.EncodeToString(sum[:16]) // "zcode-" (6) + 32 hex = 38
}

// NativeSessionIDHash returns a short hex hash of a native session id, suitable
// for storing in the checkpoint (which must not hold the native id in plaintext).
func NativeSessionIDHash(nativeSessionID string) string {
	h := sha256.Sum256([]byte(nativeSessionID))
	return hex.EncodeToString(h[:8])
}

// --- paged read API ------------------------------------------------------
//
// The Store exposes small-batch, keyset-paged readers. Each returns only the
// whitelisted fields the mapper needs; raw JSON is decoded inside the method and
// never escapes into logs or checkpoints. See design §5.4 (read whitelist) and
// §7.2 (ranges / cursors).

// HistoryScope selects the session discovery range.
type HistoryScope int

const (
	HistoryScopeRecent HistoryScope = iota
	HistoryScopeAll
)

// SessionRow is the whitelisted projection of a session row. ParentID is
// non-empty for subagent (child) sessions; the observer uses it to emit
// subagent_discovered events linking the child to its parent.
type SessionRow struct {
	ID           string
	Title        string
	Directory    string
	TimeCreated  int64
	TimeUpdated  int64
	TimeArchived int64  // 0 = not archived
	ParentID     string // non-empty for subagent child sessions
	TaskType     string // "interactive" (root) or "subagent_child"
}

// SessionPage is one page of session discovery, ordered by time_updated DESC.
type SessionPage struct {
	Sessions   []SessionRow
	NextCursor *SessionPageCursor // nil when exhausted
}

// SessionPageCursor is a keyset cursor for session discovery (time_updated
// DESC, then id DESC for stability).
type SessionPageCursor struct {
	TimeUpdated int64
	ID          string
}

// MessageRow is the whitelisted projection of a message row. DataJSON is the
// raw data column (decoded by the mapper, which enforces the content filter).
type MessageRow struct {
	ID          string
	SessionID   string
	Sequence    int64
	TimeUpdated int64
	DataJSON    string
}

// MessagePage is one page of messages, ordered by sequence ASC.
type MessagePage struct {
	Messages     []MessageRow
	NextSequence int64 // 0 when exhausted
}

// PartCursor is the composite keyset cursor for parts within a session:
// (message.sequence, part.sequence, part.id). It tolerates duplicate
// part.sequence within a session (verified 2026-08-08) by including part.id as
// the final tiebreaker.
type PartCursor struct {
	MessageSequence int64
	PartSequence    int64
	PartID          string
}

// PartRow is the whitelisted projection of a part row, augmented with its
// parent message's sequence (needed for the composite cursor and stable
// ordering).
type PartRow struct {
	ID              string
	MessageID       string
	SessionID       string
	Sequence        int64
	MessageSequence int64
	TimeUpdated     int64
	DataJSON        string
}

// PartPage is one page of parts.
type PartPage struct {
	Parts      []PartRow
	NextCursor *PartCursor // nil when exhausted
}

// MutationCursor is the (time_updated, id) keyset used to detect in-place
// mutations (a part changing pending→completed at the same sequence).
type MutationCursor struct {
	TimeUpdated int64
	ID          string
}

// TodoRow is the whitelisted projection of a todo row.
type TodoRow struct {
	SessionID string
	Content   string
	Status    string
	Priority  string
	Position  int64
}

// ListSessions discovers sessions within the configured range, ordered by
// time_updated DESC, keyset-paged. recent scope filters to
// time_updated >= now-lookbackDays; archived rows are still returned if within
// the window. lookbackDays is only used for the recent scope.
func (s *Store) ListSessions(ctx context.Context, scope HistoryScope, lookbackDays int, after *SessionPageCursor, limit int) (SessionPage, error) {
	if limit <= 0 {
		limit = 50
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	var (
		args  []any
		where []string
	)
	if scope == HistoryScopeRecent && lookbackDays > 0 {
		cutoff := time.Now().UnixMilli() - int64(lookbackDays)*24*60*60*1000
		where = append(where, "time_updated >= ?")
		args = append(args, cutoff)
	}
	if after != nil {
		where = append(where, "(time_updated < ? OR (time_updated = ? AND id < ?))")
		args = append(args, after.TimeUpdated, after.TimeUpdated, after.ID)
	}
	query := "SELECT id, title, directory, time_created, time_updated, time_archived, parent_id, task_type FROM session"
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY time_updated DESC, id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return SessionPage{}, classifyQueryErr(err)
	}
	defer rows.Close()
	var page SessionPage
	for rows.Next() {
		var r SessionRow
		var archived sql.NullInt64
		var parentID, taskType sql.NullString
		if err := rows.Scan(&r.ID, &r.Title, &r.Directory, &r.TimeCreated, &r.TimeUpdated, &archived, &parentID, &taskType); err != nil {
			return SessionPage{}, classifyQueryErr(err)
		}
		if archived.Valid {
			r.TimeArchived = archived.Int64
		}
		if parentID.Valid {
			r.ParentID = parentID.String
		}
		if taskType.Valid {
			r.TaskType = taskType.String
		}
		page.Sessions = append(page.Sessions, r)
	}
	if err := rows.Err(); err != nil {
		return SessionPage{}, classifyQueryErr(err)
	}
	if len(page.Sessions) > limit {
		last := page.Sessions[limit-1]
		page.NextCursor = &SessionPageCursor{TimeUpdated: last.TimeUpdated, ID: last.ID}
		page.Sessions = page.Sessions[:limit]
	}
	return page, nil
}

// ListMessages returns messages for a session ordered by sequence ASC, paged
// after afterSequence.
func (s *Store) ListMessages(ctx context.Context, sessionID string, afterSequence int64, limit int) (MessagePage, error) {
	if limit <= 0 {
		limit = 100
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, session_id, sequence, time_updated, data FROM message WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
		sessionID, afterSequence, limit+1)
	if err != nil {
		return MessagePage{}, classifyQueryErr(err)
	}
	defer rows.Close()
	var page MessagePage
	for rows.Next() {
		var r MessageRow
		if err := rows.Scan(&r.ID, &r.SessionID, &r.Sequence, &r.TimeUpdated, &r.DataJSON); err != nil {
			return MessagePage{}, classifyQueryErr(err)
		}
		page.Messages = append(page.Messages, r)
	}
	if err := rows.Err(); err != nil {
		return MessagePage{}, classifyQueryErr(err)
	}
	if len(page.Messages) > limit {
		page.NextSequence = page.Messages[limit-1].Sequence
		page.Messages = page.Messages[:limit]
	}
	return page, nil
}

// ListParts returns parts for a session ordered by the composite key
// (message.sequence, part.sequence, part.id), paged by PartCursor. It JOINs
// message to obtain message.sequence so duplicate part.sequence within a session
// is handled deterministically.
func (s *Store) ListParts(ctx context.Context, sessionID string, after *PartCursor, limit int) (PartPage, error) {
	if limit <= 0 {
		limit = 500
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	query := `SELECT p.id, p.message_id, p.session_id, p.sequence, m.sequence, p.time_updated, p.data
		FROM part p JOIN message m ON p.message_id = m.id
		WHERE p.session_id = ?`
	args := []any{sessionID}
	if after != nil {
		query += ` AND (
			m.sequence > ?
			OR (m.sequence = ? AND p.sequence > ?)
			OR (m.sequence = ? AND p.sequence = ? AND p.id > ?)
		)`
		args = append(args, after.MessageSequence, after.MessageSequence, after.PartSequence, after.MessageSequence, after.PartSequence, after.PartID)
	}
	query += " ORDER BY m.sequence ASC, p.sequence ASC, p.id ASC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return PartPage{}, classifyQueryErr(err)
	}
	defer rows.Close()
	var page PartPage
	for rows.Next() {
		var r PartRow
		if err := rows.Scan(&r.ID, &r.MessageID, &r.SessionID, &r.Sequence, &r.MessageSequence, &r.TimeUpdated, &r.DataJSON); err != nil {
			return PartPage{}, classifyQueryErr(err)
		}
		page.Parts = append(page.Parts, r)
	}
	if err := rows.Err(); err != nil {
		return PartPage{}, classifyQueryErr(err)
	}
	if len(page.Parts) > limit {
		last := page.Parts[limit-1]
		page.NextCursor = &PartCursor{MessageSequence: last.MessageSequence, PartSequence: last.Sequence, PartID: last.ID}
		page.Parts = page.Parts[:limit]
	}
	return page, nil
}

// ListChangedMessages returns messages updated after the mutation cursor
// (time_updated, id), ordered ASC so the caller sees oldest changes first. Used
// to detect in-place message completion/error/title edits at the same sequence.
func (s *Store) ListChangedMessages(ctx context.Context, sessionID string, after MutationCursor, limit int) (MessagePage, error) {
	if limit <= 0 {
		limit = 100
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, session_id, sequence, time_updated, data FROM message WHERE session_id = ? AND (time_updated > ? OR (time_updated = ? AND id > ?)) ORDER BY time_updated ASC, id ASC LIMIT ?",
		sessionID, after.TimeUpdated, after.TimeUpdated, after.ID, limit+1)
	if err != nil {
		return MessagePage{}, classifyQueryErr(err)
	}
	defer rows.Close()
	var page MessagePage
	for rows.Next() {
		var r MessageRow
		if err := rows.Scan(&r.ID, &r.SessionID, &r.Sequence, &r.TimeUpdated, &r.DataJSON); err != nil {
			return MessagePage{}, classifyQueryErr(err)
		}
		page.Messages = append(page.Messages, r)
	}
	if err := rows.Err(); err != nil {
		return MessagePage{}, classifyQueryErr(err)
	}
	if len(page.Messages) > limit {
		page.NextSequence = 0 // mutation paging is by MutationCursor, not sequence; caller uses last row's time_updated/id
		page.Messages = page.Messages[:limit]
	}
	return page, nil
}

// ListChangedParts returns parts updated after the mutation cursor, ordered ASC.
// Used to detect a part changing pending→completed at the same sequence.
func (s *Store) ListChangedParts(ctx context.Context, sessionID string, after MutationCursor, limit int) (PartPage, error) {
	if limit <= 0 {
		limit = 500
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	query := `SELECT p.id, p.message_id, p.session_id, p.sequence, m.sequence, p.time_updated, p.data
		FROM part p JOIN message m ON p.message_id = m.id
		WHERE p.session_id = ? AND (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?))
		ORDER BY p.time_updated ASC, p.id ASC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, query, sessionID, after.TimeUpdated, after.TimeUpdated, after.ID, limit+1)
	if err != nil {
		return PartPage{}, classifyQueryErr(err)
	}
	defer rows.Close()
	var page PartPage
	for rows.Next() {
		var r PartRow
		if err := rows.Scan(&r.ID, &r.MessageID, &r.SessionID, &r.Sequence, &r.MessageSequence, &r.TimeUpdated, &r.DataJSON); err != nil {
			return PartPage{}, classifyQueryErr(err)
		}
		page.Parts = append(page.Parts, r)
	}
	if err := rows.Err(); err != nil {
		return PartPage{}, classifyQueryErr(err)
	}
	if len(page.Parts) > limit {
		page.Parts = page.Parts[:limit]
	}
	return page, nil
}

// ListTodos returns the current todo snapshot for a session.
func (s *Store) ListTodos(ctx context.Context, sessionID string) ([]TodoRow, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT session_id, content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position ASC",
		sessionID)
	if err != nil {
		return nil, classifyQueryErr(err)
	}
	defer rows.Close()
	var out []TodoRow
	for rows.Next() {
		var t TodoRow
		if err := rows.Scan(&t.SessionID, &t.Content, &t.Status, &t.Priority, &t.Position); err != nil {
			return nil, classifyQueryErr(err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// QueryLastAssistantFinish returns the finish value of the most recent assistant
// message in a session ("" if none / user / running). This is a lightweight
// single-row query used for status derivation without paging all messages.
func (s *Store) QueryLastAssistantFinish(ctx context.Context, sessionID string) string {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	var finish sql.NullString
	_ = s.db.QueryRowContext(ctx,
		`SELECT json_extract(data, '$.finish') FROM message
		 WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
		 ORDER BY sequence DESC LIMIT 1`, sessionID).Scan(&finish)
	if finish.Valid {
		return finish.String
	}
	return ""
}

// QueryLastToolStatus returns the state.status of the most recent tool part in a
// session ("" if none). Lightweight single-row query for status derivation.
func (s *Store) QueryLastToolStatus(ctx context.Context, sessionID string) string {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.queryTimeout)
		defer cancel()
	}
	var status sql.NullString
	_ = s.db.QueryRowContext(ctx,
		`SELECT json_extract(data, '$.state.status') FROM part
		 WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
		 ORDER BY time_created DESC LIMIT 1`, sessionID).Scan(&status)
	if status.Valid {
		return status.String
	}
	return ""
}

// classifyQueryErr maps a driver error to a typed sentinel so the observer can
// branch (e.g. SQLITE_BUSY → skip the round) without parsing strings.
func classifyQueryErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	msg := err.Error()
	if strings.Contains(msg, "locked") || strings.Contains(msg, "busy") {
		return fmt.Errorf("%w: %s", ErrDatabaseBusy, msg)
	}
	return err
}

// --- helpers --------------------------------------------------------------

func checkReadable(path string) error {
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	return f.Close()
}

func fingerprintStrings(parts []string) string {
	// Deterministic regardless of map iteration: caller passes already-ordered
	// parts (tables in a fixed order, columns in storage order).
	joined := strings.Join(parts, "|")
	h := sha256.Sum256([]byte(joined))
	return hex.EncodeToString(h[:16])
}

func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// DefaultStorageDir returns the default ZCode storage directory using
// config.HomeDir (mirrors resolveDefaultStorageDir but exported for discovery).
func DefaultStorageDir() string {
	return resolveDefaultStorageDir()
}

// ResolveStorageDirFromEnv mirrors ResolveStorageDir but is used by discovery to
// resolve the storage dir without a full Config (e.g. just an env override).
func ResolveStorageDirFromEnv(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if env := os.Getenv(zcodeStorageEnvVar); env != "" {
		return env
	}
	return DefaultStorageDir()
}

// HomeConfigDir re-exports the pocketctl config dir for discovery; returns "" on
// error. Kept here to avoid discovery→zcode import of config internals.
func HomeConfigDir() string {
	dir, err := config.ConfigDir()
	if err != nil {
		return ""
	}
	return dir
}
