package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"os"
	"path/filepath"
)

func (sm *SessionManager) restoreConfiguredCollaborationCodex(ctx context.Context, auth *protocol.CollaborationAuthorization, id string, policy *CwdPolicy) error {
	if auth.RequestedConfig == nil {
		return nil
	}
	p, err := collaborationRecordPath(adapter.AgentCodex, id)
	if err != nil {
		return err
	}
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return ErrCollaborationBinding
	}
	data, err := os.ReadFile(p)
	var record collaborationNativeRecord
	if err != nil || json.Unmarshal(data, &record) != nil || record.Version != 1 {
		return ErrCollaborationBinding
	}
	b := record.Binding
	roots := policy.Roots()
	if len(roots) == 0 || record.Cwd != collaborationWorkspace(roots[0], auth.BindingID) || b.NativeSessionID != id || b.Agent != adapter.AgentCodex || b.BindingID != auth.BindingID || b.TeamSessionID != auth.TeamSessionID || b.BindingRevision != auth.BindingRevision || b.OfferID != auth.OfferID || b.OfferRevision != auth.OfferRevision || b.OwnerUserID != auth.OwnerUserID || b.DaemonID != auth.DaemonID || b.ConfigRevision != auth.ConfigRevision || b.ConfigHash != auth.ConfigHash {
		return ErrCollaborationBinding
	}
	if _, err = sm.validateTeamConfig(ctx, auth, adapter.AgentCodex); err != nil {
		return err
	}
	path, err := adapter.ResolveJSONLPathFor(adapter.AgentCodex, id, record.Cwd)
	if err != nil {
		return ErrCollaborationBinding
	}
	profile, ok := adapter.CodexHomeProfileForPath(path)
	meta, proof := adapter.ReadCodexRolloutMetadata(path)
	if !ok || !proof || meta.ID != id || meta.Originator != "pocketctl" || meta.IsSubagent || meta.ThreadSource == "subagent" || normalizeCwd(meta.Cwd) != normalizeCwd(record.Cwd) {
		return ErrCollaborationBinding
	}
	provider := sm.CodexRuntimeProvider()
	coord, err := provider.projectCoordinatorForHome(record.Cwd, profile.ID)
	if err != nil {
		return err
	}
	binary, version, err := provider.resolve()
	if err != nil {
		return err
	}
	caps, err := provider.probe(ctx, binary, version)
	if err != nil {
		return err
	}
	if _, err = coord.ensureStarted(ctx, binary, version, caps); err != nil {
		return err
	}
	if !coord.durableDaemonProjectThread(id) {
		return ErrCollaborationBinding
	}
	client, generation, ok := coord.backendClient()
	if !ok {
		return ErrCollaborationBinding
	}
	// The native thread lock joins any in-progress asynchronous hydration. This
	// resumes the original thread without submitting a user turn or replaying Call.
	coord.subscribeTerminalThread(ctx, client, generation, id, newCodexProjection(generation))
	if receipt := sm.TeamConfigReceipt(ctx, auth, id); receipt == nil || receipt.ConfigHash != auth.ConfigHash {
		return ErrCollaborationBinding
	}
	return nil
}

// Only local ownership records plus immutable rollout provenance may restore
// a Team thread's settings. Native history or a remote envelope alone cannot.
func (c *codexCoordinator) teamResumeParams(id string) (map[string]any, *protocol.PermissionConfig) {
	params := map[string]any{"threadId": id}
	if !c.durableDaemonProjectThread(id) {
		return params, nil
	}
	p, err := collaborationRecordPath(adapter.AgentCodex, id)
	if err != nil {
		return params, nil
	}
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return params, nil
	}
	data, err := os.ReadFile(p)
	var record collaborationNativeRecord
	if err != nil || json.Unmarshal(data, &record) != nil || record.Version != 1 || record.Cwd != c.projectCwd {
		return params, nil
	}
	b := record.Binding
	if b.NativeSessionID != id || b.Agent != adapter.AgentCodex || b.ConfigRevision <= 0 || b.RuntimeModel == "" || b.BindingID == "" || filepath.Base(c.projectCwd) != fmt.Sprintf("%x", sha256.Sum256([]byte(b.BindingID)))[:24] {
		return params, nil
	}
	config := protocol.TeamRuntimeConfig{Model: b.RuntimeModel, PermissionProfile: b.RuntimePermission}
	if b.RuntimeEffort != "" {
		config.ReasoningEffort = &b.RuntimeEffort
	}
	if config.Hash() != b.ConfigHash {
		return params, nil
	}
	permission, err := teamPermission(adapter.AgentCodex, b.RuntimePermission)
	if err != nil {
		return params, nil
	}
	params["model"] = b.RuntimeModel
	if b.RuntimeEffort != "" {
		params["config"] = map[string]any{"model_reasoning_effort": b.RuntimeEffort}
	}
	applyCodexPermissionParams(params, permission)
	return params, permission
}
