package session

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const claudeApprovalTombstoneTTL = 10 * time.Minute

type PendingClaudeApproval struct {
	RequestID  string
	SessionID  string
	Tool       string
	Input      json.RawMessage
	CreatedAt  time.Time
	submitting bool
}

type claudeApprovalSession struct {
	pending      map[string]*PendingClaudeApproval
	resumeStatus string
}

type claudeApprovalKey struct {
	sessionID string
	requestID string
}

type ClaudeApprovalReference struct {
	SessionID string
	RequestID string
	CreatedAt time.Time
}

func claudeApprovalV2Enabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POCKETCTL_CLAUDE_APPROVAL_V2"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func (sm *SessionManager) ClaudeApprovalV2Enabled() bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.claudeApprovalV2
}

func (sm *SessionManager) SetClaudeApprovalRecorder(recorder func([]ClaudeApprovalReference) error) {
	sm.mu.Lock()
	sm.claudeApprovalRecorder = recorder
	sm.mu.Unlock()
}

func (sm *SessionManager) SetClaudeTelemetryRecorder(recorder func(metric, reason string)) {
	sm.mu.Lock()
	sm.claudeTelemetryRecorder = recorder
	sm.mu.Unlock()
}

func (sm *SessionManager) recordClaudeTelemetry(metric, reason string) {
	sm.mu.RLock()
	recorder := sm.claudeTelemetryRecorder
	sm.mu.RUnlock()
	if recorder != nil {
		recorder(metric, reason)
	}
}

func (sm *SessionManager) ClaudeApprovalReferences() []ClaudeApprovalReference {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return append([]ClaudeApprovalReference(nil), sm.claudeApprovalReferencesLocked()...)
}

func (sm *SessionManager) claudeApprovalReferencesLocked() []ClaudeApprovalReference {
	var references []ClaudeApprovalReference
	for _, state := range sm.claudeApprovals {
		for _, request := range state.pending {
			references = append(references, ClaudeApprovalReference{
				SessionID: request.SessionID,
				RequestID: request.RequestID,
				CreatedAt: request.CreatedAt,
			})
		}
	}
	for _, request := range sm.claudeChannelApprovals {
		if request.SessionID == "" || (request.State != ClaudeChannelApprovalPending && request.State != ClaudeChannelApprovalReserved) {
			continue
		}
		references = append(references, ClaudeApprovalReference{
			SessionID: request.SessionID,
			RequestID: request.PublicRequestID,
			CreatedAt: request.CreatedAt,
		})
	}
	sort.Slice(references, func(i, j int) bool {
		if references[i].CreatedAt.Equal(references[j].CreatedAt) {
			if references[i].SessionID == references[j].SessionID {
				return references[i].RequestID < references[j].RequestID
			}
			return references[i].SessionID < references[j].SessionID
		}
		return references[i].CreatedAt.Before(references[j].CreatedAt)
	})
	return references
}

func (sm *SessionManager) persistClaudeApprovalReferences() error {
	// Serialize the snapshot and write as one ordered operation. The snapshot
	// is taken only after acquiring this mutex, so a delayed older writer can
	// never overwrite a newer registry snapshot.
	sm.claudeApprovalPersistenceMu.Lock()
	defer sm.claudeApprovalPersistenceMu.Unlock()
	sm.mu.RLock()
	recorder := sm.claudeApprovalRecorder
	references := append([]ClaudeApprovalReference(nil), sm.claudeApprovalReferencesLocked()...)
	sm.mu.RUnlock()
	if recorder == nil {
		return nil
	}
	return recorder(references)
}

func cloneClaudeApproval(p *PendingClaudeApproval) PendingClaudeApproval {
	copy := *p
	copy.Input = append(json.RawMessage(nil), p.Input...)
	copy.submitting = false
	return copy
}

func claudeApprovalEvent(p PendingClaudeApproval) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:      "approval_request",
		SessionID: p.SessionID,
		RequestID: p.RequestID,
		Tool:      p.Tool,
		Input:     append(json.RawMessage(nil), p.Input...),
	}
}

func (sm *SessionManager) handleClaudeApprovalRequest(req approval.Request) {
	now := time.Now()
	sm.mu.Lock()
	ps, ok := sm.sessions[req.SessionID]
	if !ok {
		ps = &ProcessState{
			SessionID:      req.SessionID,
			Status:         protocol.StatusWaitingApproval,
			StartedAt:      now,
			LastActivityAt: now,
			Cwd:            req.Cwd,
			Agent:          adapter.AgentClaude,
			Source:         "terminal",
		}
		sm.sessions[req.SessionID] = ps
	} else if ps.Agent != "" && ps.Agent != adapter.AgentClaude {
		sm.mu.Unlock()
		// A Claude Hook request must never attach to a Codex/OpenCode session
		// that happens to reuse the same opaque session ID.
		if sm.approvals != nil {
			_ = sm.approvals.Resolve(req.RequestID, false)
		}
		return
	}
	state := sm.claudeApprovals[req.SessionID]
	if state == nil {
		resumeStatus := ps.Status
		if resumeStatus == "" || resumeStatus == protocol.StatusWaitingApproval {
			resumeStatus = protocol.StatusRunning
		}
		state = &claudeApprovalSession{
			pending:      make(map[string]*PendingClaudeApproval),
			resumeStatus: resumeStatus,
		}
		sm.claudeApprovals[req.SessionID] = state
	}
	if _, duplicate := state.pending[req.RequestID]; duplicate {
		sm.mu.Unlock()
		return
	}
	pending := &PendingClaudeApproval{
		RequestID: req.RequestID,
		SessionID: req.SessionID,
		Tool:      req.Tool,
		Input:     append(json.RawMessage(nil), req.Input...),
		CreatedAt: now,
	}
	state.pending[req.RequestID] = pending
	ps.Agent = adapter.AgentClaude
	ps.Status = protocol.StatusWaitingApproval
	ps.LastActivityAt = now
	recorder := sm.claudeApprovalRecorder
	sm.mu.Unlock()

	if recorder != nil {
		if err := sm.persistClaudeApprovalReferences(); err != nil {
			// Do not surface an approval that cannot be closed after a crash.
			// Denying through the authority also removes it from the registry
			// via OnFinished.
			if sm.approvals != nil {
				_ = sm.approvals.Resolve(req.RequestID, false)
			}
			return
		}
	}
	sm.outputCh <- claudeApprovalEvent(cloneClaudeApproval(pending))
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      req.SessionID,
		Status:         protocol.StatusWaitingApproval,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) handleClaudeApprovalFinished(finished approval.Finished) {
	now := time.Now()
	sm.mu.Lock()
	state := sm.claudeApprovals[finished.SessionID]
	if state == nil {
		sm.mu.Unlock()
		return
	}
	if _, ok := state.pending[finished.RequestID]; !ok {
		sm.mu.Unlock()
		return
	}
	delete(state.pending, finished.RequestID)
	sm.pruneClaudeApprovalTombstonesLocked(now)
	sm.claudeApprovalResolved[claudeApprovalKey{sessionID: finished.SessionID, requestID: finished.RequestID}] = now.Add(claudeApprovalTombstoneTTL)

	status := protocol.StatusWaitingApproval
	if len(state.pending) == 0 {
		status = state.resumeStatus
		if status == "" || status == protocol.StatusWaitingApproval {
			status = protocol.StatusRunning
		}
		delete(sm.claudeApprovals, finished.SessionID)
	}
	if ps := sm.sessions[finished.SessionID]; ps != nil && ps.Agent == adapter.AgentClaude {
		ps.Status = status
		ps.LastActivityAt = now
	}
	sm.mu.Unlock()

	_ = sm.persistClaudeApprovalReferences()
	resolved := protocol.DaemonEvent{
		Type:      "approval_resolved",
		SessionID: finished.SessionID,
		RequestID: finished.RequestID,
	}
	if finished.Approved != nil {
		resolved.Approved = *finished.Approved
	}
	if finished.Reason != approval.FinishApproved && finished.Reason != approval.FinishDenied {
		resolved.Reason = string(finished.Reason)
	}
	sm.recordClaudeTelemetry("finish", string(finished.Reason))
	sm.outputCh <- resolved
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      finished.SessionID,
		Status:         status,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) pruneClaudeApprovalTombstonesLocked(now time.Time) {
	for key, expiresAt := range sm.claudeApprovalResolved {
		if !expiresAt.After(now) {
			delete(sm.claudeApprovalResolved, key)
		}
	}
}

func (sm *SessionManager) resolveClaudeApproval(sessionID, requestID string, approved bool) error {
	now := time.Now()
	sm.mu.Lock()
	sm.pruneClaudeApprovalTombstonesLocked(now)
	key := claudeApprovalKey{sessionID: sessionID, requestID: requestID}
	if _, resolved := sm.claudeApprovalResolved[key]; resolved {
		sm.mu.Unlock()
		sm.recordClaudeTelemetry("resolved_elsewhere", "")
		return &ResolvedElsewhereError{RequestID: requestID}
	}
	ps := sm.sessions[sessionID]
	state := sm.claudeApprovals[sessionID]
	var pending *PendingClaudeApproval
	if state != nil {
		pending = state.pending[requestID]
	}
	if ps == nil || ps.Agent != adapter.AgentClaude || pending == nil {
		sm.mu.Unlock()
		return fmt.Errorf("claude approval request not pending in session")
	}
	if pending.submitting {
		sm.mu.Unlock()
		sm.recordClaudeTelemetry("resolved_elsewhere", "")
		return &ResolvedElsewhereError{RequestID: requestID}
	}
	pending.submitting = true
	sm.mu.Unlock()

	if sm.approvals == nil {
		sm.mu.Lock()
		if current := sm.claudeApprovals[sessionID]; current != nil {
			if request := current.pending[requestID]; request != nil {
				request.submitting = false
			}
		}
		sm.mu.Unlock()
		return fmt.Errorf("approval not configured on this daemon")
	}
	if err := sm.approvals.Resolve(requestID, approved); err != nil {
		// The Hook server is authoritative. If it no longer knows the request,
		// converge the stale client card instead of keeping it actionable.
		sm.handleClaudeApprovalFinished(approval.Finished{
			RequestID: requestID,
			SessionID: sessionID,
			Reason:    approval.FinishHookDisconnected,
		})
		sm.recordClaudeTelemetry("resolved_elsewhere", "")
		return &ResolvedElsewhereError{RequestID: requestID}
	}
	return nil
}

func (sm *SessionManager) routesClaudeApproval(sessionID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps := sm.sessions[sessionID]
	return sm.claudeApprovalV2 && ps != nil && ps.Agent == adapter.AgentClaude
}

// PendingClaudeApprovals returns a deterministic snapshot for get_session_meta
// and Relay reconnect replay. It never exposes the registry's mutable storage.
func (sm *SessionManager) PendingClaudeApprovals(sessionID string) []protocol.DaemonEvent {
	sm.mu.RLock()
	state := sm.claudeApprovals[sessionID]
	if state == nil {
		sm.mu.RUnlock()
		return nil
	}
	pending := make([]PendingClaudeApproval, 0, len(state.pending))
	for _, request := range state.pending {
		pending = append(pending, cloneClaudeApproval(request))
	}
	sm.mu.RUnlock()
	sort.Slice(pending, func(i, j int) bool {
		if pending[i].CreatedAt.Equal(pending[j].CreatedAt) {
			return pending[i].RequestID < pending[j].RequestID
		}
		return pending[i].CreatedAt.Before(pending[j].CreatedAt)
	})
	events := make([]protocol.DaemonEvent, 0, len(pending))
	for _, request := range pending {
		events = append(events, claudeApprovalEvent(request))
	}
	return events
}
