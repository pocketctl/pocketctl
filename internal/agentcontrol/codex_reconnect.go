package agentcontrol

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

var pocketctlCodexSocketName = regexp.MustCompile(`^app-([0-9a-f]{12})-([0-9]+)\.sock$`)
var legacyPocketctlCodexSocketName = regexp.MustCompile(`^app-[0-9]+\.sock$`)

// Copied upstream reconnect commands contain a generation-specific URI. Only
// rewrite our own per-user runtime namespace with a matching account identity.
// Never infer a different CODEX_HOME from a truncated hash or scan other homes.
func planCodexReconnect(args []string, cwd string, env []string) (CodexLaunchPlan, bool, error) {
	index, end := -1, -1
	uri := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if arg == "--native" {
			return CodexLaunchPlan{}, false, nil
		}
		if arg == "--remote" || strings.HasPrefix(arg, "--remote=") {
			if index >= 0 {
				return CodexLaunchPlan{}, false, nil
			}
			index = i
			if arg == "--remote" {
				if i+1 >= len(args) {
					return CodexLaunchPlan{}, false, nil
				}
				i++
				uri = args[i]
			} else {
				uri = strings.TrimPrefix(arg, "--remote=")
			}
			end = i + 1
		}
	}
	if index < 0 || !strings.HasPrefix(uri, "unix:///") {
		return CodexLaunchPlan{}, false, nil
	}
	path := strings.TrimPrefix(uri, "unix://")
	if filepath.Clean(path) != path {
		return CodexLaunchPlan{}, false, nil
	}
	base := os.TempDir()
	if runtime.GOOS == "darwin" {
		base = "/private/tmp"
	}
	dir := filepath.Join(base, fmt.Sprintf("pocketctl-%d", os.Getuid()), "codex")
	for _, entry := range env {
		if strings.HasPrefix(entry, "POCKETCTL_CODEX_RUNTIME_DIR=") && strings.TrimPrefix(entry, "POCKETCTL_CODEX_RUNTIME_DIR=") != "" {
			dir = strings.TrimPrefix(entry, "POCKETCTL_CODEX_RUNTIME_DIR=")
		}
	}
	if !filepath.IsAbs(dir) {
		return CodexLaunchPlan{}, false, nil
	}
	normalize := func(p string) string {
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			return resolved
		}
		return filepath.Clean(p)
	}
	if normalize(filepath.Dir(path)) != normalize(dir) {
		return CodexLaunchPlan{}, false, nil
	}
	stripped := append([]string(nil), args[:index]...)
	stripped = append(stripped, args[end:]...)
	// Preserve explicit remote behavior for commands other than the two
	// reconnect forms printed by Codex itself.
	if len(stripped) == 0 || (stripped[0] != "resume" && stripped[0] != "agents") {
		return CodexLaunchPlan{}, false, nil
	}
	name := filepath.Base(path)
	match := pocketctlCodexSocketName.FindStringSubmatch(name)
	if match == nil {
		if legacyPocketctlCodexSocketName.MatchString(name) {
			return CodexLaunchPlan{}, true, fmt.Errorf("PocketCtl reconnect address has no account identity; use the original CODEX_HOME and run codex resume <session-id> instead")
		}
		return CodexLaunchPlan{}, false, nil
	}
	id, err := CodexHomeIDFromEnvironment(env)
	if err != nil {
		return CodexLaunchPlan{}, true, err
	}
	if !strings.HasPrefix(strings.TrimPrefix(id, "codex-home-"), match[1]) {
		return CodexLaunchPlan{}, true, fmt.Errorf("PocketCtl reconnect address belongs to a different CODEX_HOME; restore the original account environment before reconnecting (no session was opened)")
	}
	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return CodexLaunchPlan{}, true, err
	}
	plan := CodexLaunchPlan{Mode: LaunchManaged, Intent: IntentContinue, CWD: cwd,
		TUIArgs: stripped, Reason: "PocketCtl runtime reconnect"}
	if stripped[0] == "resume" {
		if len(stripped) < 2 || strings.HasPrefix(stripped[1], "-") || strings.TrimSpace(stripped[1]) == "" {
			return CodexLaunchPlan{}, true, fmt.Errorf("PocketCtl reconnect requires an explicit session ID")
		}
		plan.Intent, plan.SessionID = IntentResume, stripped[1]
	}
	return plan, true, nil
}
