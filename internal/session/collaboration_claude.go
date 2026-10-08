package session

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Ownership lives outside the agent workspace. Native history alone never
// grants authority to turn a terminal conversation into a Team receiver.
type collaborationNativeRecord struct {
	Version int
	Binding collaborationNativeBinding
	Cwd     string
}

func collaborationClaudePath(id string) (string, error) {
	return collaborationRecordPath(adapter.AgentClaude, id)
}

func collaborationRecordPath(agent, id string) (string, error) {
	if agent == adapter.AgentClaude {
		agent = "claude"
	}
	home, err := config.HomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pocketctl", "collaboration-"+agent, fmt.Sprintf("%x.json", sha256.Sum256([]byte(id)))), nil
}

func persistCollaborationNative(binding collaborationNativeBinding, cwd string) error {
	p, err := collaborationRecordPath(binding.Agent, binding.NativeSessionID)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return err
	}
	info, err := os.Lstat(filepath.Dir(p))
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrCollaborationBinding
	}
	data, err := json.Marshal(collaborationNativeRecord{1, binding, cwd})
	if err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(data); err != nil {
		return err
	}
	return f.Sync()
}

func (sm *SessionManager) restoreCollaborationClaude(auth *protocol.CollaborationAuthorization, id string, ps *ProcessState, policy *CwdPolicy) *ProcessState {
	roots := policy.Roots()
	if len(roots) == 0 || id == "" || strings.ContainsAny(id, `/\\`) {
		return nil
	}
	agent, cwd, source, already := adapter.AgentClaude, collaborationWorkspace(roots[0], auth.BindingID), "daemon", false
	sm.mu.RLock()
	if ps != nil {
		agent, cwd, source, already = ps.Agent, ps.Cwd, ps.Source, ps.ClaudePrintSession
	}
	sm.mu.RUnlock()
	if already || agent != adapter.AgentClaude || (source != "terminal" && source != "daemon") {
		return nil
	}
	if sm.isRetiredCollaborationSession(id, agent, cwd) {
		return nil
	}
	if cwd != collaborationWorkspace(roots[0], auth.BindingID) || policy.Allows(cwd) != nil {
		return nil
	}
	p, err := collaborationClaudePath(id)
	if err != nil {
		return nil
	}
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var record collaborationNativeRecord
	if json.Unmarshal(data, &record) != nil || record.Version != 1 || record.Cwd != cwd {
		return nil
	}
	b := record.Binding
	if b.NativeSessionID != id || b.Agent != agent || b.TeamSessionID != auth.TeamSessionID || b.BindingID != auth.BindingID ||
		b.BindingRevision != auth.BindingRevision || b.OfferID != auth.OfferID || b.OfferRevision != auth.OfferRevision ||
		b.OwnerUserID != auth.OwnerUserID || b.DaemonID != auth.DaemonID {
		return nil
	}
	nativePath, err := adapter.ResolveJSONLPathFor(agent, id, cwd)
	if err != nil {
		return nil
	}
	home, err := config.HomeDir()
	// Claude replaces all non-ASCII-alphanumeric path characters, including
	// the dots in our .pocketctl workspace, rather than just path separators.
	encoded := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '-'
	}, cwd)
	if err != nil || nativePath != filepath.Join(home, ".claude", "projects", encoded, id+".jsonl") {
		return nil
	}
	permission := adapter.DefaultPermissionConfig(agent)
	env := append(os.Environ(), "POCKETCTL_SESSION_ID="+id)
	if sm.approvalEnabled && sm.approvals != nil {
		env = append(env, "POCKETCTL_APPROVAL_SOCK="+sm.approvals.SocketPath(), "POCKETCTL_PERM_MODE="+permission.Mode)
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.sessions[id] != ps {
		return nil
	}
	if ps == nil {
		now := time.Now()
		ps = &ProcessState{SessionID: id, Agent: agent, Cwd: cwd, Status: protocol.StatusExited, StartedAt: now, LastActivityAt: now, Model: resolveCleanModel()}
		sm.sessions[id] = ps
	}
	ps.Source, ps.ClaudePrintSession, ps.ClaudePrintStarted = "daemon", true, true
	ps.Permission, ps.ClaudePrintEnv = &permission, env
	registerCwdKeyLocked(sm, id, normalizeCwd(cwd))
	return ps
}
