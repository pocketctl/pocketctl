package session

import (
	"fmt"
	"os"

	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// A remotely requested one-shot resume is daemon-owned even when its history
// came from a terminal. Wire that subprocess to the broker; do not change the
// original terminal process or user-global hooks.
func (sm *SessionManager) claudeResumeEnv(sessionID, cwd string, permission *protocol.PermissionConfig, env []string) ([]string, error) {
	if env == nil {
		env = os.Environ()
	}
	env = setEnvValue(env, "POCKETCTL_SESSION_ID", sessionID)
	// Match BuildClaudeArgs' fallback for histories with no permission record.
	mode := "acceptEdits"
	if permission != nil && permission.Mode != "" {
		mode = permission.Mode
	}
	env = setEnvValue(env, "POCKETCTL_PERM_MODE", mode)
	if sm.approvalEnabled && sm.approvals != nil {
		if err := approval.EnsureHooks(cwd, sm.pocketctlPath); err != nil {
			return nil, fmt.Errorf("approval hook injection failed for Claude resume (fail closed): %w", err)
		}
		env = setEnvValue(env, "POCKETCTL_APPROVAL_SOCK", sm.approvals.SocketPath())
	}
	return env, nil
}
