package session

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
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

func permissionEvent(sessionID string, pending PendingOpenCodePermission) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type: "approval_request", SessionID: sessionID, RequestID: pending.RequestID,
		Tool: pending.Permission, PermissionName: pending.Permission, Patterns: pending.Patterns,
		Always: pending.Always, Metadata: pending.Metadata, Input: pending.Metadata,
		ToolMessageID: pending.ToolMessageID, ToolCallID: pending.ToolCallID,
		PermissionVersion: pending.ProtocolVersion,
	}
}

func questionEvent(sessionID string, pending PendingOpenCodeQuestion) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type: "question_request", SessionID: sessionID, RequestID: pending.RequestID,
		Questions: pending.Questions, ToolMessageID: pending.ToolMessageID, ToolCallID: pending.ToolCallID,
	}
}

func (sm *SessionManager) handleOpencodePermission(request adapter.PermissionAsked) bool {
	if request.SessionID == "" || request.ID == "" {
		return false
	}
	pending := PendingOpenCodePermission{
		RequestID: request.ID, Permission: request.Permission, Patterns: request.Patterns,
		Always: request.Always, Metadata: append([]byte(nil), request.Metadata...),
		ToolMessageID: request.ToolMessageID, ToolCallID: request.ToolCallID,
		ProtocolVersion: request.Version,
	}
	sm.mu.Lock()
	ps, ok := sm.sessions[request.SessionID]
	if !ok {
		sm.mu.Unlock()
		return false
	}
	if ps.PendingPermissions == nil {
		ps.PendingPermissions = make(map[string]PendingOpenCodePermission)
	}
	if _, duplicate := ps.PendingPermissions[request.ID]; duplicate {
		sm.mu.Unlock()
		return false
	}
	ps.PendingPermissions[request.ID] = pending
	ps.Status = protocol.StatusWaitingApproval
	ps.LastActivityAt = time.Now()
	sm.mu.Unlock()

	sm.outputCh <- permissionEvent(request.SessionID, pending)
	sm.emitInteractionStatus(request.SessionID, protocol.StatusWaitingApproval)
	return true
}

func (sm *SessionManager) handleOpencodeQuestion(request adapter.QuestionAsked) bool {
	if request.SessionID == "" || request.ID == "" || len(request.Questions) == 0 {
		return false
	}
	pending := PendingOpenCodeQuestion{
		RequestID: request.ID, Questions: append([]protocol.QuestionInfo(nil), request.Questions...),
		ToolMessageID: request.ToolMessageID, ToolCallID: request.ToolCallID,
		ProtocolVersion: request.Version,
	}
	sm.mu.Lock()
	ps, ok := sm.sessions[request.SessionID]
	if !ok {
		sm.mu.Unlock()
		return false
	}
	if ps.PendingQuestions == nil {
		ps.PendingQuestions = make(map[string]PendingOpenCodeQuestion)
	}
	if _, duplicate := ps.PendingQuestions[request.ID]; duplicate {
		sm.mu.Unlock()
		return false
	}
	ps.PendingQuestions[request.ID] = pending
	if len(ps.PendingPermissions) == 0 {
		ps.Status = protocol.StatusWaitingQuestion
	}
	ps.LastActivityAt = time.Now()
	status := ps.Status
	sm.mu.Unlock()

	sm.outputCh <- questionEvent(request.SessionID, pending)
	sm.emitInteractionStatus(request.SessionID, status)
	return true
}

func (sm *SessionManager) emitInteractionStatus(sessionID, status string) {
	sm.outputCh <- protocol.DaemonEvent{
		Type: "session_status", SessionID: sessionID, Status: status,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func pendingInteractionStatus(ps *ProcessState) string {
	if len(ps.PendingPermissions) > 0 {
		return protocol.StatusWaitingApproval
	}
	if len(ps.PendingQuestions) > 0 {
		return protocol.StatusWaitingQuestion
	}
	return protocol.StatusIdle
}

func (sm *SessionManager) clearOpencodePermission(sessionID, requestID string) bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	ps, ok := sm.sessions[sessionID]
	if !ok || ps.PendingPermissions == nil {
		return false
	}
	if _, exists := ps.PendingPermissions[requestID]; !exists {
		return false
	}
	delete(ps.PendingPermissions, requestID)
	ps.Status = pendingInteractionStatus(ps)
	ps.LastActivityAt = time.Now()
	return true
}

func (sm *SessionManager) clearOpencodeQuestion(sessionID, requestID string) bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	ps, ok := sm.sessions[sessionID]
	if !ok || ps.PendingQuestions == nil {
		return false
	}
	if _, exists := ps.PendingQuestions[requestID]; !exists {
		return false
	}
	delete(ps.PendingQuestions, requestID)
	ps.Status = pendingInteractionStatus(ps)
	ps.LastActivityAt = time.Now()
	return true
}

func (sm *SessionManager) PendingOpencodeInteractions(sessionID string) []protocol.DaemonEvent {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.RUnlock()
		return nil
	}
	permissions := make([]PendingOpenCodePermission, 0, len(ps.PendingPermissions))
	for _, request := range ps.PendingPermissions {
		permissions = append(permissions, request)
	}
	questions := make([]PendingOpenCodeQuestion, 0, len(ps.PendingQuestions))
	for _, request := range ps.PendingQuestions {
		questions = append(questions, request)
	}
	sm.mu.RUnlock()
	sort.Slice(permissions, func(i, j int) bool { return permissions[i].RequestID < permissions[j].RequestID })
	sort.Slice(questions, func(i, j int) bool { return questions[i].RequestID < questions[j].RequestID })
	out := make([]protocol.DaemonEvent, 0, len(permissions)+len(questions))
	for _, request := range permissions {
		out = append(out, permissionEvent(sessionID, request))
	}
	for _, request := range questions {
		out = append(out, questionEvent(sessionID, request))
	}
	return out
}

// reconcileOpencodePermissionSnapshot applies one successful authoritative
// pending-list response. targetSession is empty for the global legacy list.
func (sm *SessionManager) reconcileOpencodePermissionSnapshot(targetSession, version string, observed []adapter.PermissionAsked) {
	seen := make(map[string]map[string]struct{})
	for _, request := range observed {
		if request.Version == "" {
			request.Version = version
		}
		sm.handleOpencodePermission(request)
		if seen[request.SessionID] == nil {
			seen[request.SessionID] = make(map[string]struct{})
		}
		seen[request.SessionID][request.ID] = struct{}{}
	}
	type staleRequest struct{ sessionID, requestID string }
	var stale []staleRequest
	sm.mu.RLock()
	for sessionID, ps := range sm.sessions {
		if targetSession != "" && sessionID != targetSession {
			continue
		}
		for requestID, pending := range ps.PendingPermissions {
			if pending.ProtocolVersion != version {
				continue
			}
			if _, ok := seen[sessionID][requestID]; !ok {
				stale = append(stale, staleRequest{sessionID, requestID})
			}
		}
	}
	sm.mu.RUnlock()
	for _, request := range stale {
		if sm.clearOpencodePermission(request.sessionID, request.requestID) {
			sm.outputCh <- protocol.DaemonEvent{Type: "approval_resolved", SessionID: request.sessionID, RequestID: request.requestID, Reason: "no_longer_pending"}
			sm.emitCurrentInteractionStatus(request.sessionID)
		}
	}
}

func (sm *SessionManager) reconcileOpencodeQuestionSnapshot(targetSession, version string, observed []adapter.QuestionAsked) {
	seen := make(map[string]map[string]struct{})
	for _, request := range observed {
		if request.Version == "" {
			request.Version = version
		}
		sm.handleOpencodeQuestion(request)
		if seen[request.SessionID] == nil {
			seen[request.SessionID] = make(map[string]struct{})
		}
		seen[request.SessionID][request.ID] = struct{}{}
	}
	type staleRequest struct{ sessionID, requestID string }
	var stale []staleRequest
	sm.mu.RLock()
	for sessionID, ps := range sm.sessions {
		if targetSession != "" && sessionID != targetSession {
			continue
		}
		for requestID, pending := range ps.PendingQuestions {
			if pending.ProtocolVersion != version {
				continue
			}
			if _, ok := seen[sessionID][requestID]; !ok {
				stale = append(stale, staleRequest{sessionID, requestID})
			}
		}
	}
	sm.mu.RUnlock()
	for _, request := range stale {
		if sm.clearOpencodeQuestion(request.sessionID, request.requestID) {
			sm.outputCh <- protocol.DaemonEvent{Type: "question_resolved", SessionID: request.sessionID, RequestID: request.requestID, Reason: "no_longer_pending"}
			sm.emitCurrentInteractionStatus(request.sessionID)
		}
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
		_ = b
		return sm.ResolveApprovalAction(sessionID, requestID, decision)
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

func (sm *SessionManager) ResolveApprovalAction(sessionID, requestID, action string) error {
	if !protocol.ValidApprovalAction(action) {
		return fmt.Errorf("invalid approval action %q", action)
	}
	b := sm.opencodeBackendFor(sessionID)
	if b == nil || b.coord == nil || b.coord.srv() == nil {
		return fmt.Errorf("opencode session not found")
	}
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	request, ok := ps.PendingPermissions[requestID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("permission request not pending in session")
	}
	if err := b.coord.srv().ReplyPermissionVersioned(context.Background(), sessionID, requestID, action, request.ProtocolVersion); err != nil {
		return err
	}
	sm.clearOpencodePermission(sessionID, requestID)
	sm.outputCh <- protocol.DaemonEvent{
		Type: "approval_resolved", SessionID: sessionID, RequestID: requestID,
		Action: action, Approved: action != "reject",
	}
	sm.reconcileOpencodeInteractionStatus(sessionID, b)
	return nil
}

func (sm *SessionManager) ResolveQuestion(sessionID, requestID string, answers [][]string) error {
	b := sm.opencodeBackendFor(sessionID)
	if b == nil || b.coord == nil || b.coord.srv() == nil {
		return fmt.Errorf("opencode session not found")
	}
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	request, ok := ps.PendingQuestions[requestID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("question request not pending in session")
	}
	if err := protocol.ValidateQuestionAnswers(request.Questions, answers); err != nil {
		return err
	}
	if err := b.coord.srv().ReplyQuestion(context.Background(), sessionID, requestID, answers); err != nil {
		return err
	}
	sm.clearOpencodeQuestion(sessionID, requestID)
	sm.outputCh <- protocol.DaemonEvent{Type: "question_resolved", SessionID: sessionID, RequestID: requestID, Answers: answers}
	sm.reconcileOpencodeInteractionStatus(sessionID, b)
	return nil
}

func (sm *SessionManager) RejectQuestion(sessionID, requestID string) error {
	b := sm.opencodeBackendFor(sessionID)
	if b == nil || b.coord == nil || b.coord.srv() == nil {
		return fmt.Errorf("opencode session not found")
	}
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	_, ok := ps.PendingQuestions[requestID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("question request not pending in session")
	}
	if err := b.coord.srv().RejectQuestion(context.Background(), sessionID, requestID); err != nil {
		return err
	}
	sm.clearOpencodeQuestion(sessionID, requestID)
	sm.outputCh <- protocol.DaemonEvent{Type: "question_resolved", SessionID: sessionID, RequestID: requestID, Rejected: true}
	sm.reconcileOpencodeInteractionStatus(sessionID, b)
	return nil
}

func (sm *SessionManager) reconcileOpencodeInteractionStatus(sessionID string, b *serverBackend) {
	status := protocol.StatusIdle
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if messages, err := b.coord.srv().GetMessages(ctx, sessionID); err == nil && adapter.OpencodeMessagesRunning(messages) {
		status = protocol.StatusRunning
	}
	cancel()
	sm.mu.Lock()
	if ps, ok := sm.sessions[sessionID]; ok {
		if pending := pendingInteractionStatus(ps); pending != protocol.StatusIdle {
			status = pending
		}
		ps.Status = status
		ps.LastActivityAt = time.Now()
	}
	sm.mu.Unlock()
	sm.emitInteractionStatus(sessionID, status)
}
