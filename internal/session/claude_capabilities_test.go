package session

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
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
