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

func cmdAgent(args []string) {
	if err := runAgentCommand(args, os.Stdout, os.Stderr, agentcontrol.NewInstaller()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runAgentCommand(args []string, stdout, stderr io.Writer, manager agentcontrol.Manager) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(stdout, i18n.T("agent.help"))
		return nil
	}
	if args[0] != agentcontrol.AgentOpenCode {
		return fmt.Errorf("%s", i18n.T("agent.unknown", args[0]))
	}
	if len(args) == 1 || args[1] == "help" || args[1] == "--help" || args[1] == "-h" {
		fmt.Fprintln(stdout, i18n.T("agent.opencode_help"))
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
		path, _, err := manager.Detect(ctx)
		if err != nil {
			return err
		}
		status, err := manager.EnableDetected(ctx, path, agentcontrol.EnableOptions{NoShellProfile: *noShellProfile, DecisionSource: agentcontrol.SourceCommand})
		if err != nil {
			return err
		}
		fmt.Fprintln(stdout, i18n.T("agent.enabled", status.RealBinary))
		return nil
	case "disable":
		if len(args) != 2 {
			return fmt.Errorf("%s", i18n.T("agent.opencode_help"))
		}
		if err := manager.Disable(ctx); err != nil {
			return err
		}
		fmt.Fprintln(stdout, i18n.T("agent.disabled"))
		return nil
	case "status":
		if len(args) != 2 {
			return fmt.Errorf("%s", i18n.T("agent.opencode_help"))
		}
		printAgentStatus(stdout, manager.Status(ctx))
		return nil
	default:
		return fmt.Errorf("%s", i18n.T("agent.unknown_opencode", args[1]))
	}
}

func printAgentStatus(output io.Writer, status agentcontrol.Status) {
	fmt.Fprintln(output, i18n.T("agent.status_detected", yesNo(status.Detected)))
	fmt.Fprintln(output, i18n.T("agent.status_state", status.State))
	fmt.Fprintln(output, i18n.T("agent.status_binary", displayValue(status.RealBinary)))
	fmt.Fprintln(output, i18n.T("agent.status_launcher", displayValue(status.ShimPath)))
	fmt.Fprintln(output, i18n.T("agent.status_path", yesNo(status.PathActive)))
	fmt.Fprintln(output, i18n.T("agent.status_runtime", yesNo(status.RuntimeReachable)))
	if status.Error != "" {
		fmt.Fprintln(output, i18n.T("agent.status_error", status.Error))
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
