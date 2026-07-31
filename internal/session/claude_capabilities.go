package session

import (
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const (
	ClaudeCapabilityHistorySync      = "history_sync"
	ClaudeCapabilityResumeAfterExit  = "resume_after_exit"
	ClaudeCapabilityRemoteApproval   = "remote_approval"
	CodexCapabilityMessageAcceptance = "message_acceptance_receipt"
)

func (sm *SessionManager) claudeCapabilitiesLocked(state *ProcessState) []string {
	if state == nil || state.Agent != adapter.AgentClaude {
		return nil
	}
	capabilities := []string{ClaudeCapabilityHistorySync}
	if state.Source == "terminal" {
		capabilities = append(capabilities, ClaudeCapabilityResumeAfterExit)
	}
	if state.Source == "daemon" && sm.approvalEnabled {
		capabilities = append(capabilities, ClaudeCapabilityRemoteApproval)
	}
	return capabilities
}

func (sm *SessionManager) sessionCapabilitiesLocked(state *ProcessState) []string {
	if state == nil {
		return nil
	}
	switch state.Agent {
	case adapter.AgentClaude:
		return sm.claudeCapabilitiesLocked(state)
	case adapter.AgentOpencode:
		return sm.openCodeCapabilitiesLocked(state)
	case adapter.AgentCodex:
		if state.ControlMode == protocol.ControlManaged {
			return []string{CodexCapabilityMessageAcceptance}
		}
		return nil
	default:
		return nil
	}
}

func (sm *SessionManager) SessionCapabilities(sessionID string) []string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return append([]string(nil), sm.sessionCapabilitiesLocked(sm.sessions[sessionID])...)
}
