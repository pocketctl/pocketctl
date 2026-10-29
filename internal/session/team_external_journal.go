package session

import (
	"bytes"
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

	_ "modernc.org/sqlite"
)

var (
	ErrExternalMissing  = errors.New("team_external_request_missing")
	ErrExternalConflict = errors.New("team_external_journal_conflict")
	ErrExternalCorrupt  = errors.New("team_external_journal_corrupt")
)

// ExternalJournal must live in daemon-private storage outside Agent workspaces.
// Saving an intent does not authorize dispatch; the coordinator rechecks grants.
// One database per installation scope prevents cross-account recovery.
type ExternalJournal struct {
	db    *sql.DB
	scope string
}

func OpenExternalJournal(root, scope string) (*ExternalJournal, error) {
	return openExternalJournal(root, scope, true)
}

func openExternalJournal(root, scope string, create bool) (*ExternalJournal, error) {
	if !filepath.IsAbs(root) || !externalIdentifier(scope) {
		return nil, ErrExternalIdentity
	}
	digest := sha256.Sum256([]byte(scope))
	dir := filepath.Join(root, hex.EncodeToString(digest[:]))
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrExternalIdentity
	}
	if err = os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	file := filepath.Join(dir, "external-executions.db")
	if create {
		f, createErr := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if createErr == nil {
			_ = f.Close()
		} else if !errors.Is(createErr, os.ErrExist) {
			return nil, createErr
		}
	}
	info, err = os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, ErrExternalIdentity
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(file)}).String()
	if !create {
		dsn += "?mode=rw"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA busy_timeout=1000;
 PRAGMA synchronous=FULL;
 PRAGMA secure_delete=ON;
 CREATE TABLE IF NOT EXISTS external_executions(
 call_id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 request BLOB NOT NULL,
 request_digest TEXT NOT NULL,
 remote_task_id TEXT UNIQUE,
 receipt BLOB,
 receipt_digest TEXT
 );
 CREATE TABLE IF NOT EXISTS external_dispatch_claims(call_id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS external_revocations(call_id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS external_retry_confirmations(confirmation_id TEXT PRIMARY KEY,call_id TEXT NOT NULL);`)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &ExternalJournal{db: db, scope: scope}, nil
}
func (j *ExternalJournal) Close() error { return j.db.Close() }
func externalPayloadDigest(payload []byte) string {
	d := sha256.Sum256(payload)
	return hex.EncodeToString(d[:])
}

// SaveIntent commits before any network request. Replaying the same intent is
// allowed; changing any identity, bytes or cost limit for its Call is rejected.
func (j *ExternalJournal) SaveIntent(ctx context.Context, r ExternalExecutionRequest) error {
	if r.Identity.Scope != j.scope {
		return ErrExternalIdentity
	}
	if err := validateExternalStoredRequest(r); err != nil {
		return err
	}
	payload, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = j.db.ExecContext(ctx, `INSERT INTO external_executions(call_id,request_id,request,request_digest) VALUES(?,?,?,?) ON CONFLICT DO NOTHING`, r.Identity.CallID, r.Identity.RequestID, payload, externalPayloadDigest(payload))
	if err != nil {
		return err
	}
	stored, _, err := j.Load(ctx, r.Identity.CallID)
	if errors.Is(err, ErrExternalMissing) {
		return ErrExternalConflict
	}
	if err != nil {
		return err
	}
	saved, _ := json.Marshal(stored)
	if !bytes.Equal(saved, payload) {
		return ErrExternalConflict
	}
	return nil
}

func validateExternalStoredRequest(r ExternalExecutionRequest) error {
	// This checks immutable data only; current provider capabilities must be
	// checked separately immediately before dispatch, never inferred from disk.
	if len(r.Input) > 4*1024*1024 {
		return ErrExternalIdentity
	}
	return r.Validate(ExternalCapabilities{IdempotentSubmit: true, LookupByRequest: true, Cancellation: true, ArtifactExport: true, HardCostLimit: true, CostReporting: true})
}

type externalJournalRow struct {
	request    ExternalExecutionRequest
	receipt    *ExternalExecutionReceipt
	rawReceipt []byte
}

func (j *ExternalJournal) read(row interface{ Scan(...any) error }, callID string) (externalJournalRow, error) {
	var result externalJournalRow
	var raw []byte
	var digest string
	var remote, receiptDigest sql.NullString
	if err := row.Scan(&raw, &digest, &remote, &result.rawReceipt, &receiptDigest); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return result, ErrExternalMissing
		}
		return result, err
	}
	if len(raw) > 6*1024*1024 || externalPayloadDigest(raw) != digest || json.Unmarshal(raw, &result.request) != nil {
		return result, ErrExternalCorrupt
	}
	if validateExternalStoredRequest(result.request) != nil || result.request.Identity.Scope != j.scope || result.request.Identity.CallID != callID {
		return result, ErrExternalCorrupt
	}
	if result.rawReceipt != nil {
		if len(result.rawReceipt) > 16*1024 || !receiptDigest.Valid || externalPayloadDigest(result.rawReceipt) != receiptDigest.String {
			return result, ErrExternalCorrupt
		}
		var receipt ExternalExecutionReceipt
		if json.Unmarshal(result.rawReceipt, &receipt) != nil || !remote.Valid || receipt.RemoteTaskID != remote.String {
			return result, ErrExternalCorrupt
		}
		if _, err := ReconcileExternalReceipt(result.request, nil, receipt); err != nil {
			return result, ErrExternalCorrupt
		}
		result.receipt = &receipt
	} else if remote.Valid || receiptDigest.Valid {
		return result, ErrExternalCorrupt
	}
	return result, nil
}
func (j *ExternalJournal) Load(ctx context.Context, callID string) (ExternalExecutionRequest, *ExternalExecutionReceipt, error) {
	if !externalIdentifier(callID) {
		return ExternalExecutionRequest{}, nil, ErrExternalIdentity
	}
	row, err := j.read(j.db.QueryRowContext(ctx, `SELECT request,request_digest,remote_task_id,receipt,receipt_digest FROM external_executions WHERE call_id=?`, callID), callID)
	return row.request, row.receipt, err
}

// RecordReceipt uses compare-and-swap across processes, not just an in-memory
// lock. On contention callers reload/reconcile; they must not resubmit remotely.
func (j *ExternalJournal) RecordReceipt(ctx context.Context, next ExternalExecutionReceipt) (ExternalExecutionReceipt, error) {
	if next.Identity.Scope != j.scope {
		return ExternalExecutionReceipt{}, ErrExternalIdentity
	}
	row, err := j.read(j.db.QueryRowContext(ctx, `SELECT request,request_digest,remote_task_id,receipt,receipt_digest FROM external_executions WHERE call_id=?`, next.Identity.CallID), next.Identity.CallID)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	reconciled, err := ReconcileExternalReceipt(row.request, row.receipt, next)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	payload, err := json.Marshal(reconciled)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if bytes.Equal(payload, row.rawReceipt) {
		return reconciled, nil
	}
	var previous any
	if row.rawReceipt != nil {
		previous = row.rawReceipt
	}
	result, err := j.db.ExecContext(ctx, `UPDATE external_executions SET remote_task_id=?,receipt=?,receipt_digest=? WHERE call_id=? AND receipt IS ?`, reconciled.RemoteTaskID, payload, externalPayloadDigest(payload), next.Identity.CallID, previous)
	if err != nil {
		return ExternalExecutionReceipt{}, fmt.Errorf("external receipt persistence: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if count != 1 {
		return ExternalExecutionReceipt{}, ErrExternalConflict
	}
	return reconciled, nil
}

// claimSubmission is never cleared on timeout or process restart. Once claimed,
// recovery must query the original remote request, not start another attempt.
func (j *ExternalJournal) claimSubmission(ctx context.Context, callID string) (bool, error) {
	result, err := j.db.ExecContext(ctx, `INSERT INTO external_dispatch_claims(call_id)
 SELECT call_id FROM external_executions WHERE call_id=? AND NOT EXISTS(SELECT 1 FROM external_revocations WHERE call_id=?)
 ON CONFLICT DO NOTHING`, callID, callID)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}
func (j *ExternalJournal) revoked(ctx context.Context, callID string) (bool, error) {
	var count int
	err := j.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM external_revocations WHERE call_id=?`, callID).Scan(&count)
	return count > 0, err
}
func (j *ExternalJournal) revoke(ctx context.Context, callID string) error {
	if !externalIdentifier(callID) {
		return ErrExternalIdentity
	}
	_, err := j.db.ExecContext(ctx, `INSERT INTO external_revocations(call_id) VALUES(?) ON CONFLICT DO NOTHING`, callID)
	return err
}

// Each explicit confirmation can submit at most once, including after restart.
// Its Call binding is immutable; distinct confirmations still use the same remote
// idempotency key and require a fresh authoritative not-found lookup.
func (j *ExternalJournal) claimRetry(ctx context.Context, callID, confirmationID string) (bool, error) {
	if !externalIdentifier(confirmationID) {
		return false, ErrExternalIdentity
	}
	result, err := j.db.ExecContext(ctx, `INSERT INTO external_retry_confirmations(confirmation_id,call_id)
 SELECT ?,call_id FROM external_executions WHERE call_id=? AND receipt IS NULL
 AND EXISTS(SELECT 1 FROM external_dispatch_claims WHERE call_id=?)
 AND NOT EXISTS(SELECT 1 FROM external_revocations WHERE call_id=?) ON CONFLICT DO NOTHING`, confirmationID, callID, callID, callID)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 1 {
		return true, nil
	}
	var stored string
	err = j.db.QueryRowContext(ctx, `SELECT call_id FROM external_retry_confirmations WHERE confirmation_id=?`, confirmationID).Scan(&stored)
	if err == nil && stored != callID {
		return false, ErrExternalConflict
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	return false, nil
}
