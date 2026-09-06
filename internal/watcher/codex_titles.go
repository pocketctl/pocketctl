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
	mu     sync.Mutex
	path   string
	info   os.FileInfo
	titles map[string]CodexTitle
}

func NewCodexTitleIndex() *CodexTitleIndex {
	return &CodexTitleIndex{path: filepath.Join(adapter.CodexHome(), "session_index.jsonl")}
}

func (index *CodexTitleIndex) Lookup(sessionID string) (CodexTitle, bool) {
	index.mu.Lock()
	defer index.mu.Unlock()
	info, err := os.Stat(index.path)
	if err == nil && (index.info == nil || !os.SameFile(info, index.info) ||
		info.Size() != index.info.Size() || !info.ModTime().Equal(index.info.ModTime())) {
		if file, err := os.Open(index.path); err == nil {
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
				if previous, ok := titles[record.ID]; !ok || !record.UpdatedAt.Before(previous.UpdatedAt) {
					titles[record.ID] = CodexTitle{strings.TrimSpace(record.Name), record.UpdatedAt}
				}
			}
			if scanner.Err() == nil {
				index.titles, index.info = titles, info
			}
			file.Close()
		}
	}
	title, ok := index.titles[sessionID]
	return title, ok
}
