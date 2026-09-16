package watcher

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
)

type CodexTitle struct {
	Name      string
	UpdatedAt time.Time
}

// CodexTitleIndex observes Desktop names without opening its private database.
// Polling stat also handles atomic replacements; malformed/partial records are
// ignored and a failed read never discards the last successfully read snapshot.
type CodexTitleIndex struct {
	mu        sync.Mutex
	paths     []string
	infos     []os.FileInfo
	snapshots []map[string]CodexTitle // per-path last successfully read records
	titles    map[string]CodexTitle   // merged view across paths
}

// NewCodexTitleIndex observes one session_index.jsonl per watched Codex home:
// the primary home plus every additional home from POCKETCTL_CODEX_HOMES.
func NewCodexTitleIndex() *CodexTitleIndex {
	homes := append([]string{adapter.CodexHome()}, adapter.AdditionalCodexHomes()...)
	var paths []string
	for _, home := range homes {
		if home == "" {
			continue
		}
		paths = append(paths, filepath.Join(home, "session_index.jsonl"))
	}
	return &CodexTitleIndex{paths: paths, titles: make(map[string]CodexTitle)}
}

func (index *CodexTitleIndex) Lookup(sessionID string) (CodexTitle, bool) {
	index.mu.Lock()
	defer index.mu.Unlock()
	for i, path := range index.paths {
		info, err := os.Stat(path)
		if err != nil {
			continue // keep the last successfully read snapshot for this path
		}
		var prev os.FileInfo
		if i < len(index.infos) {
			prev = index.infos[i]
		}
		if prev != nil && os.SameFile(info, prev) &&
			info.Size() == prev.Size() && info.ModTime().Equal(prev.ModTime()) {
			continue
		}
		if file, err := os.Open(path); err == nil {
			titles := make(map[string]CodexTitle)
			scanner := bufio.NewScanner(file)
			scanner.Buffer(make([]byte, 64*1024), 1024*1024)
			for scanner.Scan() {
				var record struct {
					ID        string    `json:"id"`
					Name      string    `json:"thread_name"`
					UpdatedAt time.Time `json:"updated_at"`
				}
				if json.Unmarshal(scanner.Bytes(), &record) != nil || record.ID == "" ||
					strings.TrimSpace(record.Name) == "" || record.UpdatedAt.IsZero() {
					continue
				}
				if previous, ok := titles[record.ID]; !ok || record.UpdatedAt.After(previous.UpdatedAt) {
					titles[record.ID] = CodexTitle{strings.TrimSpace(record.Name), record.UpdatedAt}
				}
			}
			if scanner.Err() == nil {
				// Replace this path's snapshot wholesale so records dropped
				// by a rewrite disappear from the merged view.
				for len(index.snapshots) < len(index.paths) {
					index.snapshots = append(index.snapshots, nil)
				}
				index.snapshots[i] = titles
				for len(index.infos) < len(index.paths) {
					index.infos = append(index.infos, nil)
				}
				index.infos[i] = info
				index.rebuild()
			}
			file.Close()
		}
	}
	title, ok := index.titles[sessionID]
	return title, ok
}

// rebuild recomputes the merged view from the per-path snapshots. Paths keep
// their priority order (primary first); an equal updated_at preserves the
// earlier home's record, so mirrored homes never override the primary.
func (index *CodexTitleIndex) rebuild() {
	merged := make(map[string]CodexTitle)
	for _, snapshot := range index.snapshots {
		for id, title := range snapshot {
			if previous, ok := merged[id]; !ok || title.UpdatedAt.After(previous.UpdatedAt) {
				merged[id] = title
			}
		}
	}
	index.titles = merged
}
