package zcode

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
)

// cursor.go is the no-content checkpoint for the ZCode observer. It persists
// pending source-position → expected-eventID mappings and acknowledged cursor
// state, so a crash at any point (pending write / enqueue / spool / ACK) can be
// recovered by re-reading the DB from the acknowledged position. Relay dedups
// via stable EventIDs.
//
// Content-free guarantee (design §7.1): the checkpoint NEVER stores prompt,
// text, tool input/output, title or cwd plaintext. It stores only:
//   - storage path hash + source id
//   - schema fingerprint
//   - per-session last acknowledged message sequence + composite part cursor
//   - per-session mutation cursor (time_updated, id hash)
//   - per-session hash/event id/revision of the last mutable part, title, model
//   - pending position → expected eventID set + hash/revision
//   - last successful scan timestamp
//
// No native session id is stored; only its hash (design §6.4).

const cursorFileName = "zcode-sync-cursor.json"

// CursorFile is the on-disk checkpoint schema (version 1).
type CursorFile struct {
	Version           int                      `json:"version"`
	StoragePathHash   string                   `json:"storage_path_hash"`
	SourceID          string                   `json:"source_id"`
	SchemaFingerprint string                   `json:"schema_fingerprint"`
	Sessions          map[string]SessionCursor `json:"sessions"`
	LastScanUnixMs    int64                    `json:"last_scan_unix_ms"`
}

// SessionCursor holds the acknowledged + pending state for one session, keyed
// by the wire session id (which is itself a hash of the native id).
type SessionCursor struct {
	// Acknowledged high-water for append-only discovery.
	AckMessageSequence int64 `json:"ack_message_sequence"`
	// Composite part insert cursor (acknowledged).
	AckPartMessageSeq int64  `json:"ack_part_message_seq"`
	AckPartSeq        int64  `json:"ack_part_seq"`
	AckPartIDHash     string `json:"ack_part_id_hash"`
	// Mutation cursor (time_updated, id hash) for in-place updates.
	AckMutationTime   int64  `json:"ack_mutation_time"`
	AckMutationIDHash string `json:"ack_mutation_id_hash"`
	// Hashes of the last-seen title/model/todo (content-free comparison).
	TitleHash string `json:"title_hash"`
	ModelHash string `json:"model_hash"`
	TodoHash  string `json:"todo_hash"`
	// Pending positions not yet fully ACKed: position key → expected eventIDs.
	Pending map[string]PendingPosition `json:"pending,omitempty"`
}

// PendingPosition records the events a source position is expected to produce,
// and how many of them have been ACKed. A position is "delivered" when all its
// expected eventIDs are in AckedEventIDs.
type PendingPosition struct {
	ExpectedEventIDs []string `json:"expected_event_ids"`
	AckedEventIDs    []string `json:"acked_event_ids"`
	// Reason code for a position that produced no events (filtered/skipped).
	SkippedReason string `json:"skipped_reason,omitempty"`
}

// CursorStore loads/saves the checkpoint atomically with 0600 perms.
type CursorStore struct {
	path string
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
func (c *CursorStore) Path() string { return c.path }

// Load reads the checkpoint. A missing file yields an empty CursorFile (no
// error). A corrupt file is quarantined (.corrupt-<ts>) and an empty file +
// error are returned (fail-closed).
func (c *CursorStore) Load() (CursorFile, error) {
	data, err := os.ReadFile(c.path)
	if err != nil {
		if os.IsNotExist(err) {
			return CursorFile{Version: 1, Sessions: map[string]SessionCursor{}}, nil
		}
		return CursorFile{Version: 1, Sessions: map[string]SessionCursor{}}, err
	}
	var cf CursorFile
	if err := json.Unmarshal(data, &cf); err != nil {
		ts := time.Now().Format("20060102-150405")
		_ = os.WriteFile(c.path+".corrupt-"+ts, data, 0o600)
		return CursorFile{Version: 1, Sessions: map[string]SessionCursor{}}, fmt.Errorf("zcode cursor corrupt: %w", err)
	}
	if cf.Sessions == nil {
		cf.Sessions = map[string]SessionCursor{}
	}
	return cf, nil
}

// Save writes the checkpoint atomically with 0600 perms (temp + rename).
func (c *CursorStore) Save(cf CursorFile) error {
	if cf.Sessions == nil {
		cf.Sessions = map[string]SessionCursor{}
	}
	cf.Version = 1
	dir := filepath.Dir(c.path)
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
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, c.path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// ResetForSource clears all session cursors when the storage root or source id
// changes, preserving only the new identity. A schema-fingerprint change resets
// cursors but keeps source id / wire ids (design §7.4).
func (c *CursorStore) ResetForSource(cf *CursorFile, storagePathHash, sourceID, schemaFingerprint string, schemaOnly bool) {
	if schemaOnly {
		// Schema changed: reset cursors, keep source id / wire ids (dedup via
		// stable EventIDs handles re-scan).
		cf.SchemaFingerprint = schemaFingerprint
		cf.Sessions = map[string]SessionCursor{}
		return
	}
	cf.StoragePathHash = storagePathHash
	cf.SourceID = sourceID
	cf.SchemaFingerprint = schemaFingerprint
	cf.Sessions = map[string]SessionCursor{}
}

// RecordPending persists a pending position BEFORE the observer enqueues its
// events. enqueue is NOT a durable boundary: the cursor is only advanced when
// the position is fully ACKed.
func (c *CursorStore) RecordPending(cf *CursorFile, wireSessionID, positionKey string, expectedEventIDs []string, skippedReason string) error {
	s := cf.Sessions[wireSessionID]
	if s.Pending == nil {
		s.Pending = map[string]PendingPosition{}
	}
	s.Pending[positionKey] = PendingPosition{
		ExpectedEventIDs: dedupSort(expectedEventIDs),
		SkippedReason:    skippedReason,
	}
	cf.Sessions[wireSessionID] = s
	return c.Save(*cf)
}

// AcknowledgeEventIDs marks the given eventIDs as acked across all sessions and
// advances the acknowledged high-water only for positions whose entire expected
// set is acked (and any skipped positions in a contiguous run). It is idempotent
// for duplicate/unknown ACKs and never crosses a gap.
//
// It returns the set of wireSessionIDs whose state changed (so the observer can
// re-snapshot if needed).
func (c *CursorStore) AcknowledgeEventIDs(cf *CursorFile, ackedEventIDs []string) ([]string, error) {
	ackSet := make(map[string]bool, len(ackedEventIDs))
	for _, id := range ackedEventIDs {
		ackSet[id] = true
	}
	var changed []string
	for wireID, s := range cf.Sessions {
		if len(s.Pending) == 0 {
			continue
		}
		modified := false
		// Mark acked events within each pending position.
		for pos, pp := range s.Pending {
			newAcked := append([]string(nil), pp.AckedEventIDs...)
			for _, eid := range pp.ExpectedEventIDs {
				if ackSet[eid] && !containsStr(newAcked, eid) {
					newAcked = append(newAcked, eid)
					modified = true
				}
			}
			pp.AckedEventIDs = newAcked
			s.Pending[pos] = pp
		}
		// Close contiguous delivered/skipped positions from the lowest key.
		delivered := deliveredPositions(s.Pending)
		if len(delivered) > 0 {
			for _, pos := range delivered {
				delete(s.Pending, pos)
			}
			modified = true
		}
		if modified {
			cf.Sessions[wireID] = s
			changed = append(changed, wireID)
		}
	}
	if err := c.Save(*cf); err != nil {
		return nil, err
	}
	return changed, nil
}

// deliveredPositions returns the contiguous run of fully-acknowledged OR skipped
// positions starting from the lexicographically smallest key. A position is
// "delivered" when every expected eventID is in AckedEventIDs; "skipped" when it
// has a SkippedReason and no expected events. Gaps stop the run.
func deliveredPositions(pending map[string]PendingPosition) []string {
	keys := make([]string, 0, len(pending))
	for k := range pending {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []string
	for _, k := range keys {
		pp := pending[k]
		if len(pp.ExpectedEventIDs) == 0 && pp.SkippedReason != "" {
			out = append(out, k)
			continue
		}
		if allAcked(pp.ExpectedEventIDs, pp.AckedEventIDs) {
			out = append(out, k)
			continue
		}
		break // gap: stop
	}
	return out
}

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

// StoragePathHash returns a stable hash of a normalized storage path, used to
// bind the cursor to a storage root.
func StoragePathHash(storageDir string) string {
	h := sha256.Sum256([]byte(filepath.Clean(storageDir)))
	return hex.EncodeToString(h[:16])
}
