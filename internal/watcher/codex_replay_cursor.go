package watcher

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

type codexReplayCursorState struct {
	Version int              `json:"version"`
	Sources map[string]int64 `json:"sources"`
}

// CodexReplayCursorStore records a safe source line from which startup replay
// can resume. It is advanced only by Relay ACK observation. The highest ACKed
// line itself is replayed because one JSONL record may generate multiple
// sequenced events; stable IDs make that bounded duplicate harmless.
type CodexReplayCursorStore struct {
	mu      sync.Mutex
	path    string
	sources map[string]int64
}

func NewCodexReplayCursorStore(path string) (*CodexReplayCursorStore, error) {
	store := &CodexReplayCursorStore{path: path, sources: make(map[string]int64)}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	var state codexReplayCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, fmt.Errorf("decode Codex replay cursor: %w", err)
	}
	for source, nextLine := range state.Sources {
		if nextLine > 0 {
			store.sources[source] = nextLine
		}
	}
	return store, nil
}

func CodexReplaySourceID(path string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(path)))[:16]
}

func (s *CodexReplayCursorStore) StartLine(sourcePath string) int64 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sources[CodexReplaySourceID(sourcePath)]
}

func (s *CodexReplayCursorStore) AdvanceEventIDs(eventIDs []string) error {
	if s == nil || len(eventIDs) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, eventID := range eventIDs {
		source, line, ok := parseCodexReplayEventID(eventID)
		if !ok {
			continue
		}
		if line > s.sources[source] {
			s.sources[source] = line
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.persistLocked()
}

func parseCodexReplayEventID(eventID string) (string, int64, bool) {
	parts := strings.Split(eventID, ":")
	if len(parts) < 4 || parts[0] != "jsonl" || parts[1] == "" {
		return "", 0, false
	}
	line, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || line < 0 {
		return "", 0, false
	}
	return parts[1], line, true
}

func (s *CodexReplayCursorStore) persistLocked() error {
	state := codexReplayCursorState{Version: 1, Sources: s.sources}
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
