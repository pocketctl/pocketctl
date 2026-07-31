package agentcontrol

import (
	"context"
	"errors"
	"fmt"
	"io"
)

type AutoEnableContext struct {
	Skip          bool
	IsDaemonChild bool
	IsRestart     bool
}

type AutoEnableWarning struct {
	Agent string
	Err   error
}

type AutoEnableResult struct {
	Enabled  []string
	Warnings []AutoEnableWarning
}

func AutoEnableAgents(ctx context.Context, output io.Writer, start AutoEnableContext, manager MultiAgentManager) AutoEnableResult {
	result := AutoEnableResult{}
	if start.Skip || start.IsDaemonChild || start.IsRestart {
		return result
	}
	cfg, err := LoadConfig()
	if err != nil {
		result.Warnings = append(result.Warnings, AutoEnableWarning{Agent: "config", Err: err})
		fmt.Fprintf(output, "pocketctl: agent setup warning: %v\n", err)
		return result
	}
	for _, agent := range []string{AgentOpenCode, AgentCodex} {
		agentConfig, configErr := getAgentConfig(cfg, agent)
		if configErr != nil || agentConfig.State == StateDisabled {
			continue
		}
		path, _, detectErr := manager.DetectAgent(ctx, agent)
		if detectErr != nil {
			result.Warnings = append(result.Warnings, AutoEnableWarning{Agent: agent, Err: detectErr})
			fmt.Fprintf(output, "pocketctl: %s managed control unavailable: %v; daemon will continue\n", agent, detectErr)
			continue
		}
		if agentConfig.State == StateEnabled {
			status := manager.StatusAgent(ctx, agent)
			reason := status.CapabilityReason
			if reason == "" {
				reason = status.Error
			}
			if reason != "" {
				warning := errors.New(reason)
				result.Warnings = append(result.Warnings, AutoEnableWarning{Agent: agent, Err: warning})
				fmt.Fprintf(output, "pocketctl: %s remains enabled but is using native fallback: %v; daemon will continue\n", agent, warning)
				continue
			}
			source := agentConfig.DecisionSource
			if source == "" {
				source = SourceDaemonAuto
			}
			if _, enableErr := manager.EnableAgentDetected(ctx, agent, path, EnableOptions{DecisionSource: source}); enableErr != nil {
				result.Warnings = append(result.Warnings, AutoEnableWarning{Agent: agent, Err: enableErr})
				fmt.Fprintf(output, "pocketctl: %s launcher reconciliation failed: %v; daemon will continue\n", agent, enableErr)
			}
			continue
		}
		if _, enableErr := manager.EnableAgentDetected(ctx, agent, path, EnableOptions{DecisionSource: SourceDaemonAuto}); enableErr != nil {
			result.Warnings = append(result.Warnings, AutoEnableWarning{Agent: agent, Err: enableErr})
			fmt.Fprintf(output, "pocketctl: %s managed control was not enabled: %v; daemon will continue\n", agent, enableErr)
			continue
		}
		result.Enabled = append(result.Enabled, agent)
		fmt.Fprintf(output, "pocketctl: enabled %s managed terminal control\n", agent)
	}
	return result
}
