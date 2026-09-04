package watcher

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/pocketctl/pocketctl/internal/config"
)

// DiscoveredSession represents a Claude Code session found in ~/.claude/sessions/
type DiscoveredSession struct {
	Pid             int    `json:"pid"`
	SessionID       string `json:"sessionId"`
	Cwd             string `json:"cwd"`
	Status          string `json:"status"`
	StartedAt       int64  `json:"startedAt"`
	Version         string `json:"version"`
	ParentSessionID string `json:"parentSessionId,omitempty"`
	RootSessionID   string `json:"rootSessionId,omitempty"`
	IsSubagent      bool   `json:"isSubagent,omitempty"`
	AgentNickname   string `json:"agentNickname,omitempty"`
	AgentPath       string `json:"agentPath,omitempty"`
}

// SessionEvent is emitted when a session is discovered or changes
type SessionEvent struct {
	Action          string // "discovered", "changed", "removed"
	Session         DiscoveredSession
	Filepath        string
	Replay          bool
	ReplayNotBefore time.Time
	ReplayStartLine int64
}

// SessionWatcher monitors ~/.claude/sessions/ for new/changed/removed session files
type SessionWatcher struct {
	sessionsDir   string
	watcher       *fsnotify.Watcher
	eventsCh      chan SessionEvent
	knownSessions map[string]DiscoveredSession // sessionId → session
	fileToSession map[string]string            // filepath → sessionId
	dropped       uint64                       // events dropped because the consumer wasn't draining
}

// NewSessionWatcher creates a watcher for Claude Code sessions directory
func NewSessionWatcher() (*SessionWatcher, error) {
	home, err := config.HomeDir()
	if err != nil {
		return nil, fmt.Errorf("get home dir: %w", err)
	}
	sessionsDir := filepath.Join(home, ".claude", "sessions")

	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		return nil, fmt.Errorf("create sessions dir: %w", err)
	}

	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create fsnotify watcher: %w", err)
	}

	return &SessionWatcher{
		sessionsDir:   sessionsDir,
		watcher:       fsw,
		eventsCh:      make(chan SessionEvent, 32),
		knownSessions: make(map[string]DiscoveredSession),
		fileToSession: make(map[string]string),
	}, nil
}

// Events returns the channel for session discovery events
func (sw *SessionWatcher) Events() <-chan SessionEvent {
	return sw.eventsCh
}

// emit sends a session event without blocking. The events channel is buffered
// (32) and normally drained by the daemon's watcher-event handler. But if that
// consumer goroutine ever dies (e.g. an unrecovered panic before supervision
// existed), a blocking send here would freeze the watcher's loop — including
// the 30s scanExisting ticker — leaving session discovery permanently blind
// (new session files, including --continue resumes, would never be noticed).
// Non-blocking send means we may drop an event under backpressure, but a
// dropped event is recoverable on the next fsnotify redraw or the next 30s
// scan; a frozen watcher is not. Dropped events are counted + logged.
func (sw *SessionWatcher) emit(evt SessionEvent) {
	select {
	case sw.eventsCh <- evt:
	default:
		sw.dropped++
		// Throttle: only log every 16th drop to avoid spamming the daemon log
		// when the consumer is gone for a while.
		if sw.dropped%16 == 1 {
			slog.Warn("session watcher event dropped (consumer not draining)",
				"action", evt.Action, "session", evt.Session.SessionID,
				"dropped_total", sw.dropped)
		}
	}
}

// Start begins watching. It first scans existing files, then listens for changes.
func (sw *SessionWatcher) Start(ctx context.Context) error {
	sw.scanExisting()

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
			sw.scanExisting()
		}
	}
}

func (sw *SessionWatcher) handleFsEvent(event fsnotify.Event) {
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

// handleNewFile processes a newly created session file.
// If the sessionId is already known (e.g. from --continue creating a new PID file),
// it updates the existing record and emits "changed" instead of "discovered".
func (sw *SessionWatcher) handleNewFile(path string) {
	sess, err := parseSessionFile(path)
	if err != nil || sess.SessionID == "" {
		return
	}

	prevSid := sw.fileToSession[path]
	sw.fileToSession[path] = sess.SessionID

	// Fork: the same per-PID file now carries a different sessionId — Claude Code
	// rewrote it because the conversation forked (e.g. /clear) within one process.
	// Retire the superseded session before registering the new one below.
	if prevSid != "" && prevSid != sess.SessionID {
		sw.retireForkedSession(prevSid, path)
	}

	if existing, ok := sw.knownSessions[sess.SessionID]; ok {
		// Session already known — update filepath/PID/status
		existing.Pid = sess.Pid
		existing.Status = sess.Status
		existing.Cwd = sess.Cwd
		sw.knownSessions[sess.SessionID] = existing
		sw.emit(SessionEvent{
			Action:   "changed",
			Session:  existing,
			Filepath: path,
		})
		return
	}

	// Genuinely new session
	sw.knownSessions[sess.SessionID] = sess
	sw.emit(SessionEvent{
		Action:   "discovered",
		Session:  sess,
		Filepath: path,
	})
}

// handleChangedFile processes a modified session file (status update, etc.)
func (sw *SessionWatcher) handleChangedFile(path string) {
	sess, err := parseSessionFile(path)
	if err != nil || sess.SessionID == "" {
		return
	}

	prevSid := sw.fileToSession[path]
	sw.fileToSession[path] = sess.SessionID

	// Fork detection: Claude Code keeps one ~/.claude/sessions/<pid>.json per
	// process and rewrites its sessionId *in place* when the conversation forks
	// (e.g. /clear starts a fresh session id + fresh JSONL in the same process).
	// That arrives here as a plain Write. Without special-casing it we'd emit
	// "changed" — a no-op status update — so no JSONL tailer is ever started for
	// the new session and its output silently stops reaching clients until the
	// daemon restarts (cold scanExisting then re-discovers it). Instead, retire
	// the old session and surface the new one as a fresh discovery so a tailer
	// starts live.
	if prevSid != "" && prevSid != sess.SessionID {
		sw.retireForkedSession(prevSid, path)
		if _, known := sw.knownSessions[sess.SessionID]; !known {
			sw.knownSessions[sess.SessionID] = sess
			sw.emit(SessionEvent{
				Action:   "discovered",
				Session:  sess,
				Filepath: path,
			})
			return
		}
	}

	sw.knownSessions[sess.SessionID] = sess
	sw.emit(SessionEvent{
		Action:   "changed",
		Session:  sess,
		Filepath: path,
	})
}

// retireForkedSession emits a "removed" event for prevSid when the per-PID
// session file at `path` has been rewritten to point at a different sessionId
// (a /clear-style fork). It is skipped if another file still tracks prevSid
// (e.g. a concurrent --continue). The caller must have already repointed
// fileToSession[path] at the NEW sessionId before calling this.
func (sw *SessionWatcher) retireForkedSession(prevSid, path string) {
	for otherPath, sid := range sw.fileToSession {
		if sid == prevSid && otherPath != path {
			return // still tracked by another file — not actually gone
		}
	}
	sess, ok := sw.knownSessions[prevSid]
	if !ok {
		return
	}
	delete(sw.knownSessions, prevSid)
	sw.emit(SessionEvent{
		Action:   "removed",
		Session:  sess,
		Filepath: path,
	})
}

// handleRemovedFile processes a deleted session file.
// Only emits "removed" if no other file tracks the same sessionId.
func (sw *SessionWatcher) handleRemovedFile(path string) {
	sessionId, ok := sw.fileToSession[path]
	if !ok {
		return
	}
	delete(sw.fileToSession, path)

	// Check if another file still tracks this sessionId
	for otherPath, otherSid := range sw.fileToSession {
		if otherSid == sessionId && otherPath != path {
			// Still tracked by another file — don't emit removed
			return
		}
	}

	// No other file tracks this session — it's truly gone.
	// Keep in knownSessions: the session may reappear via --continue with
	// a new PID file but the same sessionId. knownSessions is per-daemon-process,
	// so stale entries don't accumulate forever.
	if sess, exists := sw.knownSessions[sessionId]; exists {
		sw.emit(SessionEvent{
			Action:   "removed",
			Session:  sess,
			Filepath: path,
		})
	}
}

// scanExisting reads all JSON files in the sessions directory.
// Deduplicates by sessionId, keeping the most recently modified file per session.
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
		sess, err := parseSessionFile(path)
		if err != nil || sess.SessionID == "" {
			continue
		}

		prevSid := sw.fileToSession[path]
		sw.fileToSession[path] = sess.SessionID

		// Fork detection (see handleChangedFile): a per-PID file whose sessionId
		// changed means the conversation forked (/clear). Retire the old session;
		// the new id falls through to the "discovered" emission below.
		if prevSid != "" && prevSid != sess.SessionID {
			sw.retireForkedSession(prevSid, path)
		}

		if existing, ok := sw.knownSessions[sess.SessionID]; ok {
			// Already known — check if status changed
			if existing.Status != sess.Status {
				existing.Status = sess.Status
				existing.Pid = sess.Pid
				existing.Cwd = sess.Cwd
				sw.knownSessions[sess.SessionID] = existing
				sw.emit(SessionEvent{
					Action:   "changed",
					Session:  existing,
					Filepath: path,
				})
			}
			continue
		}

		// New session — emit discovered
		sw.knownSessions[sess.SessionID] = sess
		sw.emit(SessionEvent{
			Action:   "discovered",
			Session:  sess,
			Filepath: path,
		})
	}

	// Check for removed files (file was tracked but no longer on disk)
	for path, sessionId := range sw.fileToSession {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			delete(sw.fileToSession, path)
			// Only emit removed if no other file tracks this session
			stillTracked := false
			for otherPath, otherSid := range sw.fileToSession {
				if otherSid == sessionId && otherPath != path {
					stillTracked = true
					break
				}
			}
			if !stillTracked {
				if sess, exists := sw.knownSessions[sessionId]; exists {
					delete(sw.knownSessions, sessionId)
					sw.emit(SessionEvent{
						Action:   "removed",
						Session:  sess,
						Filepath: path,
					})
				}
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

// ReadSessionMetadata returns the latest Claude session metadata stored at
// path. The daemon uses this while waiting for a late JSONL to distinguish a
// still-live session from a transient ID that has been replaced by --continue
// or /clear.
func ReadSessionMetadata(path string) (DiscoveredSession, error) {
	return parseSessionFile(path)
}
