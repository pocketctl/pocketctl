package session

import (
	"context"
	"fmt"
	"time"
)

// ValidEffortLevels are the thinking-effort levels exposed by Claude Code's TUI
// via the /effort command. Kept in the order shown by the TUI picker.
var ValidEffortLevels = []string{"low", "medium", "high", "xhigh", "max", "ultracode"}

// isValidEffort reports whether level is one of the TUI's accepted effort values.
func isValidEffort(level string) bool {
	for _, v := range ValidEffortLevels {
		if v == level {
			return true
		}
	}
	return false
}

// SetPermissionMode cycles the Claude TUI's permission mode via Shift+Tab.
// Only works for daemon (PTY) sessions. The cycle order is default→acceptEdits→plan;
// we calculate how many Shift+Tab presses are needed based on the current mode.
func (sm *SessionManager) SetPermissionMode(ctx context.Context, sessionID, targetMode string) error {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found")
	}
	if ps.Source != "daemon" || ps.PTY == nil {
		return fmt.Errorf("only daemon (interactive) sessions support runtime mode switch")
	}

	cycle := []string{"default", "acceptEdits", "plan"}
	currentIdx := indexOfString(cycle, ps.PermissionMode)
	if currentIdx == -1 {
		currentIdx = 1 // unknown → assume acceptEdits (the daemon default)
	}
	targetIdx := indexOfString(cycle, targetMode)
	if targetIdx == -1 {
		return fmt.Errorf("unsupported permission mode: %s (use default/acceptEdits/plan)", targetMode)
	}

	presses := (targetIdx - currentIdx + len(cycle)) % len(cycle)
	for i := 0; i < presses; i++ {
		if _, err := ps.PTY.Write([]byte("\x1b[Z")); err != nil { // Shift+Tab (CSI Z)
			return fmt.Errorf("pty write shift+tab: %w", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(150 * time.Millisecond): // let TUI process each press
		}
	}
	return nil
}

// SetEffort switches the Claude TUI's thinking-effort level for a daemon (PTY)
// session by injecting `/effort <level>` followed by Enter, mirroring how a
// user would type it in the terminal. Only daemon sessions support runtime
// effort switching. The chosen level is recorded on ProcessState so a later
// get_session_meta can surface it to the web/iOS client. Terminal sessions and
// unknown sessions return an error.
//
// Note: claude's effort level is a pure runtime TUI state — it is NOT persisted
// to JSONL or ~/.claude/settings.json, so this recorded value reflects only what
// was set via pocketctl, not what a user may type directly in the terminal.
func (sm *SessionManager) SetEffort(sessionID, level string) error {
	if !isValidEffort(level) {
		return fmt.Errorf("unsupported effort level: %s (use one of %v)", level, ValidEffortLevels)
	}
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found")
	}
	if ps.Source != "daemon" || ps.PTY == nil {
		return fmt.Errorf("only daemon (interactive) sessions support runtime effort switch")
	}

	if _, err := ps.PTY.Write([]byte("/effort " + level + "\r")); err != nil {
		return fmt.Errorf("pty write /effort: %w", err)
	}

	sm.mu.Lock()
	ps.Effort = level
	sm.mu.Unlock()
	return nil
}

// GetSessionEffort returns the last-set thinking-effort level for a session, or
// "" if none has been set / the session is unknown. Used by get_session_meta.
func (sm *SessionManager) GetSessionEffort(sessionID string) string {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		return ""
	}
	return ps.Effort
}

// InterruptSession stops the agent's current generation without killing the
// session. For daemon (PTY) sessions it writes Ctrl+C (\x03) to the PTY,
// which Claude's TUI interprets as "interrupt current turn". For terminal
// sessions it cancels the --resume subprocess. The session stays alive and
// returns to idle state (driven by the JSONL tailer or the resume goroutine).
func (sm *SessionManager) InterruptSession(sessionID string) error {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found")
	}

	// Server-kind sessions (opencode) abort via their backend (HTTP), not a PTY.
	if ps.Backend != nil {
		return ps.Backend.Interrupt(sessionID)
	}

	if ps.Source == "daemon" && ps.PTY != nil {
		// Ctrl+C (ETX) — Claude TUI stops the current generation and returns
		// to the input prompt. The JSONL tailer will push an idle status.
		if _, err := ps.PTY.Write([]byte{0x03}); err != nil {
			return fmt.Errorf("pty write ctrl+c: %w", err)
		}
		return nil
	}

	// Terminal session: cancel the --resume subprocess.
	if ps.Cancel != nil {
		ps.Cancel()
	}
	return nil
}

// UpdatePermissionMode records the current permission mode (called when a
// permission_mode_changed event is received from the JSONL tailer).
func (sm *SessionManager) UpdatePermissionMode(sessionID, mode string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.PermissionMode = mode
	}
}

// GetPermissionMode returns the current permission mode for a session.
func (sm *SessionManager) GetPermissionMode(sessionID string) string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		return ps.PermissionMode
	}
	return ""
}
