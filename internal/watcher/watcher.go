package watcher

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

// DiscoveredSession represents a Claude Code session found in ~/.claude/sessions/
type DiscoveredSession struct {
	Pid       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Status    string `json:"status"`
	StartedAt int64  `json:"startedAt"`
	Version   string `json:"version"`
}

// SessionEvent is emitted when a session is discovered or changes
type SessionEvent struct {
	Action   string             // "discovered", "changed", "removed"
	Session  DiscoveredSession
	Filepath string
}

// SessionWatcher monitors ~/.claude/sessions/ for new/changed/removed session files
type SessionWatcher struct {
	sessionsDir string
	watcher     *fsnotify.Watcher
	eventsCh    chan SessionEvent
	knownFiles  map[string]DiscoveredSession // filepath → session
}

// NewSessionWatcher creates a watcher for Claude Code sessions directory
func NewSessionWatcher() (*SessionWatcher, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("get home dir: %w", err)
	}
	sessionsDir := filepath.Join(home, ".claude", "sessions")

	// Ensure directory exists
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		return nil, fmt.Errorf("create sessions dir: %w", err)
	}

	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create fsnotify watcher: %w", err)
	}

	return &SessionWatcher{
		sessionsDir: sessionsDir,
		watcher:     fsw,
		eventsCh:    make(chan SessionEvent, 32),
		knownFiles:  make(map[string]DiscoveredSession),
	}, nil
}

// Events returns the channel for session discovery events
func (sw *SessionWatcher) Events() <-chan SessionEvent {
	return sw.eventsCh
}

// Start begins watching. It first scans existing files, then listens for changes.
func (sw *SessionWatcher) Start(ctx context.Context) error {
	// Scan existing sessions first
	sw.scanExisting()

	// Start watching the directory
	if err := sw.watcher.Add(sw.sessionsDir); err != nil {
		return fmt.Errorf("watch sessions dir: %w", err)
	}

	go sw.loop(ctx)
	return nil
}

// Close stops the watcher
func (sw *SessionWatcher) Close() error {
	return sw.watcher.Close()
}

func (sw *SessionWatcher) loop(ctx context.Context) {
	// Periodic rescan every 30s as fallback
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-sw.watcher.Events:
			if !ok {
				return
			}
			sw.handleFsEvent(event)
		case <-ticker.C:
			// Periodic scan to catch any missed events
			sw.scanExisting()
		}
	}
}

func (sw *SessionWatcher) handleFsEvent(event fsnotify.Event) {
	// Only care about JSON files
	if !strings.HasSuffix(event.Name, ".json") {
		return
	}

	switch {
	case event.Op&fsnotify.Create == fsnotify.Create:
		sw.handleNewFile(event.Name)
	case event.Op&fsnotify.Write == fsnotify.Write:
		sw.handleChangedFile(event.Name)
	case event.Op&(fsnotify.Remove|fsnotify.Rename) != 0:
		sw.handleRemovedFile(event.Name)
	}
}

func (sw *SessionWatcher) handleNewFile(path string) {
	sess, err := parseSessionFile(path)
	if err != nil {
		return
	}
	// Skip sessions whose process is no longer alive
	if sess.Pid > 0 && !IsProcessAlive(sess.Pid) {
		return
	}
	sw.knownFiles[path] = sess
	sw.eventsCh <- SessionEvent{
		Action:   "discovered",
		Session:  sess,
		Filepath: path,
	}
}

func (sw *SessionWatcher) handleChangedFile(path string) {
	sess, err := parseSessionFile(path)
	if err != nil {
		return
	}
	sw.knownFiles[path] = sess
	sw.eventsCh <- SessionEvent{
		Action:   "changed",
		Session:  sess,
		Filepath: path,
	}
}

func (sw *SessionWatcher) handleRemovedFile(path string) {
	sess, ok := sw.knownFiles[path]
	if !ok {
		return
	}
	delete(sw.knownFiles, path)
	sw.eventsCh <- SessionEvent{
		Action:   "removed",
		Session:  sess,
		Filepath: path,
	}
}

// scanExisting reads all JSON files in the sessions directory
func (sw *SessionWatcher) scanExisting() {
	entries, err := os.ReadDir(sw.sessionsDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(sw.sessionsDir, entry.Name())
		if _, known := sw.knownFiles[path]; known {
			// Re-read in case status changed
			sess, err := parseSessionFile(path)
			if err == nil {
				oldSess := sw.knownFiles[path]
				sw.knownFiles[path] = sess
				if oldSess.Status != sess.Status {
					sw.eventsCh <- SessionEvent{
						Action:   "changed",
						Session:  sess,
						Filepath: path,
					}
				}
			}
			continue
		}
		sw.handleNewFile(path)
	}

	// Check for removed files (file was in knownFiles but no longer on disk)
	for path, sess := range sw.knownFiles {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			delete(sw.knownFiles, path)
			sw.eventsCh <- SessionEvent{
				Action:   "removed",
				Session:  sess,
				Filepath: path,
			}
		}
	}
}

func parseSessionFile(path string) (DiscoveredSession, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return DiscoveredSession{}, err
	}
	var sess DiscoveredSession
	if err := json.Unmarshal(data, &sess); err != nil {
		return DiscoveredSession{}, err
	}
	return sess, nil
}
