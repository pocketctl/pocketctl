package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const InteractionResolvedElsewhere = protocol.InteractionResolvedElsewhere

// ResolvedElsewhereError is a successful convergence result: OpenCode's
// authority no longer has the request because another terminal or remote
// client answered first. Callers should dismiss the correlated card rather
// than presenting this as a failed operation.
type ResolvedElsewhereError struct {
	RequestID string
}

func (e *ResolvedElsewhereError) Error() string {
	return fmt.Sprintf("interaction %s was resolved elsewhere", e.RequestID)
}

func (e *ResolvedElsewhereError) Code() string              { return InteractionResolvedElsewhere }
func (e *ResolvedElsewhereError) ResolvedRequestID() string { return e.RequestID }

// handleApprovalRequest is the approval server's OnRequest callback. It flips
// the session to waiting_approval and emits an approval_request event so the
// web/iOS client renders an inline Yes/No card. Invoked from the server's
// accept goroutine — must not block (it only emits events).
func (sm *SessionManager) handleApprovalRequest(req approval.Request) {
	if sm.claudeApprovalV2 {
		sm.handleClaudeApprovalRequest(req)
		return
	}
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

func permissionEvent(sessionID string, pending PendingOpenCodePermission, policyMode trustedActionPolicyMode) protocol.DaemonEvent {
	event := protocol.DaemonEvent{
		Type: "approval_request", SessionID: sessionID, RequestID: pending.RequestID,
		Tool: pending.Permission, PermissionName: pending.Permission, Patterns: pending.Patterns,
		Always: pending.Always, Metadata: pending.Metadata, Input: pending.Metadata,
		ToolMessageID: pending.ToolMessageID, ToolCallID: pending.ToolCallID,
		PermissionVersion: pending.ProtocolVersion,
	}
	event.RiskLevel, event.RiskIncomplete, event.RiskReasons = openCodePermissionAttentionRisk(pending.Permission)
	event.SecurityContext = securityContextForPublication(policyMode, pending.securityContext)
	return event
}

func questionEvent(sessionID string, pending PendingOpenCodeQuestion) protocol.DaemonEvent {
	event := protocol.DaemonEvent{
		Type: "question_request", SessionID: sessionID, RequestID: pending.RequestID,
		Questions: pending.Questions, ToolMessageID: pending.ToolMessageID, ToolCallID: pending.ToolCallID,
	}
	event.RiskLevel, event.RiskIncomplete, event.RiskReasons = conservativeAttentionRisk(protocol.RiskReasonRequiresUserInput)
	return event
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
	riskLevel, riskIncomplete, riskReasons := openCodePermissionAttentionRisk(request.Permission)
	nativeActions := []string{"once"}
	if len(request.Always) > 0 {
		nativeActions = append(nativeActions, "always")
	}
	nativeActions = append(nativeActions, "reject")
	incomplete := riskIncomplete == nil || *riskIncomplete
	securityContext := approvalSecurityContext(riskLevel, incomplete, riskReasons, nativeActions)
	pending.securityContext = &securityContext
	sm.mu.Lock()
	ps, ok := sm.sessions[request.SessionID]
	if !ok || ps.ControlMode != protocol.ControlManaged {
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

	sm.outputCh <- permissionEvent(request.SessionID, pending, sm.trustedActionPolicy)
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
	if !ok || ps.ControlMode != protocol.ControlManaged {
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

// applyOpencodeRuntimeStatus stores the native/fallback runtime state while
// preserving pending interaction priority for both daemon logic and clients.
func (sm *SessionManager) applyOpencodeRuntimeStatus(sessionID, runtimeStatus string) string {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return runtimeStatus
	}
	status := runtimeStatus
	if pending := pendingInteractionStatus(ps); pending != protocol.StatusIdle {
		status = pending
	}
	ps.Status = status
	ps.LastActivityAt = time.Now()
	return status
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
		out = append(out, permissionEvent(sessionID, request, sm.trustedActionPolicy))
	}
	for _, request := range questions {
		out = append(out, questionEvent(sessionID, request))
	}
	return out
}

// reconcileOpencodePermissionSnapshot applies one successful authoritative
// pending-list response. targetSession is empty for the global legacy list.
func (sm *SessionManager) reconcileOpencodePermissionSnapshot(targetSession, version string, observed []adapter.PermissionAsked) []string {
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
	var statusSessions []string
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
			statusSessions = append(statusSessions, request.sessionID)
		}
	}
	return statusSessions
}

func (sm *SessionManager) reconcileOpencodeQuestionSnapshot(targetSession, version string, observed []adapter.QuestionAsked) []string {
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
	var statusSessions []string
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
			statusSessions = append(statusSessions, request.sessionID)
		}
	}
	return statusSessions
}

// ResolveApproval delivers a client's approval decision to the blocked
// PreToolUse hook and returns the session to running. Called from the
// approval_response command handler.
func (sm *SessionManager) ResolveApproval(sessionID, requestID string, approved bool) error {
	ctx, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		return err
	}
	defer release()
	if broker := sm.codexInteractionBroker(); broker != nil && broker.KnowsApproval(sessionID, requestID) {
		action := "reject"
		if approved {
			action = "once"
		}
		return broker.ResolveApproval(ctx, sessionID, requestID, action)
	}
	// opencode sessions answer permission prompts via the serve API, not the
	// claude PreToolUse hook socket.
	if b := sm.opencodeBackendFor(sessionID); b != nil {
		decision := "reject"
		if approved {
			decision = "once"
		}
		_ = b
		return sm.resolveApprovalAction(ctx, sessionID, requestID, decision)
	}
	if sm.ClaudeChannelApprovalKnowsPublicRequest(sessionID, requestID) {
		action := "reject"
		if approved {
			action = "once"
		}
		return sm.resolveClaudeChannelApproval(sessionID, requestID, action)
	}
	if sm.approvals == nil {
		return fmt.Errorf("approval not configured on this daemon")
	}
	if sm.routesClaudeApproval(sessionID) {
		return sm.resolveClaudeApproval(sessionID, requestID, approved)
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
	ctx, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		return err
	}
	defer release()
	return sm.resolveApprovalAction(ctx, sessionID, requestID, action)
}

func (sm *SessionManager) resolveApprovalAction(ctx context.Context, sessionID, requestID, action string) error {
	if broker := sm.codexInteractionBroker(); broker != nil && broker.KnowsApproval(sessionID, requestID) {
		return broker.ResolveApproval(ctx, sessionID, requestID, action)
	}
	if !protocol.ValidApprovalAction(action) {
		return fmt.Errorf("invalid approval action %q", action)
	}
	b := sm.opencodeBackendFor(sessionID)
	if b == nil {
		if sm.ClaudeChannelApprovalKnowsPublicRequest(sessionID, requestID) {
			return sm.resolveClaudeChannelApproval(sessionID, requestID, action)
		}
		return fmt.Errorf("opencode session not found")
	}
	if b.coord == nil || b.coord.srv() == nil {
		return fmt.Errorf("opencode session not found")
	}
	b.coord.interactionMu.Lock()
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	if ps == nil || ps.ControlMode != protocol.ControlManaged {
		sm.mu.RUnlock()
		b.coord.interactionMu.Unlock()
		return fmt.Errorf("opencode session is not managed for remote interaction")
	}
	request, ok := ps.PendingPermissions[requestID]
	directory := ps.Cwd
	sm.mu.RUnlock()
	if !ok {
		resolved := b.coord.interactionResolved("permission", sessionID, requestID)
		b.coord.interactionMu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return fmt.Errorf("permission request not pending in session")
	}
	if err := sm.enforceTrustedApprovalAction("opencode", request.securityContext, action); err != nil {
		b.coord.interactionMu.Unlock()
		return err
	}
	b.coord.bumpInteractionGeneration(sessionID, "permission", request.ProtocolVersion)
	b.coord.interactionMu.Unlock()
	if err := b.coord.srv().ReplyPermissionVersionedInDirectory(context.Background(), sessionID, requestID, action, request.ProtocolVersion, directory); err != nil {
		if opencodeNotPendingStatus(err) && sm.confirmPermissionResolvedElsewhere(b.coord, sessionID, requestID, request.ProtocolVersion, directory) {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return err
	}
	b.coord.interactionMu.Lock()
	cleared := sm.clearOpencodePermission(sessionID, requestID)
	if !cleared {
		resolved := b.coord.interactionResolved("permission", sessionID, requestID)
		b.coord.interactionMu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return fmt.Errorf("permission request not pending in session")
	}
	b.coord.markInteractionResolved("permission", sessionID, requestID)
	b.coord.bumpInteractionGeneration(sessionID, "permission", request.ProtocolVersion)
	sm.outputCh <- protocol.DaemonEvent{
		Type: "approval_resolved", SessionID: sessionID, RequestID: requestID,
		Action: action, Approved: action != "reject",
	}
	b.coord.interactionMu.Unlock()
	sm.reconcileOpencodeInteractionStatus(sessionID, b)
	return nil
}

func opencodeNotPendingStatus(err error) bool {
	var statusErr *adapter.OpencodeHTTPStatusError
	return errors.As(err, &statusErr) && (statusErr.StatusCode == http.StatusNotFound || statusErr.StatusCode == http.StatusConflict)
}

func (sm *SessionManager) confirmPermissionResolvedElsewhere(coord *opencodeCoordinator, sessionID, requestID, version, directory string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var (
		observed []adapter.PermissionAsked
		err      error
	)
	if version == adapter.PermissionVersionLegacy {
		observed, err = coord.srv().ListPermissions(ctx, directory)
	} else {
		observed, err = coord.srv().ListPermissionsV2(ctx, sessionID)
	}
	if err != nil || permissionStillPending(observed, sessionID, requestID) {
		return false
	}
	coord.interactionMu.Lock()
	cleared := sm.clearOpencodePermission(sessionID, requestID)
	coord.markInteractionResolved("permission", sessionID, requestID)
	coord.bumpInteractionGeneration(sessionID, "permission", version)
	if cleared {
		sm.outputCh <- protocol.DaemonEvent{
			Type: "approval_resolved", SessionID: sessionID, RequestID: requestID, Reason: InteractionResolvedElsewhere,
		}
	}
	coord.interactionMu.Unlock()
	if cleared {
		sm.emitCurrentInteractionStatus(sessionID)
	}
	return true
}

func permissionStillPending(observed []adapter.PermissionAsked, sessionID, requestID string) bool {
	for _, request := range observed {
		if request.SessionID == sessionID && request.ID == requestID {
			return true
		}
	}
	return false
}

func (sm *SessionManager) ResolveQuestion(sessionID, requestID string, answers [][]string) error {
	ctx, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		return err
	}
	defer release()
	if broker := sm.codexInteractionBroker(); broker != nil && broker.KnowsQuestion(sessionID, requestID) {
		return broker.ResolveQuestion(ctx, sessionID, requestID, answers)
	}
	b := sm.opencodeBackendFor(sessionID)
	if b == nil || b.coord == nil || b.coord.srv() == nil {
		return fmt.Errorf("opencode session not found")
	}
	b.coord.interactionMu.Lock()
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	if ps == nil || ps.ControlMode != protocol.ControlManaged {
		sm.mu.RUnlock()
		b.coord.interactionMu.Unlock()
		return fmt.Errorf("opencode session is not managed for remote interaction")
	}
	request, ok := ps.PendingQuestions[requestID]
	directory := ps.Cwd
	sm.mu.RUnlock()
	if !ok {
		resolved := b.coord.interactionResolved("question", sessionID, requestID)
		b.coord.interactionMu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return fmt.Errorf("question request not pending in session")
	}
	if err := protocol.ValidateQuestionAnswers(request.Questions, answers); err != nil {
		b.coord.interactionMu.Unlock()
		return err
	}
	b.coord.bumpInteractionGeneration(sessionID, "question", request.ProtocolVersion)
	b.coord.interactionMu.Unlock()
	if err := b.coord.srv().ReplyQuestionVersioned(context.Background(), sessionID, requestID, answers, request.ProtocolVersion, directory); err != nil {
		if opencodeNotPendingStatus(err) && sm.confirmQuestionResolvedElsewhere(b.coord, sessionID, requestID, request.ProtocolVersion, directory) {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return err
	}
	b.coord.interactionMu.Lock()
	cleared := sm.clearOpencodeQuestion(sessionID, requestID)
	if !cleared {
		resolved := b.coord.interactionResolved("question", sessionID, requestID)
		b.coord.interactionMu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return fmt.Errorf("question request not pending in session")
	}
	b.coord.markInteractionResolved("question", sessionID, requestID)
	b.coord.bumpInteractionGeneration(sessionID, "question", request.ProtocolVersion)
	sm.outputCh <- protocol.DaemonEvent{Type: "question_resolved", SessionID: sessionID, RequestID: requestID, Answers: answers}
	b.coord.interactionMu.Unlock()
	sm.reconcileOpencodeInteractionStatus(sessionID, b)
	return nil
}

func (sm *SessionManager) confirmQuestionResolvedElsewhere(coord *opencodeCoordinator, sessionID, requestID, version, directory string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var (
		observed []adapter.QuestionAsked
		err      error
	)
	if version == adapter.PermissionVersionLegacy {
		observed, err = coord.srv().ListQuestions(ctx, directory)
	} else {
		observed, err = coord.srv().ListQuestionsV2(ctx, sessionID)
	}
	if err != nil || questionStillPending(observed, sessionID, requestID) {
		return false
	}
	coord.interactionMu.Lock()
	cleared := sm.clearOpencodeQuestion(sessionID, requestID)
	coord.markInteractionResolved("question", sessionID, requestID)
	coord.bumpInteractionGeneration(sessionID, "question", version)
	if cleared {
		sm.outputCh <- protocol.DaemonEvent{
			Type: "question_resolved", SessionID: sessionID, RequestID: requestID, Reason: InteractionResolvedElsewhere,
		}
	}
	coord.interactionMu.Unlock()
	if cleared {
		sm.emitCurrentInteractionStatus(sessionID)
	}
	return true
}

func questionStillPending(observed []adapter.QuestionAsked, sessionID, requestID string) bool {
	for _, request := range observed {
		if request.SessionID == sessionID && request.ID == requestID {
			return true
		}
	}
	return false
}

func (sm *SessionManager) RejectQuestion(sessionID, requestID string) error {
	ctx, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		return err
	}
	defer release()
	if broker := sm.codexInteractionBroker(); broker != nil && broker.KnowsQuestion(sessionID, requestID) {
		return broker.RejectQuestion(ctx, sessionID, requestID)
	}
	b := sm.opencodeBackendFor(sessionID)
	if b == nil || b.coord == nil || b.coord.srv() == nil {
		return fmt.Errorf("opencode session not found")
	}
	b.coord.interactionMu.Lock()
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	if ps == nil || ps.ControlMode != protocol.ControlManaged {
		sm.mu.RUnlock()
		b.coord.interactionMu.Unlock()
		return fmt.Errorf("opencode session is not managed for remote interaction")
	}
	request, ok := ps.PendingQuestions[requestID]
	directory := ps.Cwd
	sm.mu.RUnlock()
	if !ok {
		resolved := b.coord.interactionResolved("question", sessionID, requestID)
		b.coord.interactionMu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return fmt.Errorf("question request not pending in session")
	}
	b.coord.bumpInteractionGeneration(sessionID, "question", request.ProtocolVersion)
	b.coord.interactionMu.Unlock()
	if err := b.coord.srv().RejectQuestionVersioned(context.Background(), sessionID, requestID, request.ProtocolVersion, directory); err != nil {
		if opencodeNotPendingStatus(err) && sm.confirmQuestionResolvedElsewhere(b.coord, sessionID, requestID, request.ProtocolVersion, directory) {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return err
	}
	b.coord.interactionMu.Lock()
	cleared := sm.clearOpencodeQuestion(sessionID, requestID)
	if !cleared {
		resolved := b.coord.interactionResolved("question", sessionID, requestID)
		b.coord.interactionMu.Unlock()
		if resolved {
			return &ResolvedElsewhereError{RequestID: requestID}
		}
		return fmt.Errorf("question request not pending in session")
	}
	b.coord.markInteractionResolved("question", sessionID, requestID)
	b.coord.bumpInteractionGeneration(sessionID, "question", request.ProtocolVersion)
	sm.outputCh <- protocol.DaemonEvent{Type: "question_resolved", SessionID: sessionID, RequestID: requestID, Rejected: true}
	b.coord.interactionMu.Unlock()
	sm.reconcileOpencodeInteractionStatus(sessionID, b)
	return nil
}

// ResolveMcpElicitation answers a Codex app-server MCP elicitation through the
// same first-writer-wins interaction broker used by approvals and questions.
func (sm *SessionManager) ResolveMcpElicitation(sessionID, requestID, action string, content json.RawMessage) error {
	ctx, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		return err
	}
	defer release()
	broker := sm.codexInteractionBroker()
	if broker == nil || !broker.KnowsMcpElicitation(sessionID, requestID) {
		return fmt.Errorf("Codex MCP elicitation is not pending")
	}
	return broker.ResolveMcpElicitation(ctx, sessionID, requestID, action, content)
}

func (sm *SessionManager) reconcileOpencodeInteractionStatus(sessionID string, b *serverBackend) {
	status := protocol.StatusIdle
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	cwd, _ := sm.GetSessionCwd(sessionID)
	usedNative := false
	if statuses, err := b.coord.srv().ListSessionStatuses(ctx, cwd); err == nil {
		if native, ok := statuses[sessionID]; ok {
			status = native.Type
			usedNative = status == protocol.StatusBusy || status == protocol.StatusRetry || status == protocol.StatusIdle
		}
	}
	if !usedNative {
		if messages, err := b.coord.srv().GetMessages(ctx, sessionID, cwd); err == nil && adapter.OpencodeMessagesRunning(messages) {
			status = protocol.StatusRunning
		}
	}
	cancel()
	status = sm.applyOpencodeRuntimeStatus(sessionID, status)
	sm.emitInteractionStatus(sessionID, status)
}
