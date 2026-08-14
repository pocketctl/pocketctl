package agentcontrol

import (
	"path/filepath"
	"strings"
)

type LaunchMode string

const (
	LaunchManaged LaunchMode = "managed"
	LaunchNative  LaunchMode = "native"
	// LaunchChannel is used by the Claude Code Channel permission relay
	// launcher. It is distinct from LaunchManaged: Claude does NOT get a
	// RuntimeProvider. The mode indicates that the launcher will inject the
	// Pocketctl-owned Channel MCP config and research-preview flags after a
	// bootstrap probe succeeds; the real Claude native TUI remains the
	// runtime authority. Design §Task 3.
	LaunchChannel LaunchMode = "channel"
)

type OpenCodeLaunchPlan struct {
	Mode       LaunchMode
	Intent     string
	CWD        string
	SessionID  string
	Fork       bool
	NativeArgs []string
	RunArgs    []string
	Warn       bool
	Reason     string
}

var openCodeNativeCommands = map[string]bool{
	"serve": true, "attach": true, "web": true,
	"upgrade": true, "uninstall": true, "mcp": true, "models": true,
	"export": true, "import": true, "auth": true, "stats": true,
	"completion": true, "debug": true, "github": true, "agent": true,
	"session": true, "db": true, "acp": true,
}

func PlanOpenCode(args []string, cwd string) OpenCodeLaunchPlan {
	cwd, _ = filepath.Abs(cwd)
	native := append([]string(nil), args...)
	for i, arg := range args {
		if arg == "--native" {
			native = append(append([]string(nil), args[:i]...), args[i+1:]...)
			return OpenCodeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: native, Reason: "explicit native mode"}
		}
	}
	if len(args) == 0 {
		return OpenCodeLaunchPlan{Mode: LaunchManaged, Intent: IntentNew, CWD: cwd}
	}
	if openCodeNativeCommands[args[0]] {
		return OpenCodeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: native, Reason: "native command"}
	}
	if args[0] == "run" {
		if hasFlag(args[1:], "--attach") {
			return OpenCodeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: native, Reason: "explicit attach"}
		}
		return OpenCodeLaunchPlan{Mode: LaunchManaged, Intent: IntentRun, CWD: cwd, RunArgs: append([]string(nil), args[1:]...)}
	}

	plan := OpenCodeLaunchPlan{Mode: LaunchManaged, Intent: IntentNew, CWD: cwd}
	for i := 0; i < len(args); i++ {
		switch arg := args[i]; {
		case arg == "-c" || arg == "--continue":
			if plan.Intent != IntentNew {
				return incompatiblePlan(native, cwd, "conflicting session options")
			}
			plan.Intent = IntentContinue
		case arg == "-s" || arg == "--session":
			if plan.Intent != IntentNew || i+1 >= len(args) || strings.TrimSpace(args[i+1]) == "" {
				return incompatiblePlan(native, cwd, "invalid session option")
			}
			i++
			plan.Intent, plan.SessionID = IntentResume, args[i]
		case strings.HasPrefix(arg, "--session="):
			id := strings.TrimPrefix(arg, "--session=")
			if plan.Intent != IntentNew || id == "" {
				return incompatiblePlan(native, cwd, "invalid session option")
			}
			plan.Intent, plan.SessionID = IntentResume, id
		case arg == "--fork":
			plan.Fork = true
		case strings.HasPrefix(arg, "-"):
			return incompatiblePlan(native, cwd, "unsupported top-level option")
		default:
			if len(args) != 1 || plan.Intent != IntentNew {
				return incompatiblePlan(native, cwd, "unsupported argument combination")
			}
			projectArg := arg
			if !filepath.IsAbs(projectArg) {
				projectArg = filepath.Join(cwd, projectArg)
			}
			project, err := filepath.Abs(projectArg)
			if err != nil || !isDirectory(project) {
				return incompatiblePlan(native, cwd, "unknown top-level command")
			}
			plan.CWD = project
		}
	}
	if plan.Fork && plan.Intent == IntentNew {
		return incompatiblePlan(native, cwd, "fork requires continue or resume")
	}
	return plan
}

func incompatiblePlan(args []string, cwd, reason string) OpenCodeLaunchPlan {
	return OpenCodeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: args, Warn: true, Reason: reason}
}

func hasFlag(args []string, name string) bool {
	for _, arg := range args {
		if arg == name || strings.HasPrefix(arg, name+"=") {
			return true
		}
	}
	return false
}

func (p OpenCodeLaunchPlan) ManagedArgs(result AcquireResult) []string {
	if p.Intent == IntentRun {
		args := []string{"run", "--attach", result.BaseURL}
		if !hasFlag(p.RunArgs, "--dir") {
			args = append(args, "--dir", p.CWD)
		}
		if result.ResolvedSessionID != "" {
			args = append(args, "--session", result.ResolvedSessionID)
		}
		return append(args, p.RunArgs...)
	}
	args := []string{"attach", result.BaseURL, "--dir", p.CWD}
	if result.ResolvedSessionID != "" {
		args = append(args, "--session", result.ResolvedSessionID)
	}
	if p.Fork {
		args = append(args, "--fork")
	}
	return args
}
