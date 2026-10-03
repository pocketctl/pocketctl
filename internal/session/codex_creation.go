package session

import (
	"context"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// CodexCreationCapabilities describes this host/account. Creation still probes
// and validates again, since configuration may change after the picker opens.
func (sm *SessionManager) CodexCreationCapabilities(ctx context.Context, homeID string) *protocol.CodexCreationCapabilities {
	sm.mu.RLock()
	policy := sm.remotePermission
	sm.mu.RUnlock()
	result := &protocol.CodexCreationCapabilities{Version: 1, PermissionPresets: []string{}, ApprovalPolicies: []string{}, SandboxModes: []string{"read-only", "workspace-write"}}
	profile, err := sm.CodexRuntimeProvider().profileForHomeID(homeID)
	if err != nil {
		result.Reason = "invalid_codex_home"
		return result
	}
	result.DefaultModel = codexConfigModelAt(profile.Home)
	provider := sm.CodexRuntimeProvider()
	binary, version, resolveErr := provider.resolve()
	if resolveErr != nil {
		result.Reason = "no_cli"
		return result
	}
	cfg, err := agentcontrol.LoadConfig()
	if err == nil && cfg.Codex.State == agentcontrol.StateEnabled {
		if agentcontrol.SupportsManagedCodexVersion(version) {
			caps, probeErr := provider.probe(ctx, binary, version)
			if probeErr == nil && caps.Managed() && !caps.ThreadInjection {
				result.Reason = "codex_managed_required"
				return result
			}
			result.ManagedRuntime = probeErr == nil && caps.Managed() && caps.ThreadInjection
			result.RemoteApprovals = result.ManagedRuntime && caps.Approvals
		}
	}
	if result.RemoteApprovals {
		result.PermissionPresets = append(result.PermissionPresets, "request_approval", "agent_managed", "custom")
		result.ApprovalPolicies = append(result.ApprovalPolicies, "on-request", "untrusted")
	}
	if policy.AllowDangerous {
		if !result.RemoteApprovals {
			result.PermissionPresets = append(result.PermissionPresets, "custom")
		}
		result.PermissionPresets = append(result.PermissionPresets, "full_access")
		result.ApprovalPolicies = append(result.ApprovalPolicies, "never")
		result.SandboxModes = append(result.SandboxModes, "danger-full-access")
	}
	result.Supported = len(result.PermissionPresets) > 0
	if !result.Supported || !result.ManagedRuntime {
		result.Reason = "codex_managed_required"
	}
	// The remote policy is never relaxed by capability discovery.
	return result
}
