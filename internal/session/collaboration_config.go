package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Discovery reads actual host configuration/catalogs. Missing data never
// becomes a hard-coded model or an implicit full-access permission.
func (sm *SessionManager) TeamConfigCapabilities(ctx context.Context, agent string) *protocol.TeamConfigCapabilities {
	c := &protocol.TeamConfigCapabilities{SchemaVersion: 2, Models: []protocol.TeamConfigModel{}, PermissionProfiles: []string{}, DefaultSource: "daemon-local-settings", RuntimeSwitch: "recreate"}
	var models []protocol.ModelOption
	switch agent {
	case adapter.AgentClaude:
		models = ListAvailableModels()
		c.DefaultConfig.Model = resolveCleanModel()
		c.DefaultConfig.PermissionProfile = "manual"
		c.PermissionProfiles = []string{"manual", "acceptEdits", "plan"}
		for _, m := range models {
			id := resolveModelAlias(m.Alias)
			duplicate := false
			for _, existing := range c.Models {
				if existing.ID == id {
					duplicate = true
				}
			}
			if id != "" && !duplicate {
				c.Models = append(c.Models, protocol.TeamConfigModel{ID: id, ReasoningEfforts: []string{}})
			}
		}
	case adapter.AgentCodex:
		profile, err := sm.CodexRuntimeProvider().profileForHomeID("")
		if err != nil {
			return nil
		}
		models = sm.teamCodexModels(ctx)
		c.DefaultConfig.Model = teamCodexConfigValue(profile.Home, "model")
		for _, m := range models {
			if c.DefaultConfig.Model == "" && m.IsDefault {
				c.DefaultConfig.Model = m.Alias
			}
		}
		effort := teamCodexConfigValue(profile.Home, "model_reasoning_effort")
		if effort == "" {
			for _, m := range models {
				if m.Alias == c.DefaultConfig.Model {
					effort = m.DefaultReasoningEffort
				}
			}
		}
		if effort != "" {
			c.DefaultConfig.ReasoningEffort = &effort
		}
		c.PermissionProfiles = []string{"request_approval", "read_only"}
		c.ReadOnly = true
		c.DefaultConfig.PermissionProfile = "request_approval"
		if teamCodexConfigValue(profile.Home, "sandbox_mode") == "read-only" {
			c.DefaultConfig.PermissionProfile = "read_only"
		}
	case adapter.AgentDSH:
		// The current native session/selectModel API also saves the Host-wide
		// default. Until DSH exposes an isolated selection operation, advertise
		// no v2 configuration rather than changing personal-session defaults.
		return nil
	default:
		return nil
	}
	if agent != adapter.AgentClaude {
		for _, m := range models {
			efforts := append([]string{}, m.SupportedReasoningEfforts...)
			item := protocol.TeamConfigModel{ID: m.Alias, ReasoningEfforts: efforts}
			if m.DefaultReasoningEffort != "" {
				e := m.DefaultReasoningEffort
				item.DefaultReasoningEffort = &e
			}
			c.Models = append(c.Models, item)
		}
	}
	if len(c.Models) == 0 || c.DefaultConfig.Model == "" {
		return nil
	}
	found := false
	for _, m := range c.Models {
		if m.ID == c.DefaultConfig.Model {
			found = true
		}
	}
	if !found {
		slog.Warn("Team model default is absent from native model list", "agent", agent, "model", c.DefaultConfig.Model)
		return nil
	}
	// A host default edit must not invalidate an existing Binding's snapshot.
	// Only execution capabilities determine revision; catalog ordering is not semantic.
	canonical := *c
	canonical.DefaultConfig = protocol.TeamRuntimeConfig{}
	canonical.DefaultSource = ""
	canonical.Models = append([]protocol.TeamConfigModel{}, c.Models...)
	for i := range canonical.Models {
		canonical.Models[i].ReasoningEfforts = append([]string{}, canonical.Models[i].ReasoningEfforts...)
		sort.Strings(canonical.Models[i].ReasoningEfforts)
	}
	sort.Slice(canonical.Models, func(i, j int) bool { return canonical.Models[i].ID < canonical.Models[j].ID })
	canonical.PermissionProfiles = append([]string{}, c.PermissionProfiles...)
	sort.Strings(canonical.PermissionProfiles)
	data, _ := json.Marshal(canonical)
	sum := sha256.Sum256(data)
	c.Revision = hex.EncodeToString(sum[:])
	return c
}
func validateTeamRuntimeConfig(c *protocol.TeamRuntimeConfig, cap *protocol.TeamConfigCapabilities) error {
	if c == nil || cap == nil {
		return fmt.Errorf("team_configuration_unsupported")
	}
	valid := false
	for _, m := range cap.Models {
		if m.ID == c.Model && (c.ReasoningEffort == nil || indexOfString(m.ReasoningEfforts, *c.ReasoningEffort) >= 0) {
			valid = true
		}
	}
	if !valid || indexOfString(cap.PermissionProfiles, c.PermissionProfile) < 0 {
		return fmt.Errorf("team_configuration_unsupported")
	}
	return nil
}
func teamPermission(agent, profile string) (*protocol.PermissionConfig, error) {
	p := adapter.DefaultPermissionConfig(agent)
	switch agent {
	case adapter.AgentClaude:
		p.Mode = profile
	case adapter.AgentCodex:
		switch profile {
		case "read_only":
			p.SandboxMode = "read-only"
		case "request_approval":
		default:
			return nil, fmt.Errorf("team_configuration_unsupported")
		}
	case adapter.AgentDSH:
		p.Preset = profile
	default:
		return nil, fmt.Errorf("team_configuration_unsupported")
	}
	return &p, adapter.ValidatePermissionConfig(agent, &p)
}
func (sm *SessionManager) validateTeamConfig(ctx context.Context, auth *protocol.CollaborationAuthorization, agent string) (*protocol.PermissionConfig, error) {
	if auth.RequestedConfig == nil {
		if auth.ConfigHash != "" || auth.ConfigRevision != 0 || auth.ExecutionMode != "" {
			return nil, ErrCollaborationAuthorization
		}
		return nil, nil // legacy dispatch retains its explicit v1 behavior
	}
	if auth.ConfigRevision < 1 || auth.RequestedConfig.Hash() != auth.ConfigHash {
		return nil, ErrCollaborationAuthorization
	}
	cap := sm.TeamConfigCapabilities(ctx, agent)
	if cap == nil {
		return nil, fmt.Errorf("team_configuration_unsupported")
	}
	sm.mu.RLock()
	advertised := sm.teamConfigAdvertised[agent]
	sm.mu.RUnlock()
	if advertised == "" {
		advertised = cap.Revision
	}
	if advertised != auth.CapabilityRevision {
		return nil, fmt.Errorf("team_capability_revision_changed")
	}
	if err := validateTeamRuntimeConfig(auth.RequestedConfig, cap); err != nil {
		return nil, err
	}
	if auth.ExecutionMode != "" && auth.ExecutionMode != "execute" {
		if (auth.ExecutionMode != "discussion" && auth.ExecutionMode != "review") || !cap.ReadOnly || (auth.RequestedConfig.PermissionProfile != "read_only" && auth.RequestedConfig.PermissionProfile != "read-only") {
			return nil, fmt.Errorf("team_read_only_required")
		}
	}
	p, err := teamPermission(agent, auth.RequestedConfig.PermissionProfile)
	if err != nil {
		return nil, err
	}
	sm.mu.RLock()
	policy := sm.remotePermission
	sm.mu.RUnlock()
	return p, adapter.ValidateRemotePermissionConfigWithPolicy(agent, p, policy)
}

// Receipts derive from actual process/native settings, never a copy of the
// requested envelope. A mismatch remains unconfirmed in Relay.
func (sm *SessionManager) TeamConfigReceipt(ctx context.Context, auth *protocol.CollaborationAuthorization, id string) *protocol.DaemonEvent {
	if auth == nil || auth.RequestedConfig == nil {
		return nil
	}
	sm.mu.RLock()
	ps := sm.sessions[id]
	agent := ""
	if ps != nil {
		agent = ps.Agent
	}
	sm.mu.RUnlock()
	if agent == adapter.AgentDSH {
		if _, err := sm.DSHSettings(ctx, id); err != nil {
			return nil
		}
	}
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps = sm.sessions[id]
	if ps == nil || ps.Permission == nil {
		return nil
	}
	c := &protocol.TeamRuntimeConfig{Model: ps.Model, PermissionProfile: ps.Permission.Mode}
	if strings.TrimSpace(ps.Effort) != "" {
		e := ps.Effort
		c.ReasoningEffort = &e
	}
	if agent == adapter.AgentCodex {
		native, ok := sm.teamNativeConfigs[id]
		if !ok || ps.Model != native.Model || ps.Permission.DangerousBypass || ps.Permission.ApprovalPolicy != "on-request" {
			return nil
		}
		profile := "request_approval"
		if ps.Permission.SandboxMode == "read-only" {
			profile = "read_only"
		} else if ps.Permission.SandboxMode != "workspace-write" {
			return nil
		}
		if profile != native.PermissionProfile {
			return nil
		}
		c = &native
	}
	if agent == adapter.AgentDSH {
		c.PermissionProfile = ps.Permission.Preset
	}
	return &protocol.DaemonEvent{Type: "collaboration_config_receipt", SessionID: id, Collaboration: auth, AppliedConfig: c, ConfigRevision: auth.ConfigRevision, ConfigHash: c.Hash()}
}

func teamCodexConfigValue(home, key string) string {
	data, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		left, right, ok := strings.Cut(line, "=")
		if ok && strings.TrimSpace(left) == key {
			v, err := strconv.Unquote(strings.TrimSpace(right))
			if err == nil {
				return v
			}
			return ""
		}
	}
	return ""
}
func (sm *SessionManager) teamCodexModels(ctx context.Context) []protocol.ModelOption {
	cfg, err := agentcontrol.LoadConfig()
	if err != nil || cfg.Codex.State != agentcontrol.StateEnabled {
		return nil
	}
	p := sm.CodexRuntimeProvider()
	binary, version, err := p.resolve()
	if err != nil {
		return nil
	}
	caps, err := p.probe(ctx, binary, version)
	if err != nil || !caps.Managed() || !caps.ThreadInjection || !caps.Approvals {
		return nil
	}
	coord, _, err := p.coordinatorForHomeID("")
	if err != nil {
		return nil
	}
	if _, err = coord.ensureStarted(ctx, binary, version, caps); err != nil {
		slog.Warn("Team Codex model discovery runtime unavailable", "error", err)
		return nil
	}
	client, _, ok := coord.backendClient()
	if !ok {
		return nil
	}
	var result struct {
		Data []struct {
			ID            string `json:"id"`
			Model         string `json:"model"`
			IsDefault     bool   `json:"isDefault"`
			DefaultEffort string `json:"defaultReasoningEffort"`
			Efforts       []struct {
				Value string `json:"reasoningEffort"`
			} `json:"supportedReasoningEfforts"`
		} `json:"data"`
	}
	if err = client.Call(ctx, "model/list", map[string]any{"limit": 100}, &result); err != nil {
		slog.Warn("Team Codex model discovery failed", "error", err)
		return nil
	}
	models := []protocol.ModelOption{}
	for _, m := range result.Data {
		id := m.Model
		if id == "" {
			id = m.ID
		}
		if id == "" {
			continue
		}
		option := protocol.ModelOption{Alias: id, Name: id, IsDefault: m.IsDefault, DefaultReasoningEffort: m.DefaultEffort}
		for _, e := range m.Efforts {
			option.SupportedReasoningEfforts = append(option.SupportedReasoningEfforts, e.Value)
		}
		models = append(models, option)
	}
	return models
}

func (sm *SessionManager) teamReadOnlySession(id string) bool {
	sm.collaborationMu.Lock()
	for _, b := range sm.collaborationBindings {
		if b.NativeSessionID == id {
			sm.collaborationMu.Unlock()
			return b.RuntimePermission == "read_only" || b.RuntimePermission == "read-only"
		}
	}
	sm.collaborationMu.Unlock()
	// Daemon-local durable ownership remains authoritative after restart.
	path, err := collaborationRecordPath(adapter.AgentCodex, id)
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
	if json.Unmarshal(data, &record) != nil || record.Version != 1 || record.Binding.NativeSessionID != id || record.Binding.Agent != adapter.AgentCodex {
		return false
	}
	return record.Binding.RuntimePermission == "read_only"
}

// Authorization names the inventory actually published by this daemon. A
// native catalog refresh may add unrelated account models between two calls;
// the selected model/effort and permission are still revalidated against the
// fresh native capabilities before every effect.
func (sm *SessionManager) RememberTeamConfigCapability(agent, revision string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.teamConfigAdvertised == nil {
		sm.teamConfigAdvertised = map[string]string{}
	}
	sm.teamConfigAdvertised[agent] = revision
}

// Settings returned by the native protocol, independent from Team intent.
type codexNativeConfigFields struct {
	Model           string          `json:"model"`
	ReasoningEffort *string         `json:"reasoningEffort"`
	ApprovalPolicy  json.RawMessage `json:"approvalPolicy"`
	Sandbox         struct {
		Type string `json:"type"`
	} `json:"sandbox"`
}

func (sm *SessionManager) rememberNativeCodexConfig(id string, value codexNativeConfigFields) {
	var approval string
	valid := json.Unmarshal(value.ApprovalPolicy, &approval) == nil && approval == "on-request" && value.Model != ""
	profile := ""
	switch value.Sandbox.Type {
	case "readOnly":
		profile = "read_only"
	case "workspaceWrite":
		profile = "request_approval"
	default:
		valid = false
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.teamNativeConfigs == nil {
		sm.teamNativeConfigs = map[string]protocol.TeamRuntimeConfig{}
	}
	if !valid {
		delete(sm.teamNativeConfigs, id)
		return
	}
	sm.teamNativeConfigs[id] = protocol.TeamRuntimeConfig{Model: value.Model, ReasoningEffort: value.ReasoningEffort, PermissionProfile: profile}
}

func (sm *SessionManager) rememberTeamCodexResume(id string, value codexNativeConfigFields, permission *protocol.PermissionConfig) {
	sm.rememberNativeCodexConfig(id, value)
	if permission == nil {
		return
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps := sm.sessions[id]; ps != nil {
		ps.Permission = clonePermission(permission)
		ps.Model = value.Model
		ps.Effort = ""
		if value.ReasoningEffort != nil {
			ps.Effort = *value.ReasoningEffort
		}
	}
}
