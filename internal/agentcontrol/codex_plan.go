package agentcontrol

import (
	"path/filepath"
	"strings"
)

type CodexLaunchPlan struct {
	Mode       LaunchMode
	Intent     string
	CWD        string
	SessionID  string
	NativeArgs []string
	TUIArgs    []string
	Reason     string
}

var codexNativeCommands = map[string]bool{
	"exec": true, "review": true, "login": true, "logout": true,
	"mcp": true, "plugin": true, "mcp-server": true, "app-server": true,
	"remote-control": true, "app": true, "completion": true, "update": true,
	"doctor": true, "sandbox": true, "debug": true, "apply": true,
	"archive": true, "delete": true, "unarchive": true, "fork": true,
	"cloud": true, "exec-server": true, "features": true, "help": true,
}

func PlanCodex(args []string, cwd string) CodexLaunchPlan {
	cwd, _ = filepath.Abs(cwd)
	native := append([]string(nil), args...)
	for index, arg := range args {
		if arg == "--native" {
			native = append(append([]string(nil), args[:index]...), args[index+1:]...)
			return CodexLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: native, Reason: "explicit native mode"}
		}
		if arg == "--remote" || strings.HasPrefix(arg, "--remote=") {
			return CodexLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: native, Reason: "explicit remote endpoint"}
		}
	}
	if len(args) == 0 {
		return CodexLaunchPlan{Mode: LaunchManaged, Intent: IntentNew, CWD: cwd}
	}
	if args[0] == "--help" || args[0] == "-h" || args[0] == "--version" || args[0] == "-V" || codexNativeCommands[args[0]] {
		return CodexLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: native, Reason: "native command"}
	}
	if args[0] == "resume" {
		if len(args) < 2 || strings.HasPrefix(args[1], "-") || strings.TrimSpace(args[1]) == "" {
			return CodexLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: native, Reason: "resume picker or option"}
		}
		return CodexLaunchPlan{
			Mode: LaunchManaged, Intent: IntentResume, CWD: cwd, SessionID: args[1],
			TUIArgs: append([]string(nil), args...),
		}
	}
	return CodexLaunchPlan{Mode: LaunchManaged, Intent: IntentNew, CWD: cwd, TUIArgs: append([]string(nil), args...)}
}

func (p CodexLaunchPlan) ManagedArgs(remoteURI string) []string {
	args := append([]string(nil), p.TUIArgs...)
	return append(args, "--remote", remoteURI)
}
