package session

import (
	"fmt"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

var claudeRuntimePermissionModes = []string{"manual", "acceptEdits", "plan"}
var claudeNextTurnPermissionModes = []string{"manual", "auto", "acceptEdits", "dontAsk", "plan", "bypassPermissions"}

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

// SetSessionEffort caches an actual non-empty effort reported by the agent.
// Empty metadata must not erase the latest known value.
func (sm *SessionManager) SetSessionEffort(sessionID, effort string) {
	effort = strings.TrimSpace(effort)
	if effort == "" {
		return
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.Effort = effort
	}
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
		// to the input prompt. An interrupted Claude turn does not append a
		// terminal JSONL record, so the tailer has nothing from which to infer
		// idle; publish it explicitly after the PTY accepted the interrupt.
		if _, err := ps.PTY.Write([]byte{0x03}); err != nil {
			return fmt.Errorf("pty write ctrl+c: %w", err)
		}
		sm.SetSessionStatus(sessionID, protocol.StatusIdle)
		return nil
	}

	// Terminal session: cancel the --resume subprocess.
	if ps.Cancel != nil {
		ps.Cancel()
	}
	return nil
}

func (sm *SessionManager) SetPermissionConfig(sessionID string, cfg *protocol.PermissionConfig) error {
	if cfg == nil {
		return fmt.Errorf("permission config is required")
	}
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return fmt.Errorf("session not found")
	}
	if err := adapter.ValidatePermissionConfig(ps.Agent, cfg); err != nil {
		sm.mu.Unlock()
		return err
	}
	if ps.Agent == adapter.AgentCodex && cfg.ApprovalPolicy != "" && cfg.ApprovalPolicy != "never" && ps.ControlMode != protocol.ControlManaged {
		sm.mu.Unlock()
		return fmt.Errorf("codex remote approval requires the managed app-server backend")
	}
	if ps.Status == protocol.StatusRunning || ps.Status == protocol.StatusWaitingApproval {
		sm.mu.Unlock()
		return fmt.Errorf("session_busy")
	}
	if ps.Source != "daemon" || ps.PTY == nil {
		ps.Permission = clonePermission(cfg)
		confirmed := clonePermission(ps.Permission)
		sm.mu.Unlock()
		sm.outputCh <- protocol.DaemonEvent{Type: "permission_config_changed", SessionID: sessionID, Permission: confirmed, PermissionEffective: "next_turn"}
		return nil
	}
	if ps.Agent == adapter.AgentClaude {
		targetIdx := indexString(claudeRuntimePermissionModes, cfg.Mode)
		if targetIdx < 0 {
			sm.mu.Unlock()
			return fmt.Errorf("permission mode %q is not runtime mutable", cfg.Mode)
		}
		current := ""
		if ps.Permission != nil {
			current = ps.Permission.Mode
		}
		currentIdx := indexString(claudeRuntimePermissionModes, current)
		if currentIdx == targetIdx {
			confirmed := clonePermission(ps.Permission)
			sm.mu.Unlock()
			sm.outputCh <- protocol.DaemonEvent{Type: "permission_config_changed", SessionID: sessionID, Permission: confirmed, PermissionEffective: "immediate"}
			return nil
		}
		presses := 1 + targetIdx
		if currentIdx >= 0 {
			presses = (targetIdx - currentIdx + len(claudeRuntimePermissionModes)) % len(claudeRuntimePermissionModes)
		}
		pty := ps.PTY
		sm.mu.Unlock()
		for i := 0; i < presses; i++ {
			if _, err := pty.Write([]byte("\x1b[Z")); err != nil {
				return fmt.Errorf("pty write shift+tab: %w", err)
			}
			if i+1 < presses {
				time.Sleep(150 * time.Millisecond)
			}
		}
		// The JSONL permission-mode record is authoritative; its parser emits
		// permission_config_changed only after Claude confirms the actual mode.
		return nil
	}
	ps.Permission = clonePermission(cfg)
	confirmed := clonePermission(ps.Permission)
	sm.mu.Unlock()
	sm.outputCh <- protocol.DaemonEvent{Type: "permission_config_changed", SessionID: sessionID, Permission: confirmed, PermissionEffective: "next_turn"}
	return nil
}

func (sm *SessionManager) GetPermissionMeta(sessionID string) (*protocol.PermissionConfig, bool, []string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return nil, false, nil, false
	}
	idle := ps.Status != protocol.StatusRunning && ps.Status != protocol.StatusWaitingApproval
	if !idle {
		return clonePermission(ps.Permission), false, nil, true
	}
	if ps.Agent == adapter.AgentClaude {
		if ps.Source == "daemon" && ps.PTY != nil {
			return clonePermission(ps.Permission), true, append([]string(nil), claudeRuntimePermissionModes...), true
		}
		return clonePermission(ps.Permission), true, append([]string(nil), claudeNextTurnPermissionModes...), true
	}
	return clonePermission(ps.Permission), ps.Agent == adapter.AgentCodex, nil, true
}

func indexString(values []string, target string) int {
	for i, value := range values {
		if value == target {
			return i
		}
	}
	return -1
}

// ObservePermissionEvent caches only agent-confirmed changes before the event
// is forwarded, keeping later session_meta responses authoritative.
func (sm *SessionManager) ObservePermissionEvent(event protocol.DaemonEvent) {
	if event.Type != "permission_config_changed" || event.Permission == nil {
		return
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[event.SessionID]; ok {
		ps.Permission = clonePermission(event.Permission)
	}
}
