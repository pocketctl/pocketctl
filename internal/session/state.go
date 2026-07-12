package session

import (
	"sort"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// UpdateSessionTitle updates the title for a session and emits an event.
func (sm *SessionManager) UpdateSessionTitle(sessionID, title string) {
	sm.mu.RLock()
	_, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.RUnlock()
		return
	}
	sm.mu.RUnlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:      "session_title_update",
		SessionID: sessionID,
		Title:     title,
	}
}

// MaxTitleAttempts caps how many times a session will ask the relay to generate
// an AI title. Each new user+assistant round in the tailer re-triggers until the
// relay succeeds (relay returns empty on failure and keeps the default title, so
// re-generation is harmless and self-healing). 5 bounds cost/429-risk during a
// sustained GLM outage while still letting transient failures recover.
const MaxTitleAttempts = 5

// GenerateTitle sends a generate_title_request event to the relay for LLM-based
// title generation. Re-triggerable up to MaxTitleAttempts per session so a transient
// GLM failure (429/timeout) self-heals on the next conversation round.
func (sm *SessionManager) GenerateTitle(sessionID, userMessage, assistantMessage string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	if ps.TitleAttempts >= MaxTitleAttempts {
		sm.mu.Unlock()
		return
	}
	ps.TitleAttempts++
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:             "generate_title_request",
		SessionID:        sessionID,
		UserMessage:      userMessage,
		AssistantMessage: assistantMessage,
	}
}

func (sm *SessionManager) SetSessionExited(sessionID string, exitReason string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	now := time.Now()
	ps.Status = protocol.StatusExited
	ps.ExitReason = exitReason
	ps.LastActivityAt = now
	cwd := ps.Cwd
	sm.mu.Unlock()

	// Scheme A/C: release cwd registry slot and file locks.
	sm.unregisterCwd(sessionID, cwd)
	if sm.fileLocks != nil {
		sm.fileLocks.ReleaseAll(sessionID)
	}

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         protocol.StatusExited,
		ExitReason:     exitReason,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

// DropGhostSession removes a terminal session that was registered from a
// ~/.claude/sessions/<pid>.json metadata file but whose JSONL never materialised
// (so the tailer could never start). Claude Code writes such transient metadata
// on `--continue` (a short-lived session id whose conversation actually lands in
// the original/resumed <id>.jsonl), and pocketctl would otherwise leave a dangling
// tailer-less entry in sm.sessions — the daemon-side seed of the "phantom session
// with only status + time" symptom. Only drops if no tailer was ever attached and
// the session is terminal-sourced (never daemon-spawned). Returns true if dropped.
func (sm *SessionManager) DropGhostSession(sessionID string) bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return false
	}
	// Guard: never drop a session that has a live tailer or a spawned process —
	// those are real sessions, not ghosts.
	if ps.Tailer != nil || ps.Source != "terminal" || ps.Cmd != nil {
		return false
	}
	delete(sm.sessions, sessionID)
	return true
}

// SetSessionStatus updates a terminal session's status from watcher events.
func (sm *SessionManager) SetSessionStatus(sessionID, status string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	now := time.Now()
	ps.Status = status
	ps.LastActivityAt = now
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         status,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) ListSessions() []SessionInfo {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	var active, exited []SessionInfo
	for id, ps := range sm.sessions {
		info := SessionInfo{
			SessionID:      id,
			Status:         ps.Status,
			StartedAt:      ps.StartedAt,
			LastActivityAt: ps.LastActivityAt,
			Agent:          ps.Agent,
			Cwd:            ps.Cwd,
			Model:          ps.Model,
		}
		if ps.Status == protocol.StatusExited || ps.Status == protocol.StatusCompleted ||
			ps.Status == protocol.StatusError || ps.Status == protocol.StatusKilled {
			exited = append(exited, info)
		} else {
			active = append(active, info)
		}
	}

	// Active sessions first (most recently active first), then exited (most recently exited first)
	sort.Slice(active, func(i, j int) bool {
		return active[i].LastActivityAt.After(active[j].LastActivityAt)
	})
	sort.Slice(exited, func(i, j int) bool {
		return exited[i].LastActivityAt.After(exited[j].LastActivityAt)
	})

	return append(active, exited...)
}

// ActiveRootSessionIDs returns every root Agent process that consumes a
// concurrent-session slot. Idle and approval-blocked processes remain active;
// only terminal lifecycle states release the slot. Sub-agents are tracked in
// their own relation store rather than sm.sessions and therefore never appear.
func (sm *SessionManager) ActiveRootSessionIDs() []string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ids := make([]string, 0, len(sm.sessions))
	for id, ps := range sm.sessions {
		switch ps.Status {
		case protocol.StatusExited, protocol.StatusCompleted, protocol.StatusError, protocol.StatusKilled, protocol.StatusDisconnected:
			continue
		default:
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// UpdateLastActivity updates the LastActivityAt timestamp for a session.
// Used by terminal session JSONL tailer to track when events are received.
func (sm *SessionManager) UpdateLastActivity(sessionID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.LastActivityAt = time.Now()
	}
}

func (sm *SessionManager) remapSessionID(oldID, newID string) (cwd, agent string, changed bool) {
	if oldID == "" || newID == "" || oldID == newID {
		sm.mu.RLock()
		ps, ok := sm.sessions[oldID]
		sm.mu.RUnlock()
		if !ok {
			return "", "", false
		}
		return ps.Cwd, ps.Agent, false
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()
	ps, ok := sm.sessions[oldID]
	if !ok {
		return "", "", false
	}
	delete(sm.sessions, oldID)
	ps.SessionID = newID
	sm.sessions[newID] = ps

	if ps.Cwd != "" {
		key := normalizeCwd(ps.Cwd)
		if set, ok := sm.cwdSessions[key]; ok {
			delete(set, oldID)
			set[newID] = struct{}{}
		}
	}
	return ps.Cwd, ps.Agent, true
}

// GetSessionCwd returns the working directory for a session and whether the
// session exists. Used to resolve which command sources to scan for a session.
func (sm *SessionManager) GetSessionCwd(sessionID string) (string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return "", false
	}
	return ps.Cwd, true
}

// GetWorktreeInfo returns the (path, branch) of a session's worktree (Scheme D).
// The bool is false for non-worktree sessions or unknown session ids.
func (sm *SessionManager) GetWorktreeInfo(sessionID string) (string, string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok || ps.WorktreePath == "" {
		return "", "", false
	}
	return ps.WorktreePath, ps.WorktreeBranch, true
}

// GetSessionAgent returns the agent type for a session (e.g. "claude-code",
// "codex") and whether the session exists. Used by command handlers to pick the
// right adapter / capability set. Returns ("claude-code", false) for unknown ids
// so callers default to Claude behavior.
func (sm *SessionManager) GetSessionAgent(sessionID string) (string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return adapter.AgentClaude, false
	}
	if ps.Agent == "" {
		return adapter.AgentClaude, true
	}
	return ps.Agent, true
}

// GetSessionModel returns the resolved model name for a session (the same value
// passed to claude via --model at launch). Surfaced to the web client via the
// session_created event so /model can show the active model. The bool indicates
// whether the session exists.
func (sm *SessionManager) GetSessionModel(sessionID string) (string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return "", false
	}
	return ps.Model, true
}

// SetSessionModel caches the resolved model for a session — e.g. a model extracted
// from a terminal session's JSONL on first get_session_meta, so subsequent reads are free.
func (sm *SessionManager) SetSessionModel(sessionID, model string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.Model = model
	}
}

// GetSessionSlashCommands returns the slash commands the agent reported as
// available in its init event for this session. Empty for terminal sessions
// or sessions whose agent hasn't emitted init yet. The bool indicates whether
// the session exists.
func (sm *SessionManager) GetSessionSlashCommands(sessionID string) ([]string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return nil, false
	}
	return ps.SlashCommands, true
}

type SessionInfo struct {
	SessionID      string    `json:"session_id"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"started_at"`
	LastActivityAt time.Time `json:"last_activity_at"`
	Agent          string    `json:"agent"`
	Cwd            string    `json:"cwd"`
	Model          string    `json:"model,omitempty"`
}
