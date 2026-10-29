package teamdelivery

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"time"

	_ "modernc.org/sqlite"
)

const maxJournalBytes = 256 * 1024 * 1024

var ErrSnapshotMissing = errors.New("delivery_snapshot_missing")
var ErrPublicationRetired = errors.New("delivery_publication_already_confirmed")

// Journal belongs in daemon-private storage, outside every Agent workspace.
// Scope includes Relay origin, daemon ID, and owner ID; switching accounts or
// Relay installations cannot resume another identity's pending publication.
type Journal struct{ db *sql.DB }

func OpenJournal(root, scope string) (*Journal, error) {
	if !filepath.IsAbs(root) || scope == "" {
		return nil, fmt.Errorf("delivery_journal_scope_invalid")
	}
	digest := sha256.Sum256([]byte(scope))
	dir := filepath.Join(root, hex.EncodeToString(digest[:]))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("delivery_journal_directory_invalid")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	file := filepath.Join(dir, "snapshots.db")
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err == nil {
		_ = f.Close()
	} else if !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	info, err = os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("delivery_journal_file_invalid")
	}
	db, err := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: filepath.ToSlash(file)}).String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	// Rollback journal + FULL durability ensure a returned Save survives a
	// process crash. A competing process fails/retries instead of overwriting.
	_, err = db.Exec(`PRAGMA busy_timeout=1000;
PRAGMA synchronous=FULL;
PRAGMA secure_delete=ON;
CREATE TABLE IF NOT EXISTS delivery_snapshots (
 call_id TEXT PRIMARY KEY,
 payload BLOB NOT NULL,
 digest TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_publications (
 call_id TEXT PRIMARY KEY,
 version INTEGER NOT NULL,
 payload BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_retired (
 call_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 submission_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 confirmed_at INTEGER NOT NULL
);`)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Journal{db: db}, nil
}

func (j *Journal) Close() error { return j.db.Close() }

func readSnapshot(row interface{ Scan(...any) error }) (*Snapshot, error) {
	var payload []byte
	var digest string
	if err := row.Scan(&payload, &digest); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrSnapshotMissing
		}
		return nil, err
	}
	hash := sha256.Sum256(payload)
	if len(payload) > 48*1024*1024 || hex.EncodeToString(hash[:]) != digest {
		return nil, fmt.Errorf("delivery_journal_corrupt")
	}
	var snapshot Snapshot
	if err := decodeStrict(payload, &snapshot); err != nil {
		return nil, err
	}
	if err := snapshot.validate(); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func (j *Journal) Load(ctx context.Context, callID string) (*Snapshot, error) {
	return readSnapshot(j.db.QueryRowContext(ctx, `SELECT payload,digest FROM delivery_snapshots WHERE call_id=?`, callID))
}

func (j *Journal) Retired(ctx context.Context, callID string) (bool, error) {
	var count int
	err := j.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM delivery_retired WHERE call_id=?`, callID).Scan(&count)
	return count != 0, err
}

// Save is first-writer-wins. Even after local files change, a retry returns the
// originally committed bytes and request. The returned value must be used.
func (j *Journal) Save(ctx context.Context, snapshot *Snapshot) (*Snapshot, error) {
	if snapshot == nil {
		return nil, fmt.Errorf("delivery_snapshot_invalid")
	}
	if err := snapshot.validate(); err != nil {
		return nil, err
	}
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var retired int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM delivery_retired WHERE call_id=?`, snapshot.Job.CallID).Scan(&retired); err != nil {
		return nil, err
	}
	if retired != 0 {
		return nil, ErrPublicationRetired
	}
	existing, err := readSnapshot(tx.QueryRowContext(ctx, `SELECT payload,digest FROM delivery_snapshots WHERE call_id=?`, snapshot.Job.CallID))
	if err == nil {
		// The same Call cannot migrate to another task/spec or native binding.
		a, b := existing.Job, snapshot.Job
		if a.TaskID != b.TaskID || a.AttemptID != b.AttemptID || a.SpecRevision != b.SpecRevision || a.NativeSessionID != b.NativeSessionID ||
			a.Provider != b.Provider || a.DeliveryRole != b.DeliveryRole || !reflect.DeepEqual(a.Authorization, b.Authorization) {
			return nil, fmt.Errorf("delivery_snapshot_source_changed")
		}
		return existing, nil
	}
	if !errors.Is(err, ErrSnapshotMissing) {
		return nil, err
	}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	var used int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(length(payload)),0) FROM delivery_snapshots`).Scan(&used); err != nil {
		return nil, err
	}
	if used+int64(len(payload)) > maxJournalBytes {
		return nil, fmt.Errorf("delivery_journal_limit")
	}
	hash := sha256.Sum256(payload)
	_, err = tx.ExecContext(ctx, `INSERT INTO delivery_snapshots(call_id,payload,digest,created_at) VALUES(?,?,?,?)`,
		snapshot.Job.CallID, payload, hex.EncodeToString(hash[:]), time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	// Decode a copy: a caller changing its input after Save must not mutate the
	// bytes used by this publication attempt either.
	var stored Snapshot
	if err := json.Unmarshal(payload, &stored); err != nil {
		return nil, err
	}
	return &stored, nil
}
