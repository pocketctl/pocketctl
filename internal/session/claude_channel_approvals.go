package session

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/claudechannel"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const (
	ClaudeChannelApprovalPending       = "pending_remote"
	ClaudeChannelApprovalReserved      = "verdict_reserved"
	ClaudeChannelApprovalSubmitted     = "submitted_to_claude"
	ClaudeChannelApprovalResultUnknown = "result_unknown"
	// ClaudeChannelApprovalConfirmedByObservation is the terminal state
	// reached when the JSONL tailer observes the tool executing (or the
	// request ending) AFTER a verdict was submitted to Claude. It does NOT
	// imply allow or deny — it only means the remote card can be neutrally
	// dismissed because Claude made progress. Design §2.1/§2.2.
	ClaudeChannelApprovalConfirmedByObservation = "confirmed_by_observation"
	claudeChannelBindingGrace                    = 5 * time.Second
	claudeChannelApprovalTTL                     = 2 * time.Minute
)

type ClaudeChannelApprovalKey struct {
	InstanceID      string
	ClaudeRequestID string
}

type ClaudeChannelBinding struct {
	InstanceID           string
	ClaudeParentPID      int
	ChannelPID           int
	ProtocolVersion      string
	SessionID            string
	RegisteredAt         time.Time
	Connected            bool
	ProcessStartIdentity string
}

type PendingClaudeChannelApproval struct {
	PublicRequestID string
	SessionID       string
	Key             ClaudeChannelApprovalKey
	State           string
	CreatedAt       time.Time
	ExpiresAt       time.Time
	VerdictSent     bool
	ToolName        string
	Description     string
	InputPreview    string
	Responder       claudechannel.VerdictResponder
}

func claudeChannelPublicKey(sessionID, publicID string) string {
	return sessionID + "\x00" + publicID
}

func (sm *SessionManager) HandleClaudeChannelRegister(event claudechannel.RegisterEvent) {
	if event.InstanceID == "" || event.ClaudeParentPID <= 0 ||
		event.ProtocolVersion != claudechannel.MCPProtocolVersion {
		return
	}
	sm.mu.Lock()
	sm.claudeChannelInstances[event.InstanceID] = &ClaudeChannelBinding{
		InstanceID: event.InstanceID, ClaudeParentPID: event.ClaudeParentPID,
		ChannelPID: event.ChannelPID, ProtocolVersion: event.ProtocolVersion,
		RegisteredAt: time.Now(), Connected: true,
		ProcessStartIdentity: event.ProcessStartIdentity,
	}
	sessionID := ""
	for id, state := range sm.sessions {
		if claudeChannelBindingMatchesSession(state, sm.claudeChannelInstances[event.InstanceID]) {
			sessionID = id
			break
		}
	}
	sm.mu.Unlock()
	if sessionID != "" {
		sm.bindClaudeChannelForSession(sessionID)
	}
}

func claudeChannelBindingMatchesSession(state *ProcessState, binding *ClaudeChannelBinding) bool {
	if state == nil || binding == nil || state.Agent != adapter.AgentClaude || state.Source != "terminal" ||
		state.Pid <= 0 || state.Pid != binding.ClaudeParentPID {
		return false
	}
	switch state.Status {
	case protocol.StatusExited, protocol.StatusCompleted, protocol.StatusError,
		protocol.StatusKilled, protocol.StatusDisconnected:
		return false
	}
	if binding.ProcessStartIdentity != "" {
		return binding.ProcessStartIdentity == state.ProcessStartIdentity
	}
	// Compatibility fallback for synthetic/legacy registrations that do not
	// carry an OS process identity. Limit it to the initial binding window so a
	// stale terminal record cannot capture a reused PID.
	delta := binding.RegisteredAt.Sub(state.StartedAt)
	if delta < 0 {
		delta = -delta
	}
	return delta <= claudeChannelBindingGrace
}

func (sm *SessionManager) bindClaudeChannelForSession(sessionID string) {
	var publish []*PendingClaudeChannelApproval
	sm.mu.Lock()
	state := sm.sessions[sessionID]
	if state == nil || state.Agent != adapter.AgentClaude || state.Source != "terminal" || state.Pid <= 0 {
		sm.mu.Unlock()
		return
	}
	for _, binding := range sm.claudeChannelInstances {
		if !binding.Connected || !claudeChannelBindingMatchesSession(state, binding) {
			continue
		}
		if binding.SessionID != "" && binding.SessionID != sessionID {
			if previous := sm.sessions[binding.SessionID]; previous != nil && previous.ClaudeChannelInstanceID == binding.InstanceID {
				previous.ClaudeChannelInstanceID = ""
			}
		}
		binding.SessionID = sessionID
		state.ClaudeChannelInstanceID = binding.InstanceID
		now := time.Now()
		for _, pending := range sm.claudeChannelApprovals {
			if pending.Key.InstanceID != binding.InstanceID || pending.SessionID != "" ||
				now.Sub(pending.CreatedAt) > claudeChannelBindingGrace {
				continue
			}
			pending.SessionID = sessionID
			sm.claudeChannelPublic[claudeChannelPublicKey(sessionID, pending.PublicRequestID)] = pending
			publish = append(publish, pending)
		}
		break
	}
	sm.mu.Unlock()
	if len(publish) > 0 {
		if err := sm.persistClaudeApprovalReferences(); err != nil {
			for _, pending := range publish {
				sm.failUnpublishedClaudeChannelApproval(pending)
			}
			return
		}
	}
	for _, pending := range publish {
		sm.publishClaudeChannelRequest(pending)
	}
}

func (sm *SessionManager) failUnpublishedClaudeChannelApproval(pending *PendingClaudeChannelApproval) {
	sm.mu.Lock()
	if pending.State == ClaudeChannelApprovalPending {
		pending.State = ClaudeChannelApprovalResultUnknown
		delete(sm.claudeChannelPublic, claudeChannelPublicKey(pending.SessionID, pending.PublicRequestID))
	}
	responder := pending.Responder
	sm.mu.Unlock()
	responder.FailClosed()
}

func (sm *SessionManager) HandleClaudeChannelRequest(event claudechannel.RequestEvent) {
	if event.Responder == nil || event.InstanceID == "" || event.ShortRequestID == "" {
		return
	}
	if _, err := uuid.Parse(event.PublicRequestID); err != nil {
		event.Responder.FailClosed()
		return
	}
	now := time.Now()
	key := ClaudeChannelApprovalKey{InstanceID: event.InstanceID, ClaudeRequestID: event.ShortRequestID}
	sm.mu.Lock()
	if _, duplicate := sm.claudeChannelApprovals[key]; duplicate {
		sm.mu.Unlock()
		return
	}
	binding := sm.claudeChannelInstances[event.InstanceID]
	if binding == nil || !binding.Connected {
		sm.mu.Unlock()
		event.Responder.FailClosed()
		return
	}
	pending := &PendingClaudeChannelApproval{
		PublicRequestID: event.PublicRequestID, Key: key, State: ClaudeChannelApprovalPending,
		CreatedAt: now, ExpiresAt: now.Add(claudeChannelApprovalTTL), ToolName: event.ToolName,
		Description: event.Description, InputPreview: event.InputPreview, Responder: event.Responder,
	}
	if binding.SessionID != "" {
		pending.SessionID = binding.SessionID
		sm.claudeChannelPublic[claudeChannelPublicKey(binding.SessionID, event.PublicRequestID)] = pending
		if state := sm.sessions[binding.SessionID]; state != nil {
			state.Status = protocol.StatusWaitingApproval
			state.LastActivityAt = now
		}
	}
	sm.claudeChannelApprovals[key] = pending
	sm.mu.Unlock()
	// Two independent deadlines preserve the terminal-first invariant without
	// leaking an actionable remote card. An unbound request is never exposed;
	// a bound request is closed neutrally after its TTL. Neither path sends a
	// verdict to Claude, so the native terminal remains authoritative.
	time.AfterFunc(claudeChannelBindingGrace, func() {
		sm.expireUnboundClaudeChannelApproval(key, pending)
	})
	time.AfterFunc(claudeChannelApprovalTTL, func() {
		sm.expireClaudeChannelApproval(key, pending)
	})
	if pending.SessionID != "" {
		if err := sm.persistClaudeApprovalReferences(); err != nil {
			sm.failUnpublishedClaudeChannelApproval(pending)
			return
		}
		sm.publishClaudeChannelRequest(pending)
	}
}

func (sm *SessionManager) publishClaudeChannelRequest(pending *PendingClaudeChannelApproval) {
	input, _ := json.Marshal(pending.InputPreview)
	sm.outputCh <- protocol.DaemonEvent{
		Type: "approval_request", SessionID: pending.SessionID, RequestID: pending.PublicRequestID,
		Agent: adapter.AgentClaude, ApprovalKind: "claude_channel",
		AvailableDecisions: []string{"accept", "decline"}, Tool: pending.ToolName,
		Description: pending.Description, Input: input,
	}
	sm.outputCh <- protocol.DaemonEvent{
		Type: "session_status", SessionID: pending.SessionID, Status: protocol.StatusWaitingApproval,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) ClaudeChannelApprovalKnowsPublicRequest(sessionID, requestID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	_, ok := sm.claudeChannelPublic[claudeChannelPublicKey(sessionID, requestID)]
	return ok
}

func (sm *SessionManager) resolveClaudeChannelApproval(sessionID, requestID, action string) error {
	behavior := ""
	switch action {
	case "once":
		behavior = claudechannel.BehaviorAllow
	case "reject":
		behavior = claudechannel.BehaviorDeny
	default:
		return fmt.Errorf("Claude Channel approval only accepts once or reject")
	}
	sm.mu.Lock()
	pending := sm.claudeChannelPublic[claudeChannelPublicKey(sessionID, requestID)]
	if pending == nil {
		sm.mu.Unlock()
		return fmt.Errorf("Claude Channel approval is not pending")
	}
	if pending.State != ClaudeChannelApprovalPending || time.Now().After(pending.ExpiresAt) {
		sm.mu.Unlock()
		return &ResolvedElsewhereError{RequestID: requestID}
	}
	pending.State = ClaudeChannelApprovalReserved
	responder := pending.Responder
	sm.mu.Unlock()

	err := responder.Send(behavior)
	sm.mu.Lock()
	if pending.State != ClaudeChannelApprovalReserved {
		// A concurrent session/channel close won after reservation. Its neutral
		// closure is authoritative; never overwrite it with submitted merely
		// because an at-most-once responder returned a no-op success.
		sm.mu.Unlock()
		return nil
	}
	if err != nil {
		pending.State = ClaudeChannelApprovalResultUnknown
	} else {
		pending.State = ClaudeChannelApprovalSubmitted
		pending.VerdictSent = true
	}
	sm.mu.Unlock()
	_ = sm.persistClaudeApprovalReferences()
	status := "submitted"
	reason := "claude_result_unconfirmed"
	if err != nil {
		status = ClaudeChannelApprovalResultUnknown
		reason = "channel_write_failed"
	}
	sm.outputCh <- protocol.DaemonEvent{
		Type: "interaction_result", SessionID: sessionID, RequestID: requestID,
		Operation: "approval_response", Status: status, Reason: reason,
	}
	// interaction_result is intentionally origin-only in Relay. Broadcast a
	// neutral closure so every other device disables the card without claiming
	// that Claude accepted or denied the verdict.
	sm.outputCh <- protocol.DaemonEvent{
		Type: "approval_resolved", SessionID: sessionID, RequestID: requestID,
		Reason: reason,
	}
	return nil
}

func (sm *SessionManager) HandleClaudeChannelSessionEnd(sessionID, reason string) {
	if reason == "" {
		reason = "session_ended"
	}
	var closeEvents []protocol.DaemonEvent
	var responders []claudechannel.VerdictResponder
	sm.mu.Lock()
	if state := sm.sessions[sessionID]; state != nil && state.ClaudeChannelInstanceID != "" {
		if binding := sm.claudeChannelInstances[state.ClaudeChannelInstanceID]; binding != nil {
			binding.Connected = false
		}
		state.ClaudeChannelInstanceID = ""
	}
	for _, pending := range sm.claudeChannelApprovals {
		if pending.SessionID != sessionID || pending.State == ClaudeChannelApprovalResultUnknown {
			continue
		}
		pending.State = ClaudeChannelApprovalResultUnknown
		responders = append(responders, pending.Responder)
		closeEvents = append(closeEvents, protocol.DaemonEvent{
			Type: "approval_resolved", SessionID: sessionID,
			RequestID: pending.PublicRequestID, Reason: reason,
		})
	}
	sm.mu.Unlock()
	_ = sm.persistClaudeApprovalReferences()
	for _, responder := range responders {
		responder.FailClosed()
	}
	for _, event := range closeEvents {
		sm.outputCh <- event
	}
}

func (sm *SessionManager) expireUnboundClaudeChannelApproval(key ClaudeChannelApprovalKey, expected *PendingClaudeChannelApproval) {
	sm.mu.Lock()
	pending := sm.claudeChannelApprovals[key]
	if pending != expected || pending.State != ClaudeChannelApprovalPending || pending.SessionID != "" {
		sm.mu.Unlock()
		return
	}
	pending.State = ClaudeChannelApprovalResultUnknown
	responder := pending.Responder
	sm.mu.Unlock()
	responder.FailClosed()
}

func (sm *SessionManager) expireClaudeChannelApproval(key ClaudeChannelApprovalKey, expected *PendingClaudeChannelApproval) {
	var event *protocol.DaemonEvent
	sm.mu.Lock()
	pending := sm.claudeChannelApprovals[key]
	if pending != expected || pending.State != ClaudeChannelApprovalPending {
		sm.mu.Unlock()
		return
	}
	pending.State = ClaudeChannelApprovalResultUnknown
	if pending.SessionID != "" {
		closed := protocol.DaemonEvent{
			Type: "approval_resolved", SessionID: pending.SessionID,
			RequestID: pending.PublicRequestID, Reason: "timed_out",
		}
		event = &closed
	}
	responder := pending.Responder
	sm.mu.Unlock()
	_ = sm.persistClaudeApprovalReferences()
	responder.FailClosed()
	if event != nil {
		sm.outputCh <- *event
	}
}

func (sm *SessionManager) HandleClaudeChannelDisconnect(instanceID, reason string) {
	var closeEvents []protocol.DaemonEvent
	var responders []claudechannel.VerdictResponder
	sm.mu.Lock()
	binding := sm.claudeChannelInstances[instanceID]
	if binding != nil {
		binding.Connected = false
		if state := sm.sessions[binding.SessionID]; state != nil && state.ClaudeChannelInstanceID == instanceID {
			state.ClaudeChannelInstanceID = ""
		}
	}
	for key, pending := range sm.claudeChannelApprovals {
		if key.InstanceID != instanceID || pending.State == ClaudeChannelApprovalResultUnknown {
			continue
		}
		pending.State = ClaudeChannelApprovalResultUnknown
		responders = append(responders, pending.Responder)
		if pending.SessionID != "" {
			closeEvents = append(closeEvents, protocol.DaemonEvent{
				Type: "approval_resolved", SessionID: pending.SessionID,
				RequestID: pending.PublicRequestID, Reason: reason,
			})
		}
	}
	sm.mu.Unlock()
	_ = sm.persistClaudeApprovalReferences()
	for _, responder := range responders {
		responder.FailClosed()
	}
	for _, event := range closeEvents {
		sm.outputCh <- event
	}
}

func (sm *SessionManager) PendingClaudeChannelApprovals(sessionID string) []protocol.DaemonEvent {
	sm.mu.RLock()
	pending := make([]*PendingClaudeChannelApproval, 0)
	for _, approval := range sm.claudeChannelPublic {
		if approval.SessionID == sessionID && approval.State == ClaudeChannelApprovalPending {
			copy := *approval
			pending = append(pending, &copy)
		}
	}
	sm.mu.RUnlock()
	sort.Slice(pending, func(i, j int) bool { return pending[i].CreatedAt.Before(pending[j].CreatedAt) })
	events := make([]protocol.DaemonEvent, 0, len(pending))
	for _, approval := range pending {
		input, _ := json.Marshal(approval.InputPreview)
		events = append(events, protocol.DaemonEvent{
			Type: "approval_request", SessionID: sessionID, RequestID: approval.PublicRequestID,
			Agent: adapter.AgentClaude, ApprovalKind: "claude_channel",
			AvailableDecisions: []string{"accept", "decline"}, Tool: approval.ToolName,
			Description: approval.Description, Input: input, Resync: true,
		})
	}
	return events
}

// MarkClaudeChannelApprovalObserved neutrally closes a submitted Claude
// Channel approval when the JSONL tailer observes the tool executing or the
// request ending. It is a one-way transition out of submitted_to_claude and
// MUST NOT set Approved/Action — design §2.1/§2.2: "该事件只表示卡片可以
// 关闭,不推断允许/拒绝,也不设置 approved=true/false".
//
// Pending or reserved approvals are left untouched: observation cannot
// invent a verdict Claude has not yet received.
func (sm *SessionManager) MarkClaudeChannelApprovalObserved(sessionID, publicRequestID string) {
	var event *protocol.DaemonEvent
	sm.mu.Lock()
	pending := sm.claudeChannelPublic[claudeChannelPublicKey(sessionID, publicRequestID)]
	if pending == nil || pending.SessionID != sessionID {
		sm.mu.Unlock()
		return
	}
	if pending.State != ClaudeChannelApprovalSubmitted {
		// Only submitted approvals can be neutrally confirmed. A pending or
		// reserved approval is still actionable and must NOT be closed by
		// observation alone.
		sm.mu.Unlock()
		return
	}
	pending.State = ClaudeChannelApprovalConfirmedByObservation
	closed := protocol.DaemonEvent{
		Type: "approval_resolved", SessionID: sessionID, RequestID: publicRequestID,
		Reason: "claude_progress_observed",
	}
	event = &closed
	sm.mu.Unlock()
	_ = sm.persistClaudeApprovalReferences()
	if event != nil {
		sm.outputCh <- *event
	}
}
