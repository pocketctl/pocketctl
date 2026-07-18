package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/i18n"
)

func daemonAgentPromptContext(noPrompt bool, restartReadyFile string, daemonChild bool, inputMode os.FileMode) agentcontrol.PromptContext {
	return agentcontrol.PromptContext{
		IsTTY:         inputMode&os.ModeCharDevice != 0,
		NoAgentPrompt: noPrompt,
		IsDaemonChild: daemonChild,
		IsRestart:     restartReadyFile != "",
	}
}

func maybePromptOpenCodeForDaemon(noPrompt bool, restartReadyFile string) {
	var mode os.FileMode
	if info, err := os.Stdin.Stat(); err == nil {
		mode = info.Mode()
	}
	promptContext := daemonAgentPromptContext(noPrompt, restartReadyFile, os.Getenv("POCKETCTL_DAEMON_CHILD") == "1", mode)
	agentcontrol.MaybePromptOpenCode(context.Background(), os.Stdin, os.Stdout, promptContext, agentcontrol.NewInstaller())
}

func daemonAgentAutoEnableContext(skip bool, restartReadyFile string, daemonChild bool) agentcontrol.AutoEnableContext {
	return agentcontrol.AutoEnableContext{
		Skip:          skip,
		IsDaemonChild: daemonChild,
		IsRestart:     restartReadyFile != "",
	}
}

func maybeAutoEnableAgentsForDaemon(skip bool, restartReadyFile string) agentcontrol.AutoEnableResult {
	start := daemonAgentAutoEnableContext(skip, restartReadyFile, os.Getenv("POCKETCTL_DAEMON_CHILD") == "1")
	return agentcontrol.AutoEnableAgents(context.Background(), os.Stderr, start, agentcontrol.NewInstaller())
}

func cmdAgent(args []string) {
	if err := runAgentCommand(args, os.Stdout, os.Stderr, agentcontrol.NewInstaller()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runAgentCommand(args []string, stdout, stderr io.Writer, manager any) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(stdout, i18n.T("agent.help"))
		return nil
	}
	agent := args[0]
	if agent != agentcontrol.AgentOpenCode && agent != agentcontrol.AgentCodex {
		return fmt.Errorf("%s", i18n.T("agent.unknown", args[0]))
	}
	if len(args) == 1 || args[1] == "help" || args[1] == "--help" || args[1] == "-h" {
		fmt.Fprintln(stdout, i18n.T("agent."+agent+"_help"))
		return nil
	}
	ctx := context.Background()
	switch args[1] {
	case "enable":
		fs := flag.NewFlagSet("agent opencode enable", flag.ContinueOnError)
		fs.SetOutput(stderr)
		noShellProfile := fs.Bool("no-shell-profile", false, i18n.T("agent.no_shell_profile"))
		if err := fs.Parse(args[2:]); err != nil {
			return err
		}
		path, _, err := detectManagedAgent(ctx, manager, agent)
		if err != nil {
			return err
		}
		status, err := enableManagedAgent(ctx, manager, agent, path, agentcontrol.EnableOptions{NoShellProfile: *noShellProfile, DecisionSource: agentcontrol.SourceCommand})
		if err != nil {
			return err
		}
		fmt.Fprintln(stdout, i18n.T("agent.enabled", agent, status.RealBinary))
		return nil
	case "disable":
		if len(args) != 2 {
			return fmt.Errorf("%s", i18n.T("agent."+agent+"_help"))
		}
		if err := disableManagedAgent(ctx, manager, agent); err != nil {
			return err
		}
		fmt.Fprintln(stdout, i18n.T("agent.disabled", agent))
		return nil
	case "status":
		if len(args) != 2 {
			return fmt.Errorf("%s", i18n.T("agent."+agent+"_help"))
		}
		printAgentStatus(stdout, statusManagedAgent(ctx, manager, agent))
		return nil
	default:
		return fmt.Errorf("%s", i18n.T("agent.unknown_action", agent, args[1]))
	}
}

func detectManagedAgent(ctx context.Context, manager any, agent string) (string, string, error) {
	if generic, ok := manager.(agentcontrol.MultiAgentManager); ok {
		return generic.DetectAgent(ctx, agent)
	}
	if legacy, ok := manager.(agentcontrol.Manager); ok && agent == agentcontrol.AgentOpenCode {
		return legacy.Detect(ctx)
	}
	return "", "", fmt.Errorf("agent manager does not support %s", agent)
}

func enableManagedAgent(ctx context.Context, manager any, agent, path string, options agentcontrol.EnableOptions) (agentcontrol.Status, error) {
	if generic, ok := manager.(agentcontrol.MultiAgentManager); ok {
		return generic.EnableAgentDetected(ctx, agent, path, options)
	}
	if legacy, ok := manager.(agentcontrol.Manager); ok && agent == agentcontrol.AgentOpenCode {
		return legacy.EnableDetected(ctx, path, options)
	}
	return agentcontrol.Status{}, fmt.Errorf("agent manager does not support %s", agent)
}

func disableManagedAgent(ctx context.Context, manager any, agent string) error {
	if generic, ok := manager.(agentcontrol.MultiAgentManager); ok {
		return generic.DisableAgent(ctx, agent)
	}
	if legacy, ok := manager.(agentcontrol.Manager); ok && agent == agentcontrol.AgentOpenCode {
		return legacy.Disable(ctx)
	}
	return fmt.Errorf("agent manager does not support %s", agent)
}

func statusManagedAgent(ctx context.Context, manager any, agent string) agentcontrol.Status {
	if generic, ok := manager.(agentcontrol.MultiAgentManager); ok {
		return generic.StatusAgent(ctx, agent)
	}
	if legacy, ok := manager.(agentcontrol.Manager); ok && agent == agentcontrol.AgentOpenCode {
		return legacy.Status(ctx)
	}
	return agentcontrol.Status{Agent: agent, State: agentcontrol.StateUndecided, Error: "agent manager unsupported"}
}

func printAgentStatus(output io.Writer, status agentcontrol.Status) {
	fmt.Fprintln(output, i18n.T("agent.status_agent", displayValue(status.Agent)))
	fmt.Fprintln(output, i18n.T("agent.status_detected", yesNo(status.Detected)))
	fmt.Fprintln(output, i18n.T("agent.status_version", displayValue(status.Version)))
	fmt.Fprintln(output, i18n.T("agent.status_state", status.State))
	fmt.Fprintln(output, i18n.T("agent.status_effective", displayValue(status.EffectiveMode)))
	fmt.Fprintln(output, i18n.T("agent.status_binary", displayValue(status.RealBinary)))
	fmt.Fprintln(output, i18n.T("agent.status_launcher", displayValue(status.ShimPath)))
	fmt.Fprintln(output, i18n.T("agent.status_path", yesNo(status.PathActive)))
	fmt.Fprintln(output, i18n.T("agent.status_runtime", yesNo(status.RuntimeReachable)))
	if status.Error != "" {
		fmt.Fprintln(output, i18n.T("agent.status_error", status.Error))
	}
	if status.CapabilityReason != "" {
		fmt.Fprintln(output, i18n.T("agent.status_capability", status.CapabilityReason))
	}
}

func yesNo(value bool) string {
	if value {
		return i18n.T("agent.yes")
	}
	return i18n.T("agent.no")
}

func displayValue(value string) string {
	if value == "" {
		return "-"
	}
	return value
}
