package zcode

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// journal.go is the ZCode-owned prepared-event journal (recovery-hardening
// design §6). The cursor stays content-free; this journal is deliberately
// CONTENT-BEARING: it stores the exact protocol.DaemonEvent payload for every
// event-producing pending position BEFORE the cursor records that position.
// It exists because Observer.Emit only places an event on the in-memory
// outputCh — the WebSocket client appends it to its own spool later, so a
// crash in between would otherwise lose the only copy of a payload whose
// source row may have already moved on.
//
// Safety properties:
//   - mode 0600 inside the 0700 PocketCtl config dir; local-only;
//   - never logged: error messages carry EventIDs and operation types only;
//   - one append + one fsync per page (not per event);
//   - an EventID may be re-put only with identical canonical payload bytes;
//   - raw native IDs never appear beyond what the wire event already carries.

const (
	preparedJournalVersion      = 1
	preparedJournalFileName     = "zcode-prepared-events.jsonl"
	journalCompactSizeThreshold = 8 << 20 // 8 MiB
	journalCompactOpsThreshold  = 1024
)

// Journal error sentinels. Messages include only hashed/wire identifiers and
// EventIDs — never payload text.
var (
	// ErrPreparedEventConflict reports the same EventID prepared twice with
	// different canonical payload bytes.
	ErrPreparedEventConflict = errors.New("zcode prepared event identity conflict")
	// ErrPreparedPayloadMissing reports cursor pending referencing a payload
	// that is absent from the reconstructed live journal index.
	ErrPreparedPayloadMissing = errors.New("zcode prepared payload missing")
	// ErrLegacyPendingUnrecoverable reports a legacy (journal-less) pending
	// position whose regenerated expected EventIDs no longer match the source.
	ErrLegacyPendingUnrecoverable = errors.New("zcode legacy pending cannot be reconstructed")
)

// journalPutEvent is one prepared payload inside a put_batch record.
type journalPutEvent struct {
	EventID       string               `json:"event_id"`
	WireSessionID string               `json:"wire_session_id"`
	Payload       protocol.DaemonEvent `json:"payload"`
}

// journalRecord is one complete physical journal line.
type journalRecord struct {
	Version  int               `json:"version"`
	Op       string            `json:"op"`
	Events   []journalPutEvent `json:"events,omitempty"`
	EventIDs []string          `json:"event_ids,omitempty"`
}

type journalLiveEntry struct {
	put  journalPutEvent
	size int64
}

// PreparedEventJournal is the append-only prepared-event journal owned by the
// observer. All public methods are goroutine-safe.
type PreparedEventJournal struct {
	mu   sync.Mutex
	path string

	file   *os.File
	opened bool

	live      map[string]journalLiveEntry
	liveBytes int64
	fileSize  int64

	opsSinceCompaction     int
	tombstonesSinceCompact int

	// test instrumentation (in-package): counters and an injectable write error.
	appendCount  int
	syncCount    int
	testWriteErr error
}

// NewPreparedEventJournalAt builds a journal at an explicit path (tests).
func NewPreparedEventJournalAt(path string) *PreparedEventJournal {
	return &PreparedEventJournal{path: path, live: map[string]journalLiveEntry{}}
}

// NewPreparedEventJournal builds a journal rooted at the PocketCtl config dir.
func NewPreparedEventJournal() (*PreparedEventJournal, error) {
	dir, err := config.ConfigDir()
	if err != nil {
		return nil, err
	}
	return NewPreparedEventJournalAt(filepath.Join(dir, preparedJournalFileName)), nil
}

// Path returns the journal file path.
func (j *PreparedEventJournal) Path() string { return j.path }

// Open replays all complete journal lines, folds puts and tombstones into the
// live EventID index, validates duplicate identity, and opens the append
// handle. A truncated final line is provisionally ignored; the subsequent
// Reconcile call decides safety. Malformed non-final records fail closed.
func (j *PreparedEventJournal) Open() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.opened {
		return nil
	}
	data, err := os.ReadFile(j.path)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		// Fresh journal.
		f, err := os.OpenFile(j.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err != nil {
			return err
		}
		j.file = f
		j.fileSize = 0
		j.opened = true
		return nil
	}
	live := map[string]journalLiveEntry{}
	var liveBytes int64
	truncateTo := int64(-1)
	completeRecords := 0
	lines := splitJournalLines(data)
	for idx, line := range lines {
		if len(line) == 0 {
			continue
		}
		var rec journalRecord
		if err := json.Unmarshal(line, &rec); err != nil {
			if idx == len(lines)-1 && data[len(data)-1] != '\n' {
				// Truncated final tail: ignore provisionally; Reconcile
				// decides safety via missing-payload validation.
				truncateTo = int64(len(data) - len(line))
				break
			}
			return fmt.Errorf("zcode prepared journal: malformed record %d: %w", idx, err)
		}
		switch rec.Op {
		case "put_batch":
			for _, ev := range rec.Events {
				if ev.Payload.EventID != ev.EventID || ev.WireSessionID != ev.Payload.SessionID {
					return fmt.Errorf("%w: %s", ErrPreparedEventConflict, ev.EventID)
				}
				if existing, ok := live[ev.EventID]; ok {
					if !identicalJournalPayload(existing.put.Payload, ev.Payload) {
						return fmt.Errorf("%w: %s", ErrPreparedEventConflict, ev.EventID)
					}
					continue
				}
				live[ev.EventID] = journalLiveEntry{put: ev, size: int64(len(line)) / int64(maxInt(len(rec.Events), 1))}
				liveBytes += journalEncodedSize(ev)
			}
		case "ack_batch":
			for _, id := range rec.EventIDs {
				if entry, ok := live[id]; ok {
					liveBytes -= entry.size
					delete(live, id)
				}
			}
		default:
			return fmt.Errorf("zcode prepared journal: unknown op %q at record %d", rec.Op, idx)
		}
		completeRecords++
	}
	f, err := os.OpenFile(j.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if truncateTo >= 0 {
		if err := f.Truncate(truncateTo); err != nil {
			f.Close()
			return err
		}
		if err := f.Sync(); err != nil {
			f.Close()
			return err
		}
	} else if len(data) > 0 && data[len(data)-1] != '\n' {
		if _, err := f.Write([]byte{'\n'}); err != nil {
			f.Close()
			return err
		}
		if err := f.Sync(); err != nil {
			f.Close()
			return err
		}
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	j.file = f
	j.live = live
	j.liveBytes = liveBytes
	j.fileSize = info.Size()
	j.opsSinceCompaction = completeRecords
	j.opened = true
	return nil
}

// PrepareBatch durably appends one put_batch line (one append + one sync per
// page) and publishes the live index entries only after the sync succeeds.
// Re-preparing identical payloads is idempotent; a conflicting payload for a
// live EventID fails closed.
func (j *PreparedEventJournal) PrepareBatch(wireSessionID string, events []protocol.DaemonEvent) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.opened {
		return errors.New("zcode prepared journal: not open")
	}
	batch := make([]journalPutEvent, 0, len(events))
	seenInBatch := map[string]bool{}
	for _, ev := range events {
		if ev.EventID == "" {
			return errors.New("zcode prepared journal: event without id")
		}
		if ev.SessionID != wireSessionID {
			return fmt.Errorf("zcode prepared journal: event %s session mismatch", ev.EventID)
		}
		if existing, ok := j.live[ev.EventID]; ok {
			if !identicalJournalPayload(existing.put.Payload, ev) {
				return fmt.Errorf("%w: %s", ErrPreparedEventConflict, ev.EventID)
			}
			continue // already durable: idempotent no-op
		}
		if seenInBatch[ev.EventID] {
			return fmt.Errorf("%w: %s", ErrPreparedEventConflict, ev.EventID)
		}
		seenInBatch[ev.EventID] = true
		batch = append(batch, journalPutEvent{EventID: ev.EventID, WireSessionID: wireSessionID, Payload: ev})
	}
	if len(batch) == 0 {
		return nil
	}
	line, err := encodeJournalRecord(journalRecord{Version: preparedJournalVersion, Op: "put_batch", Events: batch})
	if err != nil {
		return err
	}
	if err := j.appendLineLocked(line); err != nil {
		return err
	}
	for _, ev := range batch {
		j.live[ev.EventID] = journalLiveEntry{put: ev, size: journalEncodedSize(ev)}
		j.liveBytes += journalEncodedSize(ev)
	}
	j.fileSize += int64(len(line))
	j.opsSinceCompaction++
	j.maybeCompactLocked()
	return nil
}

// Load returns the exact prepared payload for an EventID.
func (j *PreparedEventJournal) Load(eventID string) (protocol.DaemonEvent, bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.opened {
		return protocol.DaemonEvent{}, false, errors.New("zcode prepared journal: not open")
	}
	entry, ok := j.live[eventID]
	if !ok {
		return protocol.DaemonEvent{}, false, nil
	}
	return entry.put.Payload, true, nil
}

// Acknowledge appends one tombstone line and removes the acknowledged IDs from
// the live index only after the append and sync succeed. Unknown and duplicate
// IDs are idempotent.
func (j *PreparedEventJournal) Acknowledge(eventIDs []string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.opened {
		return errors.New("zcode prepared journal: not open")
	}
	known := make([]string, 0, len(eventIDs))
	for _, id := range eventIDs {
		if _, ok := j.live[id]; ok {
			known = append(known, id)
		}
	}
	if len(known) == 0 {
		return nil // idempotent no-op, no append
	}
	line, err := encodeJournalRecord(journalRecord{Version: preparedJournalVersion, Op: "ack_batch", EventIDs: known})
	if err != nil {
		return err
	}
	if err := j.appendLineLocked(line); err != nil {
		return err
	}
	for _, id := range known {
		if entry, ok := j.live[id]; ok {
			j.liveBytes -= entry.size
			delete(j.live, id)
			j.tombstonesSinceCompact++
		}
	}
	j.fileSize += int64(len(line))
	j.opsSinceCompaction++
	j.maybeCompactLocked()
	return nil
}

// Reconcile validates that every cursor-referenced unacknowledged EventID has
// a live prepared payload, then trims the in-memory live index to exactly the
// referenced set — orphan payloads (puts whose cursor recording never landed)
// disappear from the index and leave the file at the next compaction.
func (j *PreparedEventJournal) Reconcile(liveEventIDs map[string]struct{}) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.opened {
		return errors.New("zcode prepared journal: not open")
	}
	missing := make([]string, 0)
	for id := range liveEventIDs {
		if _, ok := j.live[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf("%w: %v", ErrPreparedPayloadMissing, missing)
	}
	trimmed := make(map[string]journalLiveEntry, len(liveEventIDs))
	var liveBytes int64
	for id := range liveEventIDs {
		entry := j.live[id]
		trimmed[id] = entry
		liveBytes += entry.size
	}
	j.live = trimmed
	j.liveBytes = liveBytes
	return nil
}

// DiscardOrphans removes live-index entries without appending tombstones.
// It is only valid for EventIDs that no cursor pending position references
// (orphans from a failed or conflicted preparation whose payload is about to
// be superseded). A restart re-folds the original put from disk, so the
// discard is re-derived idempotently; compaction materializes it permanently.
func (j *PreparedEventJournal) DiscardOrphans(eventIDs []string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.opened {
		return
	}
	for _, id := range eventIDs {
		if entry, ok := j.live[id]; ok {
			j.liveBytes -= entry.size
			delete(j.live, id)
		}
	}
}

// Close releases the append handle.
func (j *PreparedEventJournal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.opened {
		return nil
	}
	j.opened = false
	if j.file != nil {
		err := j.file.Close()
		j.file = nil
		return err
	}
	return nil
}

// --- internals ---------------------------------------------------------------

func (j *PreparedEventJournal) appendLineLocked(line []byte) error {
	if j.testWriteErr != nil {
		return j.testWriteErr
	}
	if _, err := j.file.Write(line); err != nil {
		return err
	}
	j.appendCount++
	if err := j.file.Sync(); err != nil {
		return err
	}
	j.syncCount++
	return nil
}

// maybeCompactLocked compacts atomically when the journal is both large and
// mostly dead, or when enough operations accumulated with tombstones at least
// equal to live entries. The absolute size alone never triggers compaction:
// a live set larger than the threshold would otherwise compact every page and
// recreate the write-amplification failure this journal exists to remove.
func (j *PreparedEventJournal) maybeCompactLocked() {
	sizeHeavy := j.fileSize > journalCompactSizeThreshold && j.fileSize >= 2*j.liveBytes
	opHeavy := j.opsSinceCompaction >= journalCompactOpsThreshold && j.tombstonesSinceCompact >= len(j.live)
	if !sizeHeavy && !opHeavy {
		return
	}
	if err := j.compactLocked(); err != nil {
		// Compaction is an optimization: keep the previous readable journal.
		return
	}
}

func (j *PreparedEventJournal) compactLocked() error {
	ids := make([]string, 0, len(j.live))
	for id := range j.live {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	events := make([]journalPutEvent, 0, len(ids))
	for _, id := range ids {
		events = append(events, j.live[id].put)
	}
	line, err := encodeJournalRecord(journalRecord{Version: preparedJournalVersion, Op: "put_batch", Events: events})
	if err != nil {
		return err
	}
	dir := filepath.Dir(j.path)
	tmp, err := os.CreateTemp(dir, ".zcode-prepared.*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	keep := true
	defer func() {
		if keep {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(line); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	// Rename the synced temporary while both handles remain open. If replacement
	// fails, the old append handle is still valid; after success the temporary
	// handle itself becomes the new journal handle, so no reopen failure can
	// poison subsequent appends.
	if err := os.Rename(tmpName, j.path); err != nil {
		_ = tmp.Close()
		return err
	}
	keep = false
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	old := j.file
	j.file = tmp
	if old != nil {
		_ = old.Close()
	}
	if info, err := os.Stat(j.path); err == nil {
		j.fileSize = info.Size()
	} else {
		j.fileSize = int64(len(line))
	}
	j.opsSinceCompaction = 0
	j.tombstonesSinceCompact = 0
	return nil
}

// compactLockedForTest triggers compaction explicitly (deterministic tests;
// the runtime path goes through maybeCompactLocked's thresholds).
func (j *PreparedEventJournal) compactLockedForTest() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.opened {
		return errors.New("zcode prepared journal: not open")
	}
	return j.compactLocked()
}

// --- helpers -----------------------------------------------------------------

func encodeJournalRecord(rec journalRecord) ([]byte, error) {
	data, err := json.Marshal(rec)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func splitJournalLines(data []byte) [][]byte {
	var lines [][]byte
	start := 0
	for i, b := range data {
		if b == '\n' {
			lines = append(lines, data[start:i])
			start = i + 1
		}
	}
	if start < len(data) {
		lines = append(lines, data[start:])
	}
	return lines
}

func identicalJournalPayload(a, b protocol.DaemonEvent) bool {
	ab, err := json.Marshal(a)
	if err != nil {
		return false
	}
	bb, err := json.Marshal(b)
	if err != nil {
		return false
	}
	return string(ab) == string(bb)
}

func journalEncodedSize(ev journalPutEvent) int64 {
	data, err := json.Marshal(ev)
	if err != nil {
		return 0
	}
	return int64(len(data))
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
