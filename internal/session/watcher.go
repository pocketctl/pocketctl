package session

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

// SetTailer associates a JSONL tailer with a session (so sendToIdleTerminal can pause/resume it).
func (sm *SessionManager) SetTailer(sessionID string, t *watcher.JSONLTailer) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.Tailer = t
	}
}

// drainPTY reads the PTY master until EOF, feeding every chunk to the session's
// menu scanner. This keeps the PTY buffer drained (so the agent's TUI doesn't
// block) AND lets the scanner surface inline selection prompts as
// interactive_prompt events. Runs once per daemon session; exits when the PTY
// master is closed (session exit / kill).
func (sm *SessionManager) drainPTY(ctx context.Context, ps *ProcessState) {
	buf := make([]byte, 4096)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		n, err := ps.PTY.Read(buf)
		if n > 0 && ps.PTYScanner != nil {
			// Forward a copy so the scanner can retain bytes across reads.
			for _, ev := range ps.PTYScanner.Feed(append([]byte(nil), buf[:n]...)) {
				select {
				case sm.outputCh <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
		if err != nil {
			// EOF / closed master: session is exiting; handlePTYExit closes the fd.
			return
		}
	}
}

// RegisterTerminalSession registers a session discovered from the terminal.
// Returns true if a tailer should be started (new session or daemon→terminal upgrade).
// Returns false for: daemon-spawned processes (skip entirely) or existing terminal
// sessions (--continue — PID/status updated in-place, but no new tailer needed since
// the old one still tails the same JSONL file).
func (sm *SessionManager) RegisterTerminalSession(sessionID, cwd string, pid int, ttyPath string, status string, agent string) bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Don't register if this is a daemon-spawned process
	if sm.childPids[pid] {
		return false
	}

	// Check if session already exists
	if ps, ok := sm.sessions[sessionID]; ok {
		if ps.Source == "terminal" {
			// Re-discovered (e.g. --continue): update PID, status, cwd.
			// Old tailer still works on same JSONL — no new tailer needed.
			ps.Pid = pid
			ps.Status = status
			ps.ExitReason = ""
			// Re-discover 时用 watcher 的 agentType 校正 Agent(防历史污染:
			// 旧版 RegisterTerminalSession 硬编码 claude-code,completed session
			// 的 sm.sessions.Agent 可能是错的,OnReconnected 会发错值覆盖 relay)
			if agent != "" {
				ps.Agent = agent
			}
			if cwd != "" {
				ps.Cwd = cwd
			}
			if ttyPath != "" {
				ps.TTY = ttyPath
			}
			return false
		}
		// Daemon-created session appeared in watcher — user resumed it in terminal.
		// Upgrade source and start tailer.
		ps.Source = "terminal"
		ps.Pid = pid
		if cwd != "" {
			ps.Cwd = cwd
		}
		ps.Status = status
		if ttyPath != "" {
			ps.TTY = ttyPath
		}
		return true
	}

	// New session — register it
	now := time.Now()
	sm.sessions[sessionID] = &ProcessState{
		SessionID:      sessionID,
		Status:         status,
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            cwd,
		Agent:          agent,
		Source:         "terminal",
		Pid:            pid,
		TTY:            ttyPath,
	}

	// session_discovered is emitted later, after the JSONL tailer confirms the file exists.
	// See handleWatcherEvents in cmd/pocketctl/main.go.

	return true
}

// ReviveTerminalSessionOnActivity is called from the JSONL tail loop when fresh
// events arrive. It always refreshes LastActivityAt; additionally, if the session
// had gone dormant (exited/completed/error/killed) it flips it back to running and
// emits session_status. This is what makes an `exit` → `claude --continue` resume
// reappear as live: the original session's tailer stays alive across the exit, so
// when --continue appends to the same <id>.jsonl the renewed output revives the
// original card instead of leaving it frozen at "exited".
func (sm *SessionManager) ReviveTerminalSessionOnActivity(sessionID string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	now := time.Now()
	ps.LastActivityAt = now
	dormant := ps.Status == protocol.StatusExited || ps.Status == protocol.StatusCompleted ||
		ps.Status == protocol.StatusError || ps.Status == protocol.StatusKilled
	if !dormant {
		sm.mu.Unlock()
		return
	}
	ps.Status = protocol.StatusRunning
	ps.ExitReason = ""
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         protocol.StatusRunning,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

// extractCwdFromJSONL reads the first records of a session's JSONL and returns
// the cwd field. Each line is a JSON object; cwd is present on most records.
func extractCwdFromJSONL(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for i := 0; i < 200 && scanner.Scan(); i++ {
		var rec struct {
			Cwd string `json:"cwd"`
		}
		if json.Unmarshal(scanner.Bytes(), &rec) == nil && rec.Cwd != "" {
			return rec.Cwd
		}
	}
	return ""
}

// cwdFromProjectsDir decodes a cwd from a JSONL path's projects dir name
// (~/.claude/projects/-Users-foo-bar/x.jsonl → /Users/foo/bar).
func cwdFromProjectsDir(jsonlPath string) string {
	dir := filepath.Base(filepath.Dir(jsonlPath))
	if !strings.HasPrefix(dir, "-") {
		return ""
	}
	return "/" + strings.ReplaceAll(dir[1:], "-", "/")
}
