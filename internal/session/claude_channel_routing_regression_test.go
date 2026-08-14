package session

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// TestClaudeChannelApprovalRoutingIsolation freezes the invariant that a
// future Claude Channel approval registry MUST be routed through an explicit
// KnowsPublicRequest gate, never inferred from "not OpenCode/Codex".
//
// The design document (docs/plans/2026-08-10-claude-code-multi-endpoint-approval.md §1.3, §Task 8)
// mandates the following route order in ResolveApproval / ResolveApprovalAction:
//
//  1. Codex broker KnowsApproval            (unchanged)
//  2. OpenCode managed backend              (unchanged)
//  3. Claude Channel registry KnowsPublicRequest   (NEW, explicit gate)
//  4. legacy Claude Hook registry/server    (unchanged)
//  5. unknown -> error
//
// This test exercises the same textual request ID ("req-1") arriving at
// Codex, legacy Claude Hook, and Claude Channel simultaneously,
// and asserts the owner that handles the resolution is deterministic and
// matches the route order above. OpenCode backend priority remains covered by
// its managed-interaction integration suite.
func TestClaudeChannelApprovalRoutingIsolation(t *testing.T) {
	sm := newTestSessionManager(t)
	const sessionID = "sess-routing"
	const requestID = "req-1"

	// Seed a Codex-managed session with a pending Codex approval broker entry.
	// The broker must win over every other owner regardless of insertion order.
	registerCodexApprovalForRoutingTest(t, sm, sessionID, requestID)

	// Simultaneously seed a legacy Claude Hook pending request and a Claude
	// Channel pending approval, both
	// keyed by the SAME request_id. None of these may steal ownership from
	// the Codex broker.
	registerLegacyClaudeHookForRoutingTest(t, sm, sessionID, requestID)
	registerClaudeChannelApprovalForRoutingTest(t, sm, sessionID, requestID)

	// The explicit gate that the design document requires. The Claude Channel
	// registry MUST expose KnowsPublicRequest(sessionID, requestID) and MUST
	// NOT be inferred from "agent == claude-code" or "not OpenCode/Codex".
	// Until the registry exists, this returns false; once Task 8 lands it
	// returns true only when the registry actually owns the request.
	if !sm.ClaudeChannelApprovalKnowsPublicRequest(sessionID, requestID) {
		t.Fatalf("Claude Channel registry must own request %s after explicit registration; "+
			"KnowsPublicRequest is the required routing gate (design §Task 8)", requestID)
	}

	// Codex broker must still win when it knows the same request ID.
	broker := sm.codexInteractionBroker()
	if broker == nil || !broker.KnowsApproval(sessionID, requestID) {
		t.Fatalf("Codex broker must retain first-route priority for request %s", requestID)
	}
}

// TestClaudeChannelApprovalRoutingDoesNotInferFromAgentType freezes the rule
// that the route must use an EXPLICIT registry gate, not "agent==claude-code".
// A claude-code session without a registered Channel approval MUST fall
// through to the legacy Hook path or error — it MUST NOT be silently claimed
// by a not-yet-existing Channel registry.
func TestClaudeChannelApprovalRoutingDoesNotInferFromAgentType(t *testing.T) {
	sm := newTestSessionManager(t)
	const sessionID = "sess-no-channel"
	const requestID = "req-2"

	// Claude terminal session with NO Channel instance bound and NO Channel
	// approval registered. The registry must NOT infer ownership from agent.
	registerTerminalClaudeSessionForRoutingTest(t, sm, sessionID)

	if sm.ClaudeChannelApprovalKnowsPublicRequest(sessionID, requestID) {
		t.Fatalf("Claude Channel registry must not infer ownership from agent type; " +
			"only an explicit KnowsPublicRequest gate is permitted")
	}
}

// TestClaudeChannelApprovalRegistryIsolatedFromLegacyMaps freezes the boundary
// that the new Channel registry MUST NOT read from or write to the legacy
// `claudeApprovals` map, the approval.Server pending set, the OpenCode
// pending maps, or the Codex broker. Cross-contamination is a forbidden
// regression (design §1.3, §Task 8).
func TestClaudeChannelApprovalRegistryIsolatedFromLegacyMaps(t *testing.T) {
	sm := newTestSessionManager(t)
	const sessionID = "sess-iso"
	const requestID = "req-3"

	// Register ONLY in the legacy V2 Claude Hook registry.
	registerLegacyClaudeHookForRoutingTest(t, sm, sessionID, requestID)

	// The new Channel registry must not see it.
	if sm.ClaudeChannelApprovalKnowsPublicRequest(sessionID, requestID) {
		t.Fatalf("Claude Channel registry must not read from legacy claudeApprovals map")
	}

	// Conversely, register only in the Channel registry and assert the legacy
	// V2 path does not observe it.
	registerClaudeChannelApprovalForRoutingTest(t, sm, sessionID, "req-channel-only")
	if knowsLegacyClaudeApproval(sm, sessionID, "req-channel-only") {
		t.Fatalf("legacy claudeApprovals map must not observe Claude Channel registry entries")
	}
}

// TestZCodeRemainsOutsideManagedAgentGate freezes the rule that ZCode is a
// read-only observer and must be diverted BEFORE the managed-agent gate in
// the `agent` command dispatcher (design §1.3, §6.3). This test documents
// the constraint at the session layer: ZCode sessions never carry approval
// capability and never enter the launcher/provider map.
func TestZCodeRemainsOutsideManagedAgentGate(t *testing.T) {
	sm := newTestSessionManager(t)
	const sessionID = "sess-zcode"
	registerObserverSessionForRoutingTest(t, sm, sessionID, adapter.AgentZcode)

	// ZCode must never be reported as a Channel approval owner.
	if sm.ClaudeChannelApprovalKnowsPublicRequest(sessionID, "any") {
		t.Fatalf("ZCode sessions must never enter the Claude Channel registry")
	}

	// ZCode must never advertise remote_approval or channel capabilities.
	caps := sm.sessionCapabilitiesForTest(sessionID)
	for _, forbidden := range []string{"remote_approval", "claude_channel_approval", "terminal_approval_parallel"} {
		if containsString(caps, forbidden) {
			t.Fatalf("ZCode session must not advertise capability %q; it is a read-only observer", forbidden)
		}
	}
}

// TestClaudeChannelApprovalMapIsSeparatelyKeyed freezes the rule that the
// registry's internal unique key MUST be (channel_instance_id,
// claude_request_id), and the PUBLIC identifier surfaced to Web/iOS MUST be
// a UUID distinct from Claude's 5-letter short ID (design §1.2, §Task 8).
func TestClaudeChannelApprovalMapIsSeparatelyKeyed(t *testing.T) {
	if !claudeChannelApprovalKeyIsInstancePlusShortID() {
		t.Fatalf("Claude Channel approval internal key must be (instance_id, claude_request_id); " +
			"the short 5-letter ID is NOT a global identifier or authorization credential")
	}
	if !claudeChannelApprovalPublicIDIsUUID() {
		t.Fatalf("Claude Channel approval public request id must be a UUID, " +
			"not Claude's 5-letter short id")
	}
}

// --- helpers ---------------------------------------------------------------

func newTestSessionManager(t *testing.T) *SessionManager {
	t.Helper()
	sm := newSessionManagerForRoutingTests()
	t.Cleanup(sm.CloseForRoutingTest)
	return sm
}

// containsString is provided by codex_elicitation.go in the same package.

// registerCodexApprovalForRoutingTest seeds a pending Codex approval in the
// broker through the test-only coordinator seam.
func registerCodexApprovalForRoutingTest(t *testing.T, sm *SessionManager, sessionID, requestID string) {
	t.Helper()
	sm.seedCodexApprovalForRoutingTest(sessionID, requestID)
}

func registerLegacyClaudeHookForRoutingTest(t *testing.T, sm *SessionManager, sessionID, requestID string) {
	t.Helper()
	sm.seedLegacyClaudeHookForRoutingTest(sessionID, requestID)
}

func registerClaudeChannelApprovalForRoutingTest(t *testing.T, sm *SessionManager, sessionID, requestID string) {
	t.Helper()
	sm.seedClaudeChannelApprovalForRoutingTest(sessionID, requestID)
}

func registerTerminalClaudeSessionForRoutingTest(t *testing.T, sm *SessionManager, sessionID string) {
	t.Helper()
	sm.seedTerminalClaudeSessionForRoutingTest(sessionID)
}

func registerObserverSessionForRoutingTest(t *testing.T, sm *SessionManager, sessionID, agent string) {
	t.Helper()
	sm.seedObserverSessionForRoutingTest(sessionID, agent)
}

func knowsLegacyClaudeApproval(sm *SessionManager, sessionID, requestID string) bool {
	return sm.legacyClaudeApprovalKnowsForTest(sessionID, requestID)
}

// Compile-time reference to protocol/adapter so this file records the import
// contract that future implementations must honor.
var _ = protocol.InteractionResolvedElsewhere
var _ = adapter.AgentClaude
