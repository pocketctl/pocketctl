package turn

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// JournalEntry is the persisted identity of one active (non-terminal) turn.
// It intentionally carries no prompt, response or tool content — identity
// fields only (plan §5).
type JournalEntry struct {
	SessionID            string    `json:"session_id"`
	AgentID              string    `json:"agent_id,omitempty"`
	TurnID               string    `json:"turn_id"`
	SourceTurnID         string    `json:"source_turn_id,omitempty"`
	ExpectedSourceTurnID string    `json:"expected_source_turn_id,omitempty"`
	ParentTurnID         string    `json:"parent_turn_id,omitempty"`
	State                string    `json:"state"`
	Origin               string    `json:"origin,omitempty"`
	Confidence           string    `json:"confidence,omitempty"`
	StartedAt            time.Time `json:"started_at"`
	RequestIDHash        string    `json:"request_id_hash,omitempty"`
}

// Journal persists the active-turn set to a single JSON file using the
// write-temp + fsync + rename pattern with 0600 permissions. A corrupt file is
// quarantined as .corrupt-<timestamp> and reported to the caller; opening the
// journal never blocks the daemon (fail-open).
type Journal struct {
	path string
	mu   sync.Mutex
}

// OpenJournal opens (or lazily creates) the journal at path. It does not fail
// on a missing file; a corrupt file is moved aside and the error returned so
// the caller can emit a structured warning while continuing startup.
func OpenJournal(path string) (*Journal, error) {
	j := &Journal{path: path}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return j, nil
	}
	if _, err := j.Load(); err != nil {
		return j, err
	}
	return j, nil
}

// Load reads the persisted active entries. On parse failure the file is
// quarantined with a .corrupt-<unixnano> suffix and the original bytes are
// dropped — corrupt state must never be restored (fail-open, not fail-closed).
func (j *Journal) Load() ([]JournalEntry, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.loadLocked()
}

func (j *Journal) loadLocked() ([]JournalEntry, error) {
	raw, err := os.ReadFile(j.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var entries []JournalEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		quarantine := fmt.Sprintf("%s.corrupt-%d", j.path, time.Now().UnixNano())
		_ = os.Rename(j.path, quarantine)
		return nil, fmt.Errorf("turn journal corrupt, quarantined as %s: %w", quarantine, err)
	}
	// Only non-terminal entries are ever useful after a restart; terminal
	// leftovers are dropped defensively.
	kept := entries[:0]
	for _, e := range entries {
		if IsActive(e.State) {
			kept = append(kept, e)
		}
	}
	return kept, nil
}

// Save atomically replaces the file with entries. The temp file is created in
// the same directory (same filesystem) with 0600, fsynced, then renamed over
// the target, and the directory is fsynced so the rename survives a crash.
func (j *Journal) Save(entries []JournalEntry) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(j.path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d", j.path, time.Now().UnixNano())
	if err := writeFileSync(tmp, raw, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, j.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if dir, err := os.Open(filepath.Dir(j.path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// Path exposes the journal location (for tests and diagnostics).
func (j *Journal) Path() string { return j.path }

func writeFileSync(path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
