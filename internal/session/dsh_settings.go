package session

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/dshapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type dshModelSelection struct {
	Provider        string `json:"provider"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoningEffort"`
}

// DSHSettings reads the native projection, including selections not consumed by
// an LLM request yet. The Host remains the authority after reconnects.
func (sm *SessionManager) DSHSettings(ctx context.Context, id string) (protocol.DaemonEvent, error) {
	b := sm.dshBackendFor(id)
	if b == nil {
		return protocol.DaemonEvent{}, fmt.Errorf("not a DSH session")
	}
	b.coord.settingsMu.Lock()
	defer b.coord.settingsMu.Unlock()
	client, err := b.coord.connect(ctx)
	if err != nil {
		return protocol.DaemonEvent{}, err
	}
	var projection struct {
		Values struct {
			Permissions struct {
				Current string `json:"currentValue"`
			} `json:"permissions"`
			Model struct {
				Next *dshModelSelection `json:"next"`
				Last *dshModelSelection `json:"lastUsed"`
			} `json:"modelSelection"`
		} `json:"values"`
	}
	if err := client.Call(ctx, "session/projections", dshapp.Request(map[string]any{"sessionId": id}), &projection); err != nil {
		return protocol.DaemonEvent{}, err
	}
	var catalog struct {
		Options []struct {
			Value string `json:"value"`
		} `json:"options"`
	}
	if err := client.Call(ctx, "permissionPresets/catalog", map[string]any{}, &catalog); err != nil {
		return protocol.DaemonEvent{}, err
	}
	event := protocol.DaemonEvent{Type: "session_meta", SessionID: id, Agent: adapter.AgentDSH, ControlMode: protocol.ControlManaged, Capabilities: sm.SessionCapabilities(id)}
	selected := projection.Values.Model.Next
	if selected == nil {
		selected = projection.Values.Model.Last
	}
	if selected != nil {
		event.Model = selected.Provider + "/" + selected.Model
		event.Effort = selected.ReasoningEffort
	}
	event.Models = b.coord.models()
	if current := projection.Values.Permissions.Current; current != "" {
		event.Permission = &protocol.PermissionConfig{Agent: adapter.AgentDSH, Preset: current}
	}
	for _, option := range catalog.Options {
		event.PermissionMutableModes = append(event.PermissionMutableModes, option.Value)
	}
	sm.mu.Lock()
	if ps := sm.sessions[id]; ps != nil {
		ps.Model = event.Model
		ps.Effort = event.Effort
		ps.Permission = clonePermission(event.Permission)
		event.Cwd = ps.Cwd
		event.PermissionMutable = ps.Status == protocol.StatusIdle && len(catalog.Options) > 0
	}
	sm.mu.Unlock()
	return event, nil
}

func (c *dshCoordinator) publishSettings(id string) {
	ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
	defer cancel()
	if event, err := c.sm.DSHSettings(ctx, id); err == nil {
		c.sm.outputCh <- event
	}
}

func (b *dshBackend) setPermission(ctx context.Context, id string, cfg *protocol.PermissionConfig) error {
	if cfg == nil || cfg.Agent != adapter.AgentDSH || cfg.Preset == "" || cfg.Mode != "" || cfg.SandboxMode != "" || cfg.ApprovalPolicy != "" || cfg.DangerousBypass {
		return fmt.Errorf("DSH permission requires only agent and a native preset")
	}
	// Preset names become an argument to a native command, never a model prompt.
	if strings.ContainsAny(cfg.Preset, " \t\r\n") {
		return fmt.Errorf("invalid DSH permission preset")
	}
	b.coord.sm.mu.RLock()
	ps := b.coord.sm.sessions[id]
	idle := ps != nil && ps.Status == protocol.StatusIdle
	policy := b.coord.sm.remotePermission
	b.coord.sm.mu.RUnlock()
	if !idle {
		return fmt.Errorf("session_busy")
	}
	// Custom and Auto presets can remove confinement too. Require the local
	// opt-in for any preset beyond the two confined built-in modes.
	if cfg.Preset != "read-only" && cfg.Preset != "workspace-write" && !policy.AllowDangerous {
		return fmt.Errorf("permission preset %q requires the daemon-local --allow-dangerous-remote-permissions switch", cfg.Preset)
	}
	settings, err := b.coord.sm.DSHSettings(ctx, id)
	if err != nil {
		return err
	}
	if indexString(settings.PermissionMutableModes, cfg.Preset) < 0 {
		return fmt.Errorf("native permission preset is unavailable")
	}
	client, err := b.coord.connect(ctx)
	if err != nil {
		return err
	}
	var admission any
	if err := client.Call(ctx, "commands/execute", map[string]any{"agentId": id, "line": "/permission " + cfg.Preset, "submittedAttachments": []any{}}, &admission); err != nil {
		return err
	}
	// Command admission is not completion. Confirm the resulting projection.
	for i := 0; i < 20; i++ {
		confirmed, err := b.coord.sm.DSHSettings(ctx, id)
		if err != nil {
			return err
		}
		if confirmed.Permission != nil && confirmed.Permission.Preset == cfg.Preset {
			b.coord.sm.outputCh <- protocol.DaemonEvent{Type: "permission_config_changed", SessionID: id, Permission: confirmed.Permission, PermissionEffective: "immediate"}
			b.coord.sm.outputCh <- confirmed
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("native permission command did not apply the requested preset")
}

// DSHCreationPermissionModes advertises only presets the native Host and this
// daemon's local policy both allow. Creation still validates again before use.
func (sm *SessionManager) DSHCreationPermissionModes(ctx context.Context) ([]string, error) {
	client, err := sm.ensureDSH().connect(ctx)
	if err != nil {
		return nil, err
	}
	var catalog struct {
		Options []struct {
			Value string `json:"value"`
		} `json:"options"`
	}
	if err := client.Call(ctx, "permissionPresets/catalog", map[string]any{}, &catalog); err != nil {
		return nil, err
	}
	sm.mu.RLock()
	policy := sm.remotePermission
	sm.mu.RUnlock()
	modes := []string{}
	for _, option := range catalog.Options {
		cfg := &protocol.PermissionConfig{Agent: adapter.AgentDSH, Preset: option.Value}
		if adapter.ValidateRemotePermissionConfigWithPolicy(adapter.AgentDSH, cfg, policy) == nil {
			modes = append(modes, option.Value)
		}
	}
	return modes, nil
}
