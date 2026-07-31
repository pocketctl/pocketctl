package session

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestClaudeCapabilitiesAreAgentAndSourceScoped(t *testing.T) {
	sm := NewSessionManager(nil)
	sm.approvalEnabled = true

	terminal := sm.claudeCapabilitiesLocked(&ProcessState{Agent: adapter.AgentClaude, Source: "terminal"})
	if !sameStrings(terminal, []string{ClaudeCapabilityHistorySync, ClaudeCapabilityResumeAfterExit}) {
		t.Fatalf("terminal Claude capabilities=%v", terminal)
	}
	daemon := sm.claudeCapabilitiesLocked(&ProcessState{Agent: adapter.AgentClaude, Source: "daemon"})
	if !sameStrings(daemon, []string{ClaudeCapabilityHistorySync, ClaudeCapabilityRemoteApproval}) {
		t.Fatalf("daemon Claude capabilities=%v", daemon)
	}
	if got := sm.claudeCapabilitiesLocked(&ProcessState{Agent: adapter.AgentCodex, Source: "terminal"}); len(got) != 0 {
		t.Fatalf("Claude capabilities leaked to Codex: %v", got)
	}
	if got := sm.claudeCapabilitiesLocked(&ProcessState{Agent: adapter.AgentOpencode, Source: "terminal"}); len(got) != 0 {
		t.Fatalf("Claude capabilities leaked to OpenCode: %v", got)
	}
}

func TestManagedCodexAdvertisesMessageAcceptanceReceiptOnly(t *testing.T) {
	sm := NewSessionManager(nil)

	managed := sm.sessionCapabilitiesLocked(&ProcessState{
		Agent: adapter.AgentCodex, ControlMode: protocol.ControlManaged,
	})
	if !sameStrings(managed, []string{"message_acceptance_receipt"}) {
		t.Fatalf("managed Codex capabilities=%v", managed)
	}
	if got := sm.sessionCapabilitiesLocked(&ProcessState{
		Agent: adapter.AgentCodex, ControlMode: protocol.ControlUnmanagedActive,
	}); len(got) != 0 {
		t.Fatalf("unmanaged Codex gained receipt capability: %v", got)
	}
}

func TestListSessionsIncludesManagedCodexAcceptanceCapability(t *testing.T) {
	sm := NewSessionManager(nil)
	sm.sessions["thread-1"] = &ProcessState{
		SessionID:   "thread-1",
		Agent:       adapter.AgentCodex,
		ControlMode: protocol.ControlManaged,
		Status:      protocol.StatusRunning,
	}

	sessions := sm.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("sessions=%d, want 1", len(sessions))
	}
	if !sameStrings(sessions[0].Capabilities, []string{CodexCapabilityMessageAcceptance}) {
		t.Fatalf("managed Codex list capabilities=%v", sessions[0].Capabilities)
	}
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
