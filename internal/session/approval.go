package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// handleApprovalRequest is the approval server's OnRequest callback. It flips
// the session to waiting_approval and emits an approval_request event so the
// web/iOS client renders an inline Yes/No card. Invoked from the server's
// accept goroutine — must not block (it only emits events).
func (sm *SessionManager) handleApprovalRequest(req approval.Request) {
	sm.mu.Lock()
	ps, ok := sm.sessions[req.SessionID]
	if !ok {
		// Unknown session — this happens when a `claude` the user launched in
		// their own terminal fired the user-global PreToolUse hook before the
		// JSONL watcher registered it (or the daemon simply isn't tailing it).
		// Rather than deny (which would block the user's terminal for no reason),
		// register a lightweight terminal-sourced placeholder so the ApprovalCard
		// can still surface. The real watcher-driven registration will upgrade it
		// (RegisterTerminalSession reuses an existing entry by id) when it lands.
		now := time.Now()
		ps = &ProcessState{
			SessionID:      req.SessionID,
			Status:         protocol.StatusWaitingApproval,
			StartedAt:      now,
			LastActivityAt: now,
			Cwd:            req.Cwd,
			Agent:          "claude-code",
			Source:         "terminal",
		}
		sm.sessions[req.SessionID] = ps
		ok = true
	}
	ps.Status = protocol.StatusWaitingApproval
	ps.PendingRequestID = req.RequestID
	sm.mu.Unlock()

	// ok is always true here (we created the placeholder above when missing);
	// the guard is retained for clarity and future callers that may pass a
	// non-creatable request.
	_ = ok

	sm.outputCh <- protocol.DaemonEvent{
		Type:      "approval_request",
		SessionID: req.SessionID,
		RequestID: req.RequestID,
		Tool:      req.Tool,
		Input:     req.Input,
	}
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      req.SessionID,
		Status:         protocol.StatusWaitingApproval,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}
}

// handleApprovalCancel is the approval server's OnCancel callback: a pending
// tool-use request was resolved OUT-OF-BAND — a user-launched terminal session
// answered the [y/n] prompt locally (allow non-nil), or the hook went away
// (allow nil). The server has already dropped the pending entry; here we clear
// the session's waiting_approval state and tell clients to dismiss the now-stale
// approval card (with the terminal-side result when known) so a second device
// can't re-answer it. Invoked from the server's accept goroutine — must not block.
func (sm *SessionManager) handleApprovalCancel(requestID, sessionID string, allow *bool) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	cleared := ok && ps.PendingRequestID == requestID
	if cleared {
		ps.PendingRequestID = ""
		if ps.Status == protocol.StatusWaitingApproval {
			ps.Status = protocol.StatusRunning
		}
		ps.LastActivityAt = time.Now()
	}
	sm.mu.Unlock()
	if !cleared {
		return
	}

	// Dismiss the card on every client. Carry the decision when the terminal
	// actually answered (allow non-nil) so the card shows allowed/denied rather
	// than vanishing; a bare disconnect just clears it.
	if allow != nil {
		sm.outputCh <- protocol.DaemonEvent{
			Type:      "approval_resolved",
			SessionID: sessionID,
			RequestID: requestID,
			Approved:  *allow,
		}
	}
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         protocol.StatusRunning,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}
}

// handleOpencodePermission surfaces an opencode permission.asked event as an
// approval_request card (mirroring handleApprovalRequest for Claude) and arms a
// fail-safe: if no client answers within opencodeApprovalTimeout, the permission
// is auto-rejected so an unattended turn doesn't hang forever. The reply path is
// ResolveApproval → ReplyPermission (already wired for opencode sessions).
func (sm *SessionManager) handleOpencodePermission(sessionID, requestID, tool string, input json.RawMessage) {
	if sessionID == "" || requestID == "" {
		return
	}
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok || ps.PendingRequestID == requestID { // unknown session, or already surfaced (SSE may repeat)
		sm.mu.Unlock()
		return
	}
	ps.Status = protocol.StatusWaitingApproval
	ps.PendingRequestID = requestID
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:      "approval_request",
		SessionID: sessionID,
		RequestID: requestID,
		Tool:      tool,
		Input:     input,
	}
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         protocol.StatusWaitingApproval,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}

	// Fail-safe auto-reject (chosen policy: timeout → reject).
	go func() {
		time.Sleep(opencodeApprovalTimeout)
		sm.mu.RLock()
		p, ok := sm.sessions[sessionID]
		stillPending := ok && p.PendingRequestID == requestID
		sm.mu.RUnlock()
		if stillPending {
			slog.Info("opencode permission auto-rejected (no client response)", "session", sessionID, "req", requestID)
			_ = sm.ResolveApproval(sessionID, requestID, false)
		}
	}()
}

// clearOpencodePermissionReplied clears a session's pending approval when its
// permission was answered (e.g. via our reply, or directly), so the waiting state
// doesn't linger.
func (sm *SessionManager) clearOpencodePermissionReplied(sessionID, requestID string) {
	if sessionID == "" {
		return
	}
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	cleared := ok && ps.PendingRequestID == requestID
	if cleared {
		ps.PendingRequestID = ""
		ps.Status = protocol.StatusRunning
		ps.LastActivityAt = time.Now()
	}
	sm.mu.Unlock()
	if cleared {
		sm.outputCh <- protocol.DaemonEvent{Type: "session_status", SessionID: sessionID, Status: protocol.StatusRunning}
	}
}

// ResolveApproval delivers a client's approval decision to the blocked
// PreToolUse hook and returns the session to running. Called from the
// approval_response command handler.
func (sm *SessionManager) ResolveApproval(sessionID, requestID string, approved bool) error {
	// opencode sessions answer permission prompts via the serve API, not the
	// claude PreToolUse hook socket.
	if b := sm.opencodeBackendFor(sessionID); b != nil {
		decision := "reject"
		if approved {
			decision = "once"
		}
		sm.clearPendingApproval(sessionID, requestID)
		if err := b.coord.server.ReplyPermission(context.Background(), sessionID, requestID, decision); err != nil {
			return err
		}
		// Persist the decision so a refresh/replay (and other devices) reconstruct
		// the answered card instead of re-rendering it as pending.
		sm.outputCh <- protocol.DaemonEvent{Type: "approval_resolved", SessionID: sessionID, RequestID: requestID, Approved: approved}
		sm.outputCh <- protocol.DaemonEvent{Type: "session_status", SessionID: sessionID, Status: protocol.StatusRunning}
		return nil
	}
	if sm.approvals == nil {
		return fmt.Errorf("approval not configured on this daemon")
	}
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if ok && ps.PendingRequestID == requestID {
		ps.PendingRequestID = ""
		ps.Status = protocol.StatusRunning
		ps.LastActivityAt = time.Now()
	}
	sm.mu.Unlock()

	if err := sm.approvals.Resolve(requestID, approved); err != nil {
		return err
	}

	// Persist the decision so a refresh/replay (and other devices) reconstruct
	// the answered card instead of re-rendering it as pending. Keyed by
	// request_id; the clicking client already flipped its card optimistically
	// and the pending-only guard on the client makes this a no-op there.
	sm.outputCh <- protocol.DaemonEvent{Type: "approval_resolved", SessionID: sessionID, RequestID: requestID, Approved: approved}

	if ok {
		// Hook resolved → Claude proceeds; reflect running state to clients.
		sm.outputCh <- protocol.DaemonEvent{
			Type:           "session_status",
			SessionID:      sessionID,
			Status:         protocol.StatusRunning,
			LastActivityAt: time.Now().UTC().Format(time.RFC3339),
		}
	}
	return nil
}
