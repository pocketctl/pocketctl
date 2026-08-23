package zcode

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// cursor.go is the no-content checkpoint for the ZCode observer (schema v2).
// It is the SINGLE authoritative owner of cursor state: callers obtain deep-copy
// snapshots for read boundaries, and every state transition goes through this
// store as a serialized copy-on-write transaction — clone the current state,
// mutate the clone, persist it atomically, and publish the clone only after
// persistence succeeds (persist-before-publish). ACK completion is the only
// path that advances a durable source high-water, and it walks the contiguous
// completed prefix per stream so out-of-order ACKs cannot skip gaps.
//
// Content-free guarantee (design §7.1): the checkpoint NEVER stores prompt,
// text, tool input/output, title or cwd plaintext. It stores only:
//   - storage path hash + source id + schema fingerprint
//   - per-session stream high-waters (numeric positions + hashed native ids)
//   - content-free sync checkpoint (hashes / event ids / revisions / commit order)
//   - pending source positions with their expected/acked event-id sets
//   - last successful scan timestamp
//
// No native session id is stored; only its hash (design §6.4). Raw native ids
// exist only inside a live SQLite query, never in cursor JSON.

const cursorFileName = "zcode-sync-cursor.json"

// CursorVersion is the current on-disk checkpoint schema version. Files with a
// lower version are migrated once (with a 0600 backup); higher versions are
// rejected without being overwritten.
const CursorVersion = 2

// lastScanPersistIntervalMs throttles LastScan-only persistence so idle polls
// do not rewrite the cursor file.
const lastScanPersistIntervalMs int64 = 60_000

// CursorFile is the on-disk checkpoint schema.
type CursorFile struct {
	Version           int                      `json:"version"`
	StoragePathHash   string                   `json:"storage_path_hash"`
	SourceID          string                   `json:"source_id"`
	SchemaFingerprint string                   `json:"schema_fingerprint"`
	Sessions          map[string]SessionCursor `json:"sessions"`
	LastScanUnixMs    int64                    `json:"last_scan_unix_ms"`
}

// PositionKind distinguishes the five independent advancement streams so
// insert and mutation domains can never be mixed.
type PositionKind string

const (
	PositionMetadata        PositionKind = "metadata"
	PositionMessageInsert   PositionKind = "message_insert"
	PositionPartInsert      PositionKind = "part_insert"
	PositionMessageMutation PositionKind = "message_mutation"
	PositionPartMutation    PositionKind = "part_mutation"
)

// SourcePosition identifies one source row within a stream. Order is assigned
// by CursorStore per session and stream and is the authoritative
// contiguous-ACK ordering key; the numeric fields are retained for querying
// and diagnostics.
type SourcePosition struct {
	Kind            PositionKind `json:"kind"`
	Order           uint64       `json:"order"`
	MessageSequence int64        `json:"message_sequence,omitempty"`
	PartMessageSeq  int64        `json:"part_message_sequence,omitempty"`
	PartSequence    int64        `json:"part_sequence,omitempty"`
	MutationTime    int64        `json:"mutation_time,omitempty"`
	NativeIDHash    string       `json:"native_id_hash,omitempty"`
}

// MessageCheckpoint is the content-free projection state of one wire message.
// CommitOrder makes the checkpoint monotonic across the independent insert and
// mutation ACK streams: only a higher order replaces it. Zero-order checkpoints
// are legacy v2 state superseded by the next non-zero commit.
type MessageCheckpoint struct {
	EventID      string `json:"event_id"`
	SemanticHash string `json:"semantic_hash"`
	CommitOrder  uint64 `json:"commit_order"`
}

// PartCheckpoint is the content-free projection state of one wire part.
type PartCheckpoint struct {
	EventID      string `json:"event_id"`
	Revision     int    `json:"revision"`
	SemanticHash string `json:"semantic_hash"`
}

// SyncCheckpoint is the durable restart state for one session's projection.
type SyncCheckpoint struct {
	LastCommitOrder uint64                       `json:"last_commit_order"`
	LastEventID     string                       `json:"last_event_id,omitempty"`
	TitleEventID    string                       `json:"title_event_id,omitempty"`
	TitleHash       string                       `json:"title_hash,omitempty"`
	ModelEventID    string                       `json:"model_event_id,omitempty"`
	ModelHash       string                       `json:"model_hash,omitempty"`
	StatusHash      string                       `json:"status_hash,omitempty"`
	TodoEventID     string                       `json:"todo_event_id,omitempty"`
	TodoHash        string                       `json:"todo_hash,omitempty"`
	SubagentEventID string                       `json:"subagent_event_id,omitempty"`
	Messages        map[string]MessageCheckpoint `json:"messages,omitempty"`
	Parts           map[string]PartCheckpoint    `json:"parts,omitempty"`
	// Turn projection state (review P1-2): survives restarts so a long turn
	// does not lose its anchor outside the overlap window.
	TurnAnchor  string            `json:"turn_anchor,omitempty"`
	TurnEmitted map[string]string `json:"turn_emitted,omitempty"`
	// TurnCommitOrder gates the independently advancing turn projection. It
	// cannot reuse LastCommitOrder because another stream may advance the event
	// chain while an older turn transition is still awaiting ACK.
	TurnCommitOrder uint64 `json:"turn_commit_order,omitempty"`
}

// NamedCommit carries a metadata field update (title/model/todo) inside a
// SyncCommit.
type NamedCommit struct {
	EventID string `json:"event_id"`
	Hash    string `json:"hash"`
}

// MessageCommit carries one message's content-free identity inside a SyncCommit.
type MessageCommit struct {
	WireMessageID string `json:"wire_message_id"`
	EventID       string `json:"event_id"`
	SemanticHash  string `json:"semantic_hash"`
}

// PartCommit carries one part's projected revision inside a SyncCommit.
type PartCommit struct {
	WirePartID   string `json:"wire_part_id"`
	EventID      string `json:"event_id"`
	Revision     int    `json:"revision"`
	SemanticHash string `json:"semantic_hash"`
}

// SyncCommit is the projection delta a pending position applies to the durable
// sync checkpoint when its ACK completes. CommitOrder is assigned by
// CursorStore at record time and applied monotonically.
type SyncCommit struct {
	CommitOrder     uint64         `json:"commit_order"`
	LastEventID     string         `json:"last_event_id,omitempty"`
	Title           *NamedCommit   `json:"title,omitempty"`
	Model           *NamedCommit   `json:"model,omitempty"`
	StatusHash      string         `json:"status_hash,omitempty"`
	Todo            *NamedCommit   `json:"todo,omitempty"`
	SubagentEventID string         `json:"subagent_event_id,omitempty"`
	Message         *MessageCommit `json:"message,omitempty"`
	Part            *PartCommit    `json:"part,omitempty"`
	Turn            *TurnCommit    `json:"turn,omitempty"`
}

// TurnCommit carries the observer's derived turn state transition inside a
// SyncCommit so the canonical projection (and the durable checkpoint) advance
// only when the page's events are acknowledged (review P1-2).
type TurnCommit struct {
	Anchor string `json:"anchor"`
	State  string `json:"state"`
}

// PendingPosition records the events a source position is expected to produce,
// how many have been ACKed, and the projection commit to apply on completion.
// A position is complete when every expected event id is in AckedEventIDs, or
// when it records a skip reason and expects no events.
type PendingPosition struct {
	Position         SourcePosition `json:"position"`
	ExpectedEventIDs []string       `json:"expected_event_ids,omitempty"`
	AckedEventIDs    []string       `json:"acked_event_ids,omitempty"`
	SkippedReason    string         `json:"skipped_reason,omitempty"`
	Commit           SyncCommit     `json:"commit,omitempty"`
	// PayloadDurable marks event-producing positions whose exact payload is
	// durably present in the prepared-event journal. Skip records and legacy
	// v2 entries carry false.
	PayloadDurable bool `json:"payload_durable,omitempty"`
}

// SessionCursor holds the acknowledged + pending state for one session, keyed
// by the wire session id (itself a hash of the native id). StateRevision is
// bumped once per successful transaction that changes this session; a page
// prepared from an older revision is rejected with ErrCursorConflict.
type SessionCursor struct {
	StateRevision            uint64                     `json:"state_revision"`
	AckMessageSequence       int64                      `json:"ack_message_sequence"`
	AckPartMessageSeq        int64                      `json:"ack_part_message_sequence"`
	AckPartSequence          int64                      `json:"ack_part_sequence"`
	AckPartIDHash            string                     `json:"ack_part_id_hash,omitempty"`
	AckMessageMutationTime   int64                      `json:"ack_message_mutation_time"`
	AckMessageMutationIDHash string                     `json:"ack_message_mutation_id_hash,omitempty"`
	AckPartMutationTime      int64                      `json:"ack_part_mutation_time"`
	AckPartMutationIDHash    string                     `json:"ack_part_mutation_id_hash,omitempty"`
	NextOrder                map[PositionKind]uint64    `json:"next_order,omitempty"`
	NextCommitOrder          uint64                     `json:"next_commit_order"`
	Sync                     SyncCheckpoint             `json:"sync"`
	Pending                  map[string]PendingPosition `json:"pending,omitempty"`
}

// CursorIdentity binds the cursor to a storage root / source id / schema.
type CursorIdentity struct {
	StoragePathHash   string
	SourceID          string
	SchemaFingerprint string
}

// PendingRecord is one source-row submission inside a batch. Callers leave
// Position.Order and Commit.CommitOrder zero; the store assigns them.
type PendingRecord struct {
	WireSessionID    string
	Key              string
	Position         SourcePosition
	ExpectedEventIDs []string
	SkippedReason    string
	Commit           SyncCommit
	// PayloadDurable must be true for event-producing records (the prepared
	// journal already holds the exact payload). Skip records leave it false.
	PayloadDurable bool
}

// PendingBatchRequest submits one prepared page for durable recording.
// ExpectedStateRevision must equal the session's revision observed when the
// page was prepared.
type PendingBatchRequest struct {
	WireSessionID         string
	ExpectedStateRevision uint64
	Records               []PendingRecord
}

// RecordedBatch is the canonical result of a recorded page: the store-assigned
// keys, orders, and commit orders the observer must use for accepted pages.
type RecordedBatch struct {
	StateRevision uint64
	Records       []PendingRecord
}

// CursorSnapshot is a deep-copy read view of the authoritative cursor.
type CursorSnapshot struct {
	File CursorFile
}

// Cursor error sentinels.
var (
	// ErrCursorConflict reports a batch prepared from a stale session state
	// revision (an ACK or another page changed the session meanwhile).
	ErrCursorConflict = errors.New("zcode cursor session changed")
	// ErrCursorFutureVersion reports an on-disk cursor from a newer release;
	// the original file must be left untouched.
	ErrCursorFutureVersion = errors.New("zcode cursor version is from a newer release")
	// ErrCursorPartConflict reports an equal-revision part commit whose event
	// id or semantic hash disagrees with the stored checkpoint.
	ErrCursorPartConflict = errors.New("zcode cursor part checkpoint conflict")
	// ErrCursorMessageConflict reports an equal-order message commit whose
	// event id or semantic hash disagrees with the stored checkpoint.
	ErrCursorMessageConflict = errors.New("zcode cursor message checkpoint conflict")
)

// CursorStore owns the only authoritative in-memory cursor. Every mutation is
// a short synchronous transaction under mu: deep-clone, mutate the clone,
// persist atomically (temp + fsync + rename + dir sync), then publish. No
// SQLite query, event enqueue, or external callback may run while mu is held.
type CursorStore struct {
	mu                  sync.Mutex
	path                string
	loaded              bool
	state               CursorFile
	persist             func(CursorFile) error // injected for tests; nil → writeCursor
	lastScanPersistedMs int64                  // LastScanUnixMs value in the last persisted file
}

// NewCursorStore builds a CursorStore rooted at the pocketctl config dir.
func NewCursorStore() (*CursorStore, error) {
	dir, err := config.ConfigDir()
	if err != nil {
		return nil, err
	}
	return &CursorStore{path: filepath.Join(dir, cursorFileName)}, nil
}

// NewCursorStoreAt builds a CursorStore at an explicit path (tests).
func NewCursorStoreAt(path string) *CursorStore {
	return &CursorStore{path: path}
}

// Path returns the checkpoint file path.
func (s *CursorStore) Path() string { return s.path }

// --- load / persist ---------------------------------------------------------

func emptyCursorFile() CursorFile {
	return CursorFile{Version: CursorVersion, Sessions: map[string]SessionCursor{}}
}

// ensureLocked loads the cursor state on first use. A missing file yields an
// empty v2 cursor. A v1 file is migrated once: 0600 backup, identity preserved,
// sessions reset. A future version is rejected without any write. A corrupt
// file is quarantined (.corrupt-<ts>) and reported (fail-closed).
func (s *CursorStore) ensureLoaded() error {
	if s.loaded {
		return nil
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.state = emptyCursorFile()
			s.loaded = true
			return nil
		}
		return err
	}
	var probe struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &probe); err == nil && probe.Version > CursorVersion {
		return fmt.Errorf("%w: %d", ErrCursorFutureVersion, probe.Version)
	}
	if err != nil || probe.Version < CursorVersion {
		// Version 0/1 (or an unparsable header): migrate via the v1 path.
		var v1 struct {
			Version           int    `json:"version"`
			StoragePathHash   string `json:"storage_path_hash"`
			SourceID          string `json:"source_id"`
			SchemaFingerprint string `json:"schema_fingerprint"`
		}
		if jsonErr := json.Unmarshal(data, &v1); jsonErr != nil {
			s.quarantine(data)
			return fmt.Errorf("zcode cursor corrupt: %w", jsonErr)
		}
		backup := s.path + ".v1-backup-" + time.Now().UTC().Format("20060102T150405Z")
		if err := os.WriteFile(backup, data, 0o600); err != nil {
			return fmt.Errorf("zcode cursor v1 backup: %w", err)
		}
		next := emptyCursorFile()
		next.StoragePathHash = v1.StoragePathHash
		next.SourceID = v1.SourceID
		next.SchemaFingerprint = v1.SchemaFingerprint
		if err := s.writeCursor(next); err != nil {
			return err
		}
		s.state = next
		s.lastScanPersistedMs = 0
		s.loaded = true
		return nil
	}
	var cf CursorFile
	if err := json.Unmarshal(data, &cf); err != nil {
		s.quarantine(data)
		return fmt.Errorf("zcode cursor corrupt: %w", err)
	}
	if cf.Sessions == nil {
		cf.Sessions = map[string]SessionCursor{}
	}
	s.state = cf
	s.lastScanPersistedMs = cf.LastScanUnixMs
	s.loaded = true
	return nil
}

// quarantine preserves corrupt bytes as .corrupt-<ts> evidence (fail-closed).
func (s *CursorStore) quarantine(data []byte) {
	ts := time.Now().Format("20060102-150405")
	_ = os.WriteFile(s.path+".corrupt-"+ts, data, 0o600)
}

// writeCursor persists the file atomically: temp file, fsync, chmod 0600,
// rename, then a directory fsync so the rename itself is durable.
func (s *CursorStore) writeCursor(cf CursorFile) error {
	cf.Version = CursorVersion
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cf, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".zcode-cursor.*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return err
	}
	cleanup = false
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// commitLocked persists next and publishes it as the authoritative state. The
// caller must hold mu and have derived next as a deep clone of s.state. A
// persistence failure leaves the published state untouched.
func (s *CursorStore) commitLocked(next CursorFile) error {
	persist := s.persist
	if persist == nil {
		persist = s.writeCursor
	}
	if err := persist(next); err != nil {
		return err
	}
	s.state = next
	s.lastScanPersistedMs = next.LastScanUnixMs
	return nil
}

func scanDue(lastPersistedScan, now int64) bool {
	return now-lastPersistedScan >= lastScanPersistIntervalMs
}

// --- public operations ------------------------------------------------------

// Snapshot returns a deep copy of the authoritative cursor for read
// boundaries. The snapshot is read-only: saving it back is not possible
// through the v2 API.
func (s *CursorStore) Snapshot() (CursorSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return CursorSnapshot{}, err
	}
	return CursorSnapshot{File: cloneCursorFile(s.state)}, nil
}

// RecordPendingBatch durably records one prepared page of pending source
// positions before any of its events are emitted. The batch must carry the
// session's StateRevision observed during preparation; an ACK or competing
// page that changed the session in between yields ErrCursorConflict with no
// persistence. On success the session revision is incremented once and the
// canonical records (assigned keys/orders/commit orders) are returned. An
// entirely identical re-submission is a no-op that merges without erasing
// existing ACKs and without persistence (unless the scan timestamp is due).
func (s *CursorStore) RecordPendingBatch(request PendingBatchRequest, scanUnixMs int64) (RecordedBatch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return RecordedBatch{}, err
	}
	cur, exists := s.state.Sessions[request.WireSessionID]
	if !exists {
		cur = SessionCursor{}
	}
	if request.ExpectedStateRevision != cur.StateRevision {
		return RecordedBatch{}, fmt.Errorf("%w: session %s expected revision %d, have %d",
			ErrCursorConflict, request.WireSessionID, request.ExpectedStateRevision, cur.StateRevision)
	}
	out := RecordedBatch{}
	if len(request.Records) == 0 {
		out.StateRevision = cur.StateRevision
		return out, nil
	}
	next := cloneCursorFile(s.state)
	sess := next.Sessions[request.WireSessionID]
	if sess.Pending == nil {
		sess.Pending = map[string]PendingPosition{}
	}
	if sess.NextOrder == nil {
		sess.NextOrder = map[PositionKind]uint64{}
	}
	changed := false
	for _, rec := range request.Records {
		if rec.WireSessionID != "" && rec.WireSessionID != request.WireSessionID {
			return RecordedBatch{}, fmt.Errorf("zcode cursor: batch record targets session %s, batch targets %s",
				rec.WireSessionID, request.WireSessionID)
		}
		if len(rec.ExpectedEventIDs) == 0 && rec.SkippedReason == "" {
			return RecordedBatch{}, fmt.Errorf("zcode cursor: pending record without events or skip reason")
		}
		if len(rec.ExpectedEventIDs) > 0 && !rec.PayloadDurable {
			return RecordedBatch{}, fmt.Errorf("zcode cursor: event-producing record for %s requires a durable prepared payload", pendingKey(rec))
		}
		key := pendingKey(rec)
		if existing, ok := sess.Pending[key]; ok {
			if existing.SkippedReason == rec.SkippedReason && sameStringSet(existing.ExpectedEventIDs, rec.ExpectedEventIDs) {
				// Identical retry: keep the entry (and its ACK set) as-is.
				out.Records = append(out.Records, canonicalRecord(key, existing))
				continue
			}
			return RecordedBatch{}, fmt.Errorf("zcode cursor: pending key collision for %s", key)
		}
		pos := rec.Position
		pos.Order = nextStreamOrder(&sess, pos.Kind)
		commit := rec.Commit
		if !syncCommitEmpty(commit) {
			commit.CommitOrder = nextCommitOrder(&sess)
		}
		entry := PendingPosition{
			Position:         pos,
			ExpectedEventIDs: dedupSort(rec.ExpectedEventIDs),
			SkippedReason:    rec.SkippedReason,
			Commit:           commit,
			PayloadDurable:   rec.PayloadDurable,
		}
		sess.Pending[key] = entry
		changed = true
		canon := canonicalRecord(key, entry)
		canon.WireSessionID = request.WireSessionID
		out.Records = append(out.Records, canon)
	}
	if !changed {
		// Entire batch was an identical no-op: persist only a due scan stamp.
		if scanDue(s.lastScanPersistedMs, scanUnixMs) {
			next.LastScanUnixMs = scanUnixMs
			if err := s.commitLocked(next); err != nil {
				return RecordedBatch{}, err
			}
		}
		out.StateRevision = cur.StateRevision
		return out, nil
	}
	sess.StateRevision = cur.StateRevision + 1
	next.LastScanUnixMs = scanUnixMs
	next.Sessions[request.WireSessionID] = sess
	// Skipped rows are complete at birth: advance their contiguous prefix in
	// the same cursor transaction so the stream high-water moves past them
	// without waiting for an ACK that will never come (§6.1).
	for _, adv := range planContiguousAdvancement(sess.Pending) {
		if err := applySyncCommit(&sess.Sync, adv.entry.Commit); err != nil {
			return RecordedBatch{}, fmt.Errorf("zcode cursor: session %s key %s: %w", request.WireSessionID, adv.key, err)
		}
		advanceHighWater(&sess, adv.entry.Position)
		delete(sess.Pending, adv.key)
	}
	next.Sessions[request.WireSessionID] = sess
	if err := s.commitLocked(next); err != nil {
		return RecordedBatch{}, err
	}
	out.StateRevision = sess.StateRevision
	return out, nil
}

// AcknowledgeEventIDs marks the given event ids as acked across all sessions
// and advances each stream's durable high-water across the contiguous
// completed prefix only, applying the committed sync checkpoints in commit
// order. It is idempotent for duplicate/unknown ACKs and never crosses a gap.
// Returns the wire session ids whose state changed.
func (s *CursorStore) AcknowledgeEventIDs(ackedEventIDs []string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return nil, err
	}
	if len(ackedEventIDs) == 0 {
		return nil, nil
	}
	ackSet := make(map[string]bool, len(ackedEventIDs))
	for _, id := range ackedEventIDs {
		ackSet[id] = true
	}
	next := cloneCursorFile(s.state)
	var changed []string
	for wireID, sess := range next.Sessions {
		if len(sess.Pending) == 0 {
			continue
		}
		touched := false
		for key, pp := range sess.Pending {
			newAcked := append([]string(nil), pp.AckedEventIDs...)
			for _, eid := range pp.ExpectedEventIDs {
				if ackSet[eid] && !containsStr(newAcked, eid) {
					newAcked = append(newAcked, eid)
					touched = true
				}
			}
			pp.AckedEventIDs = newAcked
			sess.Pending[key] = pp
		}
		for _, adv := range planContiguousAdvancement(sess.Pending) {
			if err := applySyncCommit(&sess.Sync, adv.entry.Commit); err != nil {
				return nil, fmt.Errorf("zcode cursor: session %s key %s: %w", wireID, adv.key, err)
			}
			advanceHighWater(&sess, adv.entry.Position)
			delete(sess.Pending, adv.key)
			touched = true
		}
		if touched {
			sess.StateRevision++
			next.Sessions[wireID] = sess
			changed = append(changed, wireID)
		}
	}
	if len(changed) == 0 {
		return nil, nil
	}
	if err := s.commitLocked(next); err != nil {
		return nil, err
	}
	return changed, nil
}

// UpdateIdentity binds the cursor to the storage root / source id / schema. A
// storage-root or source-id change fully resets sessions; a schema-only change
// resets sessions but keeps the source id. An unchanged identity is a no-op
// and never invalidates sessions.
func (s *CursorStore) UpdateIdentity(identity CursorIdentity) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return err
	}
	cur := s.state
	if cur.StoragePathHash == identity.StoragePathHash &&
		cur.SourceID == identity.SourceID &&
		cur.SchemaFingerprint == identity.SchemaFingerprint {
		return nil
	}
	next := cloneCursorFile(s.state)
	next.StoragePathHash = identity.StoragePathHash
	next.SourceID = identity.SourceID
	next.SchemaFingerprint = identity.SchemaFingerprint
	fullReset := identity.StoragePathHash != cur.StoragePathHash || identity.SourceID != cur.SourceID
	if fullReset || identity.SchemaFingerprint != cur.SchemaFingerprint {
		next.Sessions = map[string]SessionCursor{}
	}
	return s.commitLocked(next)
}

// TouchLastScan records a scan timestamp, throttled to at most one
// LastScan-only persistence per 60 seconds.
func (s *CursorStore) TouchLastScan(scanUnixMs int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return err
	}
	if !scanDue(s.lastScanPersistedMs, scanUnixMs) {
		return nil
	}
	next := cloneCursorFile(s.state)
	next.LastScanUnixMs = scanUnixMs
	return s.commitLocked(next)
}

// --- advancement internals --------------------------------------------------

func nextStreamOrder(sess *SessionCursor, kind PositionKind) uint64 {
	order := sess.NextOrder[kind]
	if order == 0 {
		order = 1
	}
	sess.NextOrder[kind] = order + 1
	return order
}

// nextCommitOrder assigns the next global commit order, starting at 1 so a
// zero CommitOrder unambiguously means "empty commit".
func nextCommitOrder(sess *SessionCursor) uint64 {
	next := sess.NextCommitOrder
	if next == 0 {
		next = 1
	}
	sess.NextCommitOrder = next + 1
	return next
}

func syncCommitEmpty(commit SyncCommit) bool {
	return commit.LastEventID == "" && commit.Title == nil && commit.Model == nil &&
		commit.StatusHash == "" && commit.Todo == nil && commit.SubagentEventID == "" &&
		commit.Message == nil && commit.Part == nil && commit.Turn == nil
}

func canonicalRecord(key string, pp PendingPosition) PendingRecord {
	return PendingRecord{
		Key:              key,
		Position:         pp.Position,
		ExpectedEventIDs: append([]string(nil), pp.ExpectedEventIDs...),
		SkippedReason:    pp.SkippedReason,
		Commit:           pp.Commit,
		PayloadDurable:   pp.PayloadDurable,
	}
}

// pendingKey derives the canonical pending identity:
// kind:hashed-native-id:numeric-source-position:hash(sorted-event-ids-or-skip-reason).
func pendingKey(rec PendingRecord) string {
	var eventHash string
	if len(rec.ExpectedEventIDs) == 0 {
		eventHash = semanticHash(rec.SkippedReason)
	} else {
		ids := append([]string(nil), rec.ExpectedEventIDs...)
		sort.Strings(ids)
		eventHash = semanticHash(strings.Join(ids, ","))
	}
	numeric := fmt.Sprintf("%d:%d:%d:%d",
		rec.Position.MessageSequence, rec.Position.PartMessageSeq,
		rec.Position.PartSequence, rec.Position.MutationTime)
	return fmt.Sprintf("%s:%s:%s:%s", rec.Position.Kind, rec.Position.NativeIDHash, numeric, eventHash)
}

// entryComplete reports whether a pending position has nothing left to wait
// for: every expected event acked, or a durable skip with no events.
func entryComplete(pp PendingPosition) bool {
	if len(pp.ExpectedEventIDs) == 0 {
		return pp.SkippedReason != ""
	}
	return allAcked(pp.ExpectedEventIDs, pp.AckedEventIDs)
}

type pendingAdvancement struct {
	key   string
	entry PendingPosition
}

// planContiguousAdvancement returns, per stream, the contiguous run of
// complete positions starting from the lowest remaining Order, sorted across
// streams by commit order for deterministic application.
func planContiguousAdvancement(pending map[string]PendingPosition) []pendingAdvancement {
	byKind := make(map[PositionKind][]pendingAdvancement)
	for key, pp := range pending {
		byKind[pp.Position.Kind] = append(byKind[pp.Position.Kind], pendingAdvancement{key: key, entry: pp})
	}
	var out []pendingAdvancement
	for _, list := range byKind {
		sort.Slice(list, func(i, j int) bool {
			return list[i].entry.Position.Order < list[j].entry.Position.Order
		})
		for _, adv := range list {
			if !entryComplete(adv.entry) {
				break // gap: later completions are retained, not advanced
			}
			out = append(out, adv)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].entry.Commit.CommitOrder < out[j].entry.Commit.CommitOrder
	})
	return out
}

// applySyncCommit applies one commit to the durable checkpoint. Field-level
// projection state (parts, title, model, todo, status) applies when its entry
// advances: stream-ordered advancement and the revision rule keep each field
// monotonic on its own even when independent streams lag one another. Only
// the cross-stream event chain (LastEventID / LastCommitOrder) is gated by
// the global monotonic commit rule. Recency is decided by revision and commit
// order, never by comparing hashes.
func applySyncCommit(sc *SyncCheckpoint, commit SyncCommit) error {
	if commit.CommitOrder == 0 {
		return nil
	}
	if commit.Part != nil {
		pc := commit.Part
		if existing, ok := sc.Parts[pc.WirePartID]; ok {
			switch {
			case pc.Revision < existing.Revision:
				// Stale commit: keep the newer checkpoint.
			case pc.Revision == existing.Revision:
				if existing.EventID != pc.EventID || existing.SemanticHash != pc.SemanticHash {
					return fmt.Errorf("%w: part %s revision %d has conflicting identity",
						ErrCursorPartConflict, pc.WirePartID, pc.Revision)
				}
			default:
				sc.Parts[pc.WirePartID] = PartCheckpoint{EventID: pc.EventID, Revision: pc.Revision, SemanticHash: pc.SemanticHash}
			}
		} else {
			if sc.Parts == nil {
				sc.Parts = map[string]PartCheckpoint{}
			}
			sc.Parts[pc.WirePartID] = PartCheckpoint{EventID: pc.EventID, Revision: pc.Revision, SemanticHash: pc.SemanticHash}
		}
	}
	if commit.Message != nil {
		updated, err := applyMessageCheckpoint(sc.Messages, commit.Message, commit.CommitOrder)
		if err != nil {
			return err
		}
		sc.Messages = updated
	}
	if commit.Title != nil {
		sc.TitleEventID = commit.Title.EventID
		sc.TitleHash = commit.Title.Hash
	}
	if commit.Model != nil {
		sc.ModelEventID = commit.Model.EventID
		sc.ModelHash = commit.Model.Hash
	}
	if commit.Todo != nil {
		sc.TodoEventID = commit.Todo.EventID
		sc.TodoHash = commit.Todo.Hash
	}
	if commit.StatusHash != "" {
		sc.StatusHash = commit.StatusHash
	}
	if commit.SubagentEventID != "" {
		sc.SubagentEventID = commit.SubagentEventID
	}
	if commit.Turn != nil && commit.Turn.Anchor != "" && commit.Turn.State != "" &&
		commit.CommitOrder > sc.TurnCommitOrder {
		if sc.TurnEmitted == nil {
			sc.TurnEmitted = map[string]string{}
		}
		previous := sc.TurnEmitted[commit.Turn.Anchor]
		if previous == commit.Turn.State || !turn.IsTerminal(previous) {
			sc.TurnEmitted[commit.Turn.Anchor] = commit.Turn.State
			if turn.IsTerminal(commit.Turn.State) {
				if sc.TurnAnchor == commit.Turn.Anchor {
					sc.TurnAnchor = ""
				}
			} else {
				sc.TurnAnchor = commit.Turn.Anchor
			}
		}
		sc.TurnCommitOrder = commit.CommitOrder
	}
	if commit.LastEventID != "" && commit.CommitOrder > sc.LastCommitOrder {
		sc.LastEventID = commit.LastEventID
		sc.LastCommitOrder = commit.CommitOrder
	}
	return nil
}

// applyMessageCheckpoint applies one message commit under the monotonic
// commit-order rule shared by the cursor and the projection: no existing
// checkpoint accepts, higher order replaces, lower order is stale, equal order
// is idempotent for an identical identity and a typed conflict otherwise. A
// zero-order incoming commit is a provisional page proposal that supersedes
// whatever it was previewed against; a zero-order stored checkpoint is legacy
// state superseded by any non-zero commit.
func applyMessageCheckpoint(messages map[string]MessageCheckpoint, mc *MessageCommit, order uint64) (map[string]MessageCheckpoint, error) {
	existing, seen := messages[mc.WireMessageID]
	next := MessageCheckpoint{EventID: mc.EventID, SemanticHash: mc.SemanticHash, CommitOrder: order}
	switch {
	case !seen:
	case order == 0:
		if existing.EventID == mc.EventID && existing.SemanticHash == mc.SemanticHash {
			return messages, nil
		}
	case existing.CommitOrder == 0:
		// Legacy checkpoint: superseded.
	case order > existing.CommitOrder:
	case order < existing.CommitOrder:
		return messages, nil // stale: keep the newer checkpoint
	default: // equal non-zero order
		if existing.EventID == mc.EventID && existing.SemanticHash == mc.SemanticHash {
			return messages, nil // idempotent
		}
		return nil, fmt.Errorf("%w: message %s order %d has conflicting identity",
			ErrCursorMessageConflict, mc.WireMessageID, order)
	}
	if messages == nil {
		messages = map[string]MessageCheckpoint{}
	}
	messages[mc.WireMessageID] = next
	return messages, nil
}

// advanceHighWater moves one stream's durable high-water forward,
// monotonically. Hashes disambiguate a source tuple; they never decide
// recency — Order does, which is why advancement only sees increasing
// positions per stream.
func advanceHighWater(sess *SessionCursor, pos SourcePosition) {
	switch pos.Kind {
	case PositionMessageInsert:
		if pos.MessageSequence > sess.AckMessageSequence {
			sess.AckMessageSequence = pos.MessageSequence
		}
	case PositionPartInsert:
		switch {
		case pos.PartMessageSeq > sess.AckPartMessageSeq:
			sess.AckPartMessageSeq = pos.PartMessageSeq
			sess.AckPartSequence = pos.PartSequence
			sess.AckPartIDHash = pos.NativeIDHash
		case pos.PartMessageSeq == sess.AckPartMessageSeq && pos.PartSequence > sess.AckPartSequence:
			sess.AckPartSequence = pos.PartSequence
			sess.AckPartIDHash = pos.NativeIDHash
		case pos.PartMessageSeq == sess.AckPartMessageSeq && pos.PartSequence == sess.AckPartSequence &&
			pos.NativeIDHash != "" && pos.NativeIDHash != sess.AckPartIDHash:
			// Same numeric tuple, different row: this entry advanced in stream
			// order, so its row is the newer observation at this tuple.
			sess.AckPartIDHash = pos.NativeIDHash
		}
	case PositionMessageMutation:
		switch {
		case pos.MutationTime > sess.AckMessageMutationTime:
			sess.AckMessageMutationTime = pos.MutationTime
			sess.AckMessageMutationIDHash = pos.NativeIDHash
		case pos.MutationTime == sess.AckMessageMutationTime &&
			pos.NativeIDHash != "" && pos.NativeIDHash != sess.AckMessageMutationIDHash:
			sess.AckMessageMutationIDHash = pos.NativeIDHash
		}
	case PositionPartMutation:
		switch {
		case pos.MutationTime > sess.AckPartMutationTime:
			sess.AckPartMutationTime = pos.MutationTime
			sess.AckPartMutationIDHash = pos.NativeIDHash
		case pos.MutationTime == sess.AckPartMutationTime &&
			pos.NativeIDHash != "" && pos.NativeIDHash != sess.AckPartMutationIDHash:
			sess.AckPartMutationIDHash = pos.NativeIDHash
		}
	case PositionMetadata:
		// Metadata has no numeric high-water.
	}
}

// --- deep copy --------------------------------------------------------------

func cloneCursorFile(cf CursorFile) CursorFile {
	out := cf
	if cf.Sessions != nil {
		out.Sessions = make(map[string]SessionCursor, len(cf.Sessions))
		for id, sc := range cf.Sessions {
			out.Sessions[id] = cloneSessionCursor(sc)
		}
	}
	return out
}

func cloneSessionCursor(sc SessionCursor) SessionCursor {
	out := sc
	if sc.NextOrder != nil {
		out.NextOrder = make(map[PositionKind]uint64, len(sc.NextOrder))
		for k, v := range sc.NextOrder {
			out.NextOrder[k] = v
		}
	}
	if sc.Pending != nil {
		out.Pending = make(map[string]PendingPosition, len(sc.Pending))
		for k, pp := range sc.Pending {
			out.Pending[k] = clonePendingPosition(pp)
		}
	}
	out.Sync.Parts = clonePartCheckpoints(sc.Sync.Parts)
	out.Sync.Messages = cloneMessageCheckpoints(sc.Sync.Messages)
	if sc.Sync.TurnEmitted != nil {
		out.Sync.TurnEmitted = make(map[string]string, len(sc.Sync.TurnEmitted))
		for anchor, state := range sc.Sync.TurnEmitted {
			out.Sync.TurnEmitted[anchor] = state
		}
	}
	return out
}

func clonePendingPosition(pp PendingPosition) PendingPosition {
	out := pp
	out.ExpectedEventIDs = append([]string(nil), pp.ExpectedEventIDs...)
	out.AckedEventIDs = append([]string(nil), pp.AckedEventIDs...)
	if pp.Commit.Title != nil {
		c := *pp.Commit.Title
		out.Commit.Title = &c
	}
	if pp.Commit.Model != nil {
		c := *pp.Commit.Model
		out.Commit.Model = &c
	}
	if pp.Commit.Todo != nil {
		c := *pp.Commit.Todo
		out.Commit.Todo = &c
	}
	if pp.Commit.Part != nil {
		c := *pp.Commit.Part
		out.Commit.Part = &c
	}
	if pp.Commit.Message != nil {
		c := *pp.Commit.Message
		out.Commit.Message = &c
	}
	if pp.Commit.Turn != nil {
		c := *pp.Commit.Turn
		out.Commit.Turn = &c
	}
	return out
}

func clonePartCheckpoints(parts map[string]PartCheckpoint) map[string]PartCheckpoint {
	if parts == nil {
		return nil
	}
	out := make(map[string]PartCheckpoint, len(parts))
	for k, v := range parts {
		out[k] = v
	}
	return out
}

func cloneMessageCheckpoints(messages map[string]MessageCheckpoint) map[string]MessageCheckpoint {
	if messages == nil {
		return nil
	}
	out := make(map[string]MessageCheckpoint, len(messages))
	for k, v := range messages {
		out[k] = v
	}
	return out
}

// --- helpers ----------------------------------------------------------------

func allAcked(expected, acked []string) bool {
	if len(expected) == 0 {
		return false
	}
	set := make(map[string]bool, len(acked))
	for _, a := range acked {
		set[a] = true
	}
	for _, e := range expected {
		if !set[e] {
			return false
		}
	}
	return true
}

func containsStr(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func dedupSort(xs []string) []string {
	seen := make(map[string]bool, len(xs))
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	sort.Strings(out)
	return out
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	set := make(map[string]bool, len(a))
	for _, x := range a {
		set[x] = true
	}
	for _, x := range b {
		if !set[x] {
			return false
		}
	}
	return true
}

// StoragePathHash returns a stable hash of a normalized storage path, used to
// bind the cursor to a storage root.
func StoragePathHash(storageDir string) string {
	h := sha256.Sum256([]byte(filepath.Clean(storageDir)))
	return hex.EncodeToString(h[:16])
}
