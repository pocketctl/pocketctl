package session

import (
	"encoding/json"
	"os"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// DSH's public session/prompt API (0.2.0-rc.2) has no per-turn hidden
// context field. Deliver the frozen Team context explicitly in its prompt.
// Selected Memory still fails the native-hidden capability gate; it must not
// be silently downgraded to visible prompt text.
func collaborationDelivery(agent, content string, prepared *memorycontext.PreparedContext) (string, *memorycontext.PreparedContext) {
	if agent != adapter.AgentDSH || prepared == nil {
		return content, prepared
	}
	if prepared.StableText == "" {
		return content, nil
	}
	return prepared.StableText + "\n\n[Current Team request]\n" + content, nil
}

// Native history and a guessed workspace name never establish Team ownership.
// Restore only the exact daemon-local binding persisted before first dispatch.
func (sm *SessionManager) restoreCollaborationDSH(auth *protocol.CollaborationAuthorization, id string, ps *ProcessState, policy *CwdPolicy) bool {
	roots := policy.Roots()
	if len(roots) == 0 {
		return false
	}
	sm.mu.RLock()
	cwd := ps.Cwd
	sm.mu.RUnlock()
	if cwd != collaborationWorkspace(roots[0], auth.BindingID) || policy.Allows(cwd) != nil || sm.isRetiredCollaborationSession(id, adapter.AgentDSH, cwd) {
		return false
	}
	path, err := collaborationRecordPath(adapter.AgentDSH, id)
	if err != nil {
		return false
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var record collaborationNativeRecord
	if json.Unmarshal(data, &record) != nil || record.Version != 1 || record.Cwd != cwd {
		return false
	}
	b := record.Binding
	if b.NativeSessionID != id || b.Agent != adapter.AgentDSH || b.TeamSessionID != auth.TeamSessionID || b.BindingID != auth.BindingID || b.BindingRevision != auth.BindingRevision || b.OfferID != auth.OfferID || b.OfferRevision != auth.OfferRevision || b.OwnerUserID != auth.OwnerUserID || b.DaemonID != auth.DaemonID {
		return false
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.sessions[id] != ps || ps.Agent != adapter.AgentDSH {
		return false
	}
	ps.Source = "daemon"
	return true
}
