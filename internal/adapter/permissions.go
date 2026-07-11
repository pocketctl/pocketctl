package adapter

import (
	"fmt"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type CommandKind string

const (
	CommandCreate CommandKind = "create"
	CommandResume CommandKind = "resume"
)

func DefaultPermissionConfig(agent string) protocol.PermissionConfig {
	switch agent {
	case AgentClaude:
		return protocol.PermissionConfig{Agent: agent, Mode: "acceptEdits"}
	case AgentCodex:
		return protocol.PermissionConfig{Agent: agent, Preset: "custom"}
	default:
		return protocol.PermissionConfig{Agent: agent}
	}
}

func ValidatePermissionConfig(agent string, cfg *protocol.PermissionConfig) error {
	if cfg == nil {
		return nil
	}
	if cfg.Agent != agent {
		return fmt.Errorf("permission agent %q does not match %q", cfg.Agent, agent)
	}
	switch agent {
	case AgentClaude:
		if cfg.Preset != "" || cfg.ApprovalPolicy != "" || cfg.SandboxMode != "" || cfg.DangerousBypass {
			return fmt.Errorf("codex permission fields are invalid for claude-code")
		}
		if !oneOf(cfg.Mode, "manual", "auto", "acceptEdits", "dontAsk", "plan", "bypassPermissions") {
			return fmt.Errorf("invalid claude permission mode %q", cfg.Mode)
		}
	case AgentCodex:
		if cfg.Mode != "" {
			return fmt.Errorf("claude permission mode is invalid for codex")
		}
		if !oneOf(cfg.Preset, "request_approval", "agent_managed", "full_access", "custom") {
			return fmt.Errorf("invalid codex preset %q", cfg.Preset)
		}
		if cfg.DangerousBypass {
			if cfg.ApprovalPolicy != "" || cfg.SandboxMode != "" {
				return fmt.Errorf("dangerous bypass conflicts with explicit policy or sandbox")
			}
			return nil
		}
		if cfg.ApprovalPolicy != "" && !oneOf(cfg.ApprovalPolicy, "untrusted", "on-request", "never") {
			return fmt.Errorf("invalid codex approval policy %q", cfg.ApprovalPolicy)
		}
		if cfg.SandboxMode != "" && !oneOf(cfg.SandboxMode, "read-only", "workspace-write", "danger-full-access") {
			return fmt.Errorf("invalid codex sandbox mode %q", cfg.SandboxMode)
		}
	case AgentOpencode:
		return fmt.Errorf("opencode does not support permission configuration")
	default:
		return fmt.Errorf("unknown agent %q", agent)
	}
	return nil
}

func PermissionArgs(agent string, cfg *protocol.PermissionConfig, _ CommandKind) ([]string, error) {
	if cfg == nil {
		return nil, nil
	}
	if err := ValidatePermissionConfig(agent, cfg); err != nil {
		return nil, err
	}
	if agent == AgentClaude {
		return []string{"--permission-mode", cfg.Mode}, nil
	}
	if cfg.DangerousBypass {
		return []string{"--dangerously-bypass-approvals-and-sandbox"}, nil
	}
	args := []string{}
	if cfg.ApprovalPolicy != "" {
		args = append(args, "-c", fmt.Sprintf("approval_policy=%q", cfg.ApprovalPolicy))
	}
	if cfg.SandboxMode != "" {
		args = append(args, "-c", fmt.Sprintf("sandbox_mode=%q", cfg.SandboxMode))
	}
	return args, nil
}

func oneOf(value string, allowed ...string) bool {
	for _, item := range allowed {
		if value == item {
			return true
		}
	}
	return false
}
