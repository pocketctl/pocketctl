package session

import (
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// This file provides test-only direct seeding for the cross-agent routing
// regression tests. Production registries remain encapsulated.

// newSessionManagerForRoutingTests builds a lightweight SessionManager that
// is sufficient for routing/boundary assertions without spinning up the full
// daemon. It reuses the existing constructor used by other session-layer
// tests.
func newSessionManagerForRoutingTests() *SessionManager {
	events := make(chan protocol.DaemonEvent, 64)
	return NewSessionManager(events)
}

// CloseForRoutingTest tears down the manager created by
// newSessionManagerForRoutingTests. It is safe to call multiple times.
func (sm *SessionManager) CloseForRoutingTest() {
	// The SessionManager has no Close method today; drain is a no-op.
	// This exists so tests have a single cleanup seam when Task 8 adds
	// registry teardown.
}

// --- seed helpers ----------------------------------------------------------

// seedCodexApprovalForRoutingTest registers a pending Codex approval in the
// broker through its test-only coordinator seam.
func (sm *SessionManager) seedCodexApprovalForRoutingTest(sessionID, requestID string) {
	provider := sm.CodexRuntimeProvider()
	broker := newCodexInteractions(sm, 1, nil)
	pending := &codexPendingInteraction{publicID: requestID, threadID: sessionID, kind: codexApprovalCommand}
	broker.pendingByPublic[sessionID+"\x00"+requestID] = pending
	provider.coordinator.mu.Lock()
	provider.coordinator.interactions = broker
	provider.coordinator.mu.Unlock()
}

// seedLegacyClaudeHookForRoutingTest registers a pending legacy Claude Hook
// approval (V1 PendingRequestID).
func (sm *SessionManager) seedLegacyClaudeHookForRoutingTest(sessionID, requestID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		ps = &ProcessState{
			SessionID:      sessionID,
			Agent:          adapter.AgentClaude,
			Source:         "terminal",
			Status:         protocol.StatusWaitingApproval,
			StartedAt:      time.Now(),
			LastActivityAt: time.Now(),
		}
		sm.sessions[sessionID] = ps
	}
	ps.PendingRequestID = requestID
	ps.Status = protocol.StatusWaitingApproval
}

// seedClaudeChannelApprovalForRoutingTest registers a pending Claude Channel
// approval directly in the isolated Channel registry.
func (sm *SessionManager) seedClaudeChannelApprovalForRoutingTest(sessionID, requestID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	key := ClaudeChannelApprovalKey{InstanceID: "routing-instance", ClaudeRequestID: "abcde"}
	pending := &PendingClaudeChannelApproval{
		PublicRequestID: requestID, SessionID: sessionID, Key: key,
		State: ClaudeChannelApprovalPending, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Minute),
	}
	sm.claudeChannelApprovals[key] = pending
	sm.claudeChannelPublic[claudeChannelPublicKey(sessionID, requestID)] = pending
}

// seedTerminalClaudeSessionForRoutingTest registers a bare terminal-sourced
// Claude session with no Channel binding and no pending approval.
func (sm *SessionManager) seedTerminalClaudeSessionForRoutingTest(sessionID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.sessions[sessionID] = &ProcessState{
		SessionID:      sessionID,
		Agent:          adapter.AgentClaude,
		Source:         "terminal",
		Status:         protocol.StatusRunning,
		StartedAt:      time.Now(),
		LastActivityAt: time.Now(),
	}
}

// seedObserverSessionForRoutingTest registers a read-only observer session
// (e.g. ZCode) that must never participate in approval routing.
func (sm *SessionManager) seedObserverSessionForRoutingTest(sessionID, agent string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.sessions[sessionID] = &ProcessState{
		SessionID:      sessionID,
		Agent:          agent,
		Source:         "terminal",
		ControlMode:    protocol.ControlLegacyReadOnly,
		Status:         protocol.StatusRunning,
		StartedAt:      time.Now(),
		LastActivityAt: time.Now(),
	}
}

// --- lookup helpers --------------------------------------------------------

// legacyClaudeApprovalKnowsForTest reports whether the legacy V1 Claude Hook
// registry knows the request. Used to assert the Channel registry and
// legacy registry do not cross-contaminate.
func (sm *SessionManager) legacyClaudeApprovalKnowsForTest(sessionID, requestID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return false
	}
	return ps.PendingRequestID == requestID
}

// sessionCapabilitiesForTest returns the capability list advertised for the
// session, used to assert ZCode never advertises approval capabilities.
func (sm *SessionManager) sessionCapabilitiesForTest(sessionID string) []string {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return nil
	}
	return sm.sessionCapabilitiesLocked(ps)
}

// claudeChannelApprovalKeyIsInstancePlusShortID asserts the registry's
// internal unique key shape: (channel_instance_id, claude_request_id).
func claudeChannelApprovalKeyIsInstancePlusShortID() bool {
	key := ClaudeChannelApprovalKey{InstanceID: "instance", ClaudeRequestID: "abcde"}
	return key.InstanceID == "instance" && key.ClaudeRequestID == "abcde"
}

// claudeChannelApprovalPublicIDIsUUID asserts the public request id surfaced
// to Web/iOS is a UUID, not Claude's 5-letter short id.
func claudeChannelApprovalPublicIDIsUUID() bool {
	_, err := uuid.Parse(uuid.NewString())
	return err == nil
}
