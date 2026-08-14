package session

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type trustedActionPolicyMode string

const (
	trustedActionPolicyOff     trustedActionPolicyMode = "off"
	trustedActionPolicyObserve trustedActionPolicyMode = "observe"
	trustedActionPolicyOn      trustedActionPolicyMode = "on"
	trustedActionPolicySchema                          = 1
	maxApprovalSecurityFacts                           = 4
)

func parseTrustedActionPolicyMode(value string) trustedActionPolicyMode {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case string(trustedActionPolicyObserve):
		return trustedActionPolicyObserve
	case string(trustedActionPolicyOn):
		return trustedActionPolicyOn
	default:
		return trustedActionPolicyOff
	}
}

func trustedRiskLevel(level string) (string, bool) {
	switch level {
	case "low", "medium", "high", "critical":
		return level, true
	default:
		return "high", false
	}
}

func trustedRiskReason(reason string) bool {
	switch reason {
	case protocol.RiskReasonExecutesCommand,
		protocol.RiskReasonChangesFiles,
		protocol.RiskReasonRequestsPermissions,
		protocol.RiskReasonRequiresUserInput:
		return true
	default:
		return false
	}
}

func trustedApprovalAction(action string) bool {
	switch action {
	case "once", "always", "reject", "cancel":
		return true
	default:
		return false
	}
}

func approvalSecurityContext(
	riskLevel string,
	classificationIncomplete bool,
	riskReasons []string,
	nativeActions []string,
) protocol.ApprovalSecurityContext {
	level, validLevel := trustedRiskLevel(riskLevel)
	incomplete := classificationIncomplete || !validLevel
	reasons := make([]string, 0, maxApprovalSecurityFacts)
	seenReasons := make(map[string]struct{}, maxApprovalSecurityFacts)
	for _, reason := range riskReasons {
		if !trustedRiskReason(reason) {
			continue
		}
		if _, duplicate := seenReasons[reason]; duplicate {
			continue
		}
		seenReasons[reason] = struct{}{}
		reasons = append(reasons, reason)
		if len(reasons) == maxApprovalSecurityFacts {
			break
		}
	}
	persistentAllowed := !incomplete && (level == "low" || level == "medium")
	actions := make([]string, 0, maxApprovalSecurityFacts)
	seenActions := make(map[string]struct{}, maxApprovalSecurityFacts)
	for _, action := range nativeActions {
		if !trustedApprovalAction(action) || (action == "always" && !persistentAllowed) {
			continue
		}
		if _, duplicate := seenActions[action]; duplicate {
			continue
		}
		seenActions[action] = struct{}{}
		actions = append(actions, action)
		if len(actions) == maxApprovalSecurityFacts {
			break
		}
	}
	return protocol.ApprovalSecurityContext{
		SchemaVersion: trustedActionPolicySchema,
		RiskLevel:     level, ClassificationIncomplete: incomplete,
		RiskReasons: reasons, AllowedActions: actions,
	}
}

func approvalActionAllowed(context *protocol.ApprovalSecurityContext, action string) bool {
	if context == nil || context.SchemaVersion != trustedActionPolicySchema || !trustedApprovalAction(action) {
		return false
	}
	level, validLevel := trustedRiskLevel(context.RiskLevel)
	if !validLevel || (action == "always" && (context.ClassificationIncomplete || (level != "low" && level != "medium"))) {
		return false
	}
	for _, allowed := range context.AllowedActions {
		if action == allowed {
			return true
		}
	}
	return false
}

func (sm *SessionManager) enforceTrustedApprovalAction(provider string, context *protocol.ApprovalSecurityContext, action string) error {
	if sm == nil || sm.trustedActionPolicy == trustedActionPolicyOff || approvalActionAllowed(context, action) {
		return nil
	}
	if sm.trustedActionPolicy == trustedActionPolicyObserve {
		slog.Default().Info("trusted action policy shadow rejection", "provider", provider, "action", action)
		return nil
	}
	return fmt.Errorf("approval action %q is disallowed by trusted action policy", action)
}

func securityContextForPublication(mode trustedActionPolicyMode, context *protocol.ApprovalSecurityContext) *protocol.ApprovalSecurityContext {
	if mode != trustedActionPolicyOn || context == nil {
		return nil
	}
	copyContext := *context
	copyContext.RiskReasons = append([]string(nil), context.RiskReasons...)
	copyContext.AllowedActions = append([]string(nil), context.AllowedActions...)
	return &copyContext
}

func conservativeAttentionRisk(reason string) (string, *bool, []string) {
	incomplete := true
	return "high", &incomplete, []string{reason}
}

func codexAttentionRisk(kind string) (string, *bool, []string) {
	reason := protocol.RiskReasonRequestsPermissions
	switch kind {
	case codexApprovalCommand:
		reason = protocol.RiskReasonExecutesCommand
	case codexApprovalFile:
		reason = protocol.RiskReasonChangesFiles
	case codexQuestion:
		reason = protocol.RiskReasonRequiresUserInput
	}
	return conservativeAttentionRisk(reason)
}

func openCodePermissionAttentionRisk(permission string) (string, *bool, []string) {
	reason := protocol.RiskReasonRequestsPermissions
	switch strings.ToLower(strings.TrimSpace(permission)) {
	case "bash":
		reason = protocol.RiskReasonExecutesCommand
	case "edit", "write", "patch":
		reason = protocol.RiskReasonChangesFiles
	}
	return conservativeAttentionRisk(reason)
}
