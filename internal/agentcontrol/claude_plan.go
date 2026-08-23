package agentcontrol

import (
	"path/filepath"
	"strings"
)

// ClaudeLaunchPlan is the plan emitted by PlanClaude for the Claude Code
// Channel permission relay launcher. It is intentionally simpler than the
// OpenCode/Codex managed-runtime plans: Claude does NOT get a
// RuntimeProvider. The plan only decides between LaunchNative (no Channel
// injection) and LaunchChannel (inject the Pocketctl Channel MCP config and
// research-preview flags).
//
// Design §3.3 and §Task 3.
type ClaudeLaunchPlan struct {
	Mode       LaunchMode
	Intent     string
	CWD        string
	SessionID  string
	NativeArgs []string
	// ChannelArgs are the Claude argv with Pocketctl Channel flags prepended.
	// Only populated when Mode == LaunchChannel.
	ChannelArgs []string
	// Reason is the human/telemetry reason for the chosen mode.
	Reason string
}

// claudeNativeOnlyFlags are Pocketctl shim escape flags OR Claude flags that
// must never receive Channel injection. Each forces LaunchNative with probe
// count = 0. Design §3.3: "--native 是 Pocketctl shim 自有 escape flag".
var claudeNativeOnlyFlags = map[string]bool{
	"--native": true,
}

// claudeNativeOnlyCommands are Claude subcommands that must run native
// (no probe, no injection). Design §3.3 enumerated list.
var claudeNativeOnlyCommands = map[string]bool{
	"auth": true, "login": true, "logout": true, "mcp": true,
	"plugin": true, "doctor": true, "update": true, "agents": true,
}

// claudeNativeOnlyFlagValues are flags whose presence (regardless of value)
// forces native mode. Design §3.3: "-p / --print, --bare, --safe-mode,
// --dangerously-skip-permissions, --permission-mode bypassPermissions".
func claudeHasNativeOnlyFlagValue(args []string) bool {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-p" || arg == "--print" || arg == "--bare" ||
			arg == "--safe-mode" || arg == "--dangerously-skip-permissions":
			return true
		case arg == "--permission-mode":
			if i+1 < len(args) && args[i+1] == "bypassPermissions" {
				return true
			}
		case strings.HasPrefix(arg, "--permission-mode=bypassPermissions"):
			return true
		}
	}
	return false
}

// claudeHasNativeHelpOrVersionFlag reports whether the args contain a
// help/version flag anywhere. Design §3.3: "--help / -h, --version / -v".
func claudeHasNativeHelpOrVersionFlag(args []string) bool {
	for _, arg := range args {
		switch arg {
		case "--help", "-h", "--version", "-v":
			return true
		}
	}
	return false
}

// claudeKnownChannelEligibleFlags is the set of top-level flags PlanClaude
// recognizes as safe to pass through with Channel injection. Any flag NOT in
// this set (or the native-only sets, or the known flag-value forms) forces
// LaunchNative so the launcher never mangles an unknown Claude flag.
var claudeKnownChannelEligibleFlags = map[string]bool{
	"--continue":        true,
	"--permission-mode": true, // value-checked in claudeHasNativeOnlyFlagValue
}

// claudeIsKnownFlagValueForm covers `--flag=value` shapes that are channel-
// eligible (e.g. --resume=<id>, --permission-mode=default). bypassPermissions
// is handled by claudeHasNativeOnlyFlagValue before this is consulted.
func claudeIsKnownFlagValueForm(arg string) bool {
	return strings.HasPrefix(arg, "--resume=") ||
		strings.HasPrefix(arg, "--permission-mode=")
}

// PlanClaude inspects the Claude argv and decides whether the launcher
// should inject the Pocketctl Channel (LaunchChannel) or fall back to the
// real binary unchanged (LaunchNative).
//
// Native-only (probe count = 0):
//   - --native escape flag (anywhere; stripped from NativeArgs)
//   - --help / -h / --version / -v
//   - -p / --print, --bare, --safe-mode, --dangerously-skip-permissions,
//     --permission-mode bypassPermissions
//   - auth, login, logout, mcp, plugin, doctor, update, agents subcommands
//
// Channel-eligible:
//   - empty argv (interactive new session)
//   - a bare prompt (non-flag first arg)
//   - --continue
//   - --resume <id>
//
// The plan does NOT decide version/organization/capability gates — those
// happen in ClaudeLauncher.Run after consulting ClaudeChannelProbe. PlanClaude
// only classifies the argv shape so the launcher knows whether to probe at
// all.
func PlanClaude(args []string, cwd string) ClaudeLaunchPlan {
	cwd, _ = filepath.Abs(cwd)

	// 1. --native escape: strip it and pass the rest verbatim. Probe count 0.
	for i, arg := range args {
		if arg == "--" {
			break
		}
		if claudeNativeOnlyFlags[arg] {
			native := append(append([]string(nil), args[:i]...), args[i+1:]...)
			return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: native, Reason: "explicit native mode"}
		}
	}

	// 2. Any native-only flag value (-p, --bare, --safe-mode, ...). Probe 0.
	if claudeHasNativeOnlyFlagValue(args) {
		return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "native-only flag"}
	}

	// 3. help/version anywhere. Probe 0.
	if claudeHasNativeHelpOrVersionFlag(args) {
		return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "help or version"}
	}

	// 4. Native-only subcommand as the first positional. Probe 0.
	if len(args) > 0 && claudeNativeOnlyCommands[args[0]] {
		return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "native-only subcommand"}
	}

	// 5. --continue, --resume <id>, --permission-mode <value> and a single
	// prompt are channel-eligible. We scan left-to-right and track whether a
	// prompt has already appeared so "prompt --resume X" is rejected as
	// ambiguous (the prompt would be the session id, not a new ask).
	plan := ClaudeLaunchPlan{Mode: LaunchChannel, Intent: IntentNew, CWD: cwd}
	sawPrompt := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--continue":
			if sawPrompt {
				return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "prompt combined with session option"}
			}
			plan.Intent = IntentContinue
		case arg == "--resume":
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") && strings.TrimSpace(args[i+1]) != "" {
				if sawPrompt {
					return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "prompt combined with session option"}
				}
				plan.Intent = IntentResume
				plan.SessionID = args[i+1]
				i++
			} else {
				// `claude --resume` without an id opens the picker; treat as native.
				return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "resume picker"}
			}
		case strings.HasPrefix(arg, "--resume="):
			id := strings.TrimPrefix(arg, "--resume=")
			if id == "" {
				return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "empty resume id"}
			}
			if sawPrompt {
				return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "prompt combined with session option"}
			}
			plan.Intent = IntentResume
			plan.SessionID = id
		case arg == "--permission-mode":
			// bypassPermissions was caught above; remaining values are fine.
			if i+1 >= len(args) {
				return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "permission-mode missing value"}
			}
			i++ // consume value
		case claudeIsKnownFlagValueForm(arg):
			// --permission-mode=default etc. already validated as non-bypass.
		case strings.HasPrefix(arg, "-"):
			if !claudeKnownChannelEligibleFlags[arg] {
				// Unknown flag: defer to Claude native to avoid breaking user args.
				return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "unsupported top-level option"}
			}
		default:
			// Positional non-flag arg: a prompt for a new session.
			if plan.Intent != IntentNew {
				return ClaudeLaunchPlan{Mode: LaunchNative, CWD: cwd, NativeArgs: append([]string(nil), args...), Reason: "prompt combined with session option"}
			}
			sawPrompt = true
		}
	}
	plan.ChannelArgs = append([]string(nil), args...)
	if plan.Intent == IntentNew && len(plan.ChannelArgs) == 0 {
		plan.Reason = "interactive new session"
	} else if plan.Reason == "" {
		plan.Reason = "channel-eligible intent"
	}
	return plan
}
