package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/api"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/claudechannel"
	"github.com/pocketctl/pocketctl/internal/commands"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/keepawake"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/memorymcp"
	"github.com/pocketctl/pocketctl/internal/notify"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/repositoryidentity"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/sysinfo"
	"github.com/pocketctl/pocketctl/internal/turn"
	"github.com/pocketctl/pocketctl/internal/update"
	"github.com/pocketctl/pocketctl/internal/watcher"
	"github.com/pocketctl/pocketctl/internal/ws"
	"github.com/pocketctl/pocketctl/internal/zcode"
)

var version = "0.4.3"

// PR2 platform defaults for the daemon entry: daemonize + service via platform
// interface (was direct syscall.SysProcAttr{Setsid} + internal/service).
var (
	daemonizer = platform.NewDaemonizer()
	serviceMgr = platform.NewServiceManager()
)

// DefaultRelayURL is the public production relay used when no --relay flag,
// --prod config, or POCKETCTL_RELAY_URL env is provided. To target a local or
// self-hosted relay instead, override with --relay <url> (see `pocketctl help`).
const DefaultRelayURL = "wss://www.pocketctl.me/ws"

func main() {
	if isClaudeLauncherInvocation(os.Args[0], os.Args[1:]) {
		args := claudeLauncherArgs(os.Args[0], os.Args[1:])
		if err := agentcontrol.NewClaudeLauncher().Run(context.Background(), args, ""); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			fmt.Fprintln(os.Stderr, "pocketctl: cannot start Claude:", err)
			os.Exit(1)
		}
		return
	}
	if isCodexLauncherInvocation(os.Args[0], os.Args[1:]) {
		args := codexLauncherArgs(os.Args[0], os.Args[1:])
		if err := agentcontrol.NewCodexLauncher().Run(context.Background(), args, ""); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			fmt.Fprintln(os.Stderr, "pocketctl: cannot start Codex:", err)
			os.Exit(1)
		}
		return
	}
	if isOpenCodeLauncherInvocation(os.Args[0], os.Args[1:]) {
		args := openCodeLauncherArgs(os.Args[0], os.Args[1:])
		if err := agentcontrol.NewLauncher().Run(context.Background(), args, ""); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			fmt.Fprintln(os.Stderr, "pocketctl: cannot start OpenCode:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "agent":
		cmdAgent(os.Args[2:])
	case "daemon":
		cmdDaemon(os.Args[2:])
	case "login":
		cmdLogin(os.Args[2:])
	case "__hook":
		// Hidden subcommand: invoked by Claude's PreToolUse hook (configured by
		// the daemon for non-bypass sessions). Brokers a tool-use approval with
		// the running daemon over a Unix socket, then prints Claude's hook
		// output. Never advertised in help output.
		if err := approval.RunHook(slog.Default()); err != nil {
			os.Exit(0) // exit 0 so Claude renders our deny reason
		}
		os.Exit(0)
	case "__claude_channel":
		// Hidden subcommand: spawned by real Claude from the Pocketctl-owned
		// MCP config when the Channel permission relay is injected. It ferries
		// permission request/verdict notifications between Claude stdio and
		// the daemon's Claude Channel IPC. The process ALWAYS exits 0 so
		// Claude never observes a non-zero status that could be read as a
		// verdict. Never advertised in help output. Design §Task 6.
		if err := claudechannel.RunChannelStdio(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "pocketctl: claude channel exited:", err)
		}
		os.Exit(0)
	case "memory":
		// Explicit Phase 4 repository source sync (ADR-0006): never
		// background capture, never Session-triggered.
		cmdMemory(os.Args[2:])
	case "memory-mcp":
		// Local stdio<->remote MCP bridge for the PocketCtl Memory provider.
		// Grants refresh through the daemon's user-private socket and live
		// only in process memory; diagnostics go to stderr so the hosting
		// agent's stdio framing is never corrupted.
		if err := memorymcp.RunBridgeStdio(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "pocketctl memory-mcp:", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println("pocketctl", version)
	case "uninstall":
		cmdUninstall(os.Args[2:])
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintln(os.Stderr, i18n.T("error.unknown_command", os.Args[1]))
		printUsage()
		os.Exit(1)
	}
}

func isCodexLauncherInvocation(argv0 string, args []string) bool {
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(argv0)), ".exe")
	if name == agentcontrol.AgentCodex {
		return true
	}
	return len(args) >= 2 && args[0] == "__agent-launch" && args[1] == agentcontrol.AgentCodex
}

func codexLauncherArgs(argv0 string, args []string) []string {
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(argv0)), ".exe")
	if name == agentcontrol.AgentCodex {
		return args
	}
	if len(args) >= 2 && args[0] == "__agent-launch" && args[1] == agentcontrol.AgentCodex {
		return args[2:]
	}
	return args
}

func isOpenCodeLauncherInvocation(argv0 string, args []string) bool {
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(argv0)), ".exe")
	if name == agentcontrol.AgentOpenCode {
		return true
	}
	return len(args) >= 2 && args[0] == "__agent-launch" && args[1] == agentcontrol.AgentOpenCode
}

func openCodeLauncherArgs(argv0 string, args []string) []string {
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(argv0)), ".exe")
	if name == agentcontrol.AgentOpenCode {
		return args
	}
	if len(args) >= 2 && args[0] == "__agent-launch" && args[1] == agentcontrol.AgentOpenCode {
		return args[2:]
	}
	return args
}

// isClaudeLauncherInvocation detects a Pocketctl-owned Claude shim call.
// The shim binary name is "claude" (AgentClaudeCLI); the hidden subcommand
// contract uses the canonical agent token "claude-code" (AgentClaudeCode).
// Design §Task 3: "canonical agent type 使用 claude-code,CLI name 使用
// claude,不得把二者混为 shim 文件名".
func isClaudeLauncherInvocation(argv0 string, args []string) bool {
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(argv0)), ".exe")
	if name == agentcontrol.AgentClaudeCLI {
		return true
	}
	return len(args) >= 2 && args[0] == "__agent-launch" && args[1] == agentcontrol.AgentClaudeCode
}

func claudeLauncherArgs(argv0 string, args []string) []string {
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(argv0)), ".exe")
	if name == agentcontrol.AgentClaudeCLI {
		return args
	}
	if len(args) >= 2 && args[0] == "__agent-launch" && args[1] == agentcontrol.AgentClaudeCode {
		return args[2:]
	}
	return args
}

func printUsage() {
	fmt.Println(i18n.T("help.body"))
}

func cmdDaemon(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.usage_sub"))
		os.Exit(1)
	}

	switch args[0] {
	case "start":
		cmdDaemonStart(args[1:])
	case "stop":
		cmdDaemonStop()
	case "status":
		cmdDaemonStatus()
	case "logs":
		cmdDaemonLogs()
	case "doctor":
		cmdDoctor()
	case "update":
		cmdDaemonUpdate(args[1:])
	case "service":
		cmdDaemonService(args[1:])
	case "keep-awake":
		cmdDaemonKeepAwake(args[1:])
	default:
		fmt.Fprintln(os.Stderr, i18n.T("daemon.unknown_sub", args[0]))
		os.Exit(1)
	}
}

// ---------- daemon service (native supervisor) ----------

// cmdDaemonService installs/uninstalls/queries a native OS-supervised service
// (launchd on macOS, systemd --user on Linux) that keeps the daemon running
// across crashes, logout (Linux), and reboot.
func cmdDaemonService(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, i18n.T("service.usage_sub"))
		os.Exit(1)
	}
	switch args[0] {
	case "install":
		cmdServiceInstall(args[1:])
	case "uninstall":
		cmdServiceUninstall()
	case "status":
		cmdServiceStatus()
	default:
		fmt.Fprintln(os.Stderr, i18n.T("service.unknown_sub", args[0]))
		os.Exit(1)
	}
}

func cmdServiceInstall(args []string) {
	fs := flag.NewFlagSet("daemon service install", flag.ExitOnError)
	production := fs.Bool("prod", false, "Bake --prod into the supervised daemon (use production relay from config)")
	relayURL := fs.String("relay", "", "Bake an explicit --relay URL into the supervised daemon")
	trustedActionPolicy := fs.String("trusted-action-policy", "", "Persist trusted approval action policy: off, observe, or on")
	noAgentAutoEnable := fs.Bool("no-agent-auto-enable", false, "Skip optional managed-agent auto-enable")
	noAgentPrompt := fs.Bool("no-agent-prompt", false, "Deprecated alias for --no-agent-auto-enable")
	allowedCwdRoots := multiFlag{}
	fs.Var(&allowedCwdRoots, "allowed-cwd-root", "Absolute directory that remote sessions may use as cwd (repeatable; baked into the service argv)")
	allowDangerousRemotePermissions := fs.Bool("allow-dangerous-remote-permissions", false, "Bake the dangerous remote permission switch into the supervised daemon")
	fs.Parse(args)
	normalizedTrustedActionPolicy, policyErr := validateTrustedActionPolicyFlag(*trustedActionPolicy)
	if policyErr != nil {
		fmt.Fprintln(os.Stderr, policyErr)
		os.Exit(2)
	}
	// Validate + canonicalize roots now so the installed unit never bakes a
	// broken path (and no secret ever lands in argv — roots are paths only).
	policyForService, rootsErr := session.NewCwdPolicy(allowedCwdRoots)
	if rootsErr != nil {
		fmt.Fprintln(os.Stderr, rootsErr)
		os.Exit(2)
	}

	// A token must already be stored — the supervised daemon resolves it from
	// config at launch, exactly like `daemon start`. Fail fast with a clear
	// message rather than installing a unit that will crash-loop on missing auth.
	if tok, err := config.LoadToken(); err != nil || tok == "" {
		fmt.Fprintln(os.Stderr, i18n.T("service.no_token"))
		os.Exit(1)
	}
	maybeAutoEnableAgentsForDaemon(*noAgentAutoEnable || *noAgentPrompt, "")

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("error.executable_path", err))
		os.Exit(1)
	}
	if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
		exe = resolved
	}

	// The supervised process runs in the foreground so the init system owns its
	// lifecycle (no self-fork). Relay flags are baked in so the unit is explicit.
	policyArgs := []string{}
	for _, root := range policyForService.Roots() {
		policyArgs = append(policyArgs, "--allowed-cwd-root", root)
	}
	if *allowDangerousRemotePermissions {
		policyArgs = append(policyArgs, "--allow-dangerous-remote-permissions")
	}
	daemonArgs := serviceDaemonArgs(*production, *relayURL, normalizedTrustedActionPolicy, policyArgs...)

	// Ensure the log dir exists; launchd/systemd open the boot log but won't
	// create its parent directory.
	_ = os.MkdirAll(daemon.LogDir(), 0755)
	cfg := daemonServiceOptions(exe, daemon.ServiceBootLogPath(), daemonArgs, os.Getenv("PATH"))

	// If the daemon is already running standalone, stop it so it doesn't fight
	// the supervised instance for the relay registration / approval socket.
	pid, running, runtimeErr := daemon.RuntimeStatus()
	if runtimeErr != nil {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.status_uncertain", runtimeErr))
		os.Exit(1)
	}
	if running {
		fmt.Println(i18n.T("service.stopping_standalone", pid))
		if err := daemon.Stop(); err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("service.stop_standalone_fail", err))
			os.Exit(1)
		}
	}

	if err := serviceMgr.Install(cfg); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("service.install_fail", err))
		os.Exit(1)
	}
	fmt.Println(i18n.T("service.installed", strings.Join(append([]string{filepath.Base(exe)}, daemonArgs...), " ")))
	info, _ := serviceMgr.Status()
	if info.UnitPath != "" {
		fmt.Println(i18n.T("service.unit_path", info.UnitPath))
	}
	if runtime.GOOS == "linux" {
		fmt.Println(i18n.T("service.linger_note"))
	}
}

func serviceDaemonArgs(production bool, relayURL, trustedActionPolicy string, extraArgs ...string) []string {
	args := []string{"daemon", "start", "--foreground", "--no-agent-auto-enable"}
	if production {
		args = append(args, "--prod")
	}
	if relayURL != "" {
		args = append(args, "--relay", relayURL)
	}
	if trustedActionPolicy != "" {
		args = append(args, "--trusted-action-policy", trustedActionPolicy)
	}
	args = append(args, extraArgs...)
	return args
}

func daemonServiceOptions(exePath, logPath string, daemonArgs []string, pathEnv string) platform.ServiceOpts {
	return platform.ServiceOpts{
		ExePath: exePath,
		Args:    append([]string(nil), daemonArgs...),
		LogPath: logPath,
		PathEnv: pathEnv,
	}
}

func validateTrustedActionPolicyFlag(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "", "off", "observe", "on":
		return normalized, nil
	default:
		return "", fmt.Errorf("--trusted-action-policy must be one of off, observe, or on")
	}
}

func effectiveTrustedActionPolicy(explicit string) string {
	if explicit != "" {
		return explicit
	}
	inherited := strings.ToLower(strings.TrimSpace(os.Getenv("POCKETCTL_TRUSTED_ACTION_POLICY_V1")))
	switch inherited {
	case "observe", "on":
		return inherited
	default:
		return "off"
	}
}

func cmdServiceUninstall() {
	if _, _, err := daemon.RuntimeStatus(); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.status_uncertain", err))
		os.Exit(1)
	}
	if err := serviceMgr.Uninstall(); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("service.uninstall_fail", err))
		os.Exit(1)
	}
	fmt.Println(i18n.T("service.uninstalled"))
}

func cmdServiceStatus() {
	info, err := serviceMgr.Status()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("service.status_fail", err))
		os.Exit(1)
	}
	renderServiceStatus(os.Stdout, info)
}

func renderServiceStatus(out io.Writer, info platform.ServiceStatus) {
	installed := i18n.T("service.no")
	if info.Installed {
		installed = i18n.T("service.yes")
	}
	loaded := i18n.T("service.no")
	if info.Loaded {
		loaded = i18n.T("service.yes")
	}
	running := i18n.T("service.no")
	if info.Running {
		running = i18n.T("service.yes")
	}
	fmt.Fprintln(out, i18n.T("service.status_installed", installed))
	fmt.Fprintln(out, i18n.T("service.status_loaded", loaded))
	fmt.Fprintln(out, i18n.T("service.status_running", running))
	if info.PID > 0 {
		fmt.Fprintln(out, i18n.T("service.status_pid", info.PID))
	}
	if info.LastExitCode != nil {
		fmt.Fprintln(out, i18n.T("service.status_last_exit", *info.LastExitCode))
	}
	if info.UnitPath != "" {
		fmt.Fprintln(out, i18n.T("service.unit_path", info.UnitPath))
	}
	if info.Detail != "" {
		fmt.Fprintln(out, i18n.T("service.status_detail", info.Detail))
	}
	if info.Installed && !info.Loaded {
		fmt.Fprintln(out, i18n.T("service.supervisor_unloaded"))
		fmt.Fprintln(out, i18n.T("service.reinstall_hint"))
	}
}

// ---------- daemon start ----------

// ---------- uninstall ----------

// cmdUninstall removes the pocketctl binary, stops the running daemon, and
// wipes the config/data directories (~/.pocketctl, /tmp/pocketctl). Requires
// explicit --yes to actually delete anything; without it, prints a preview of
// what would be removed and asks for confirmation.
func cmdUninstall(args []string) {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	yes := fs.Bool("yes", false, "Skip confirmation prompt and remove everything immediately")
	keepBinary := fs.Bool("keep-binary", false, "Remove data/config only, keep the pocketctl binary")
	fs.Parse(args)

	// Collect everything that would be removed.
	type removeTarget struct {
		path string
		desc string
	}
	var targets []removeTarget

	home, _ := config.HomeDir()
	if home != "" {
		targets = append(targets, removeTarget{
			filepath.Join(home, ".pocketctl"),
			i18n.T("uninstall.desc_config"),
		})
	}
	if runtime.GOOS != "windows" {
		// Legacy shared runtime dir (pre-H-6): only consider it for removal
		// when it is a real directory owned by the current user and not a
		// symlink. Never auto-remove a directory shared with other users.
		const legacy = "/tmp/pocketctl"
		if _, err := os.Lstat(legacy); err == nil {
			if daemon.OwnedByCurrentUser(legacy) {
				targets = append(targets, removeTarget{legacy, i18n.T("uninstall.desc_runtime")})
			} else {
				fmt.Printf("  • %s (legacy shared dir not owned by you — skipped, review manually)\n", legacy)
			}
		}
	}
	if dir, dirErr := daemon.RuntimeDir(); dirErr == nil {
		targets = append(targets, removeTarget{
			dir,
			i18n.T("uninstall.desc_runtime"),
		})
	} else {
		fmt.Fprintf(os.Stderr, "uninstall: private runtime dir unavailable: %v\n", dirErr)
	}

	// Resolve the binary path.
	exePath, exeErr := os.Executable()
	if exeErr != nil {
		exePath = ""
	}

	fmt.Println(i18n.T("uninstall.title"))
	fmt.Println(i18n.T("doctor.rule"))
	fmt.Println(i18n.T("uninstall.will_remove"))
	for _, t := range targets {
		if _, err := os.Stat(t.path); err == nil {
			fmt.Printf("  • %s (%s)\n", t.path, t.desc)
		}
	}
	if exeErr == nil && !*keepBinary {
		fmt.Printf("  • %s (%s)\n", exePath, i18n.T("uninstall.desc_binary"))
	}
	fmt.Println(i18n.T("uninstall.stop_daemon_note"))
	fmt.Println(i18n.T("doctor.rule"))

	if !*yes {
		fmt.Print(i18n.T("uninstall.confirm"))
		reader := bufio.NewReader(os.Stdin)
		answer, _ := reader.ReadString('\n')
		answer = strings.ToLower(strings.TrimSpace(answer))
		if answer != "y" && answer != "yes" {
			fmt.Println(i18n.T("uninstall.aborted"))
			return
		}
	}

	// 1. Stop the daemon first so it isn't holding the binary / log files.
	pid, running, runtimeErr := daemon.RuntimeStatus()
	if runtimeErr != nil {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.status_uncertain", runtimeErr))
		return
	}
	if running {
		fmt.Println(i18n.T("uninstall.stopping_daemon", pid))
		if err := daemon.Stop(); err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("uninstall.stop_fail", err))
			return
		} else {
			fmt.Println(i18n.T("daemon.stopped"))
		}
	}

	// 2. Remove data/config directories.
	// ~/.pocketctl carries login tokens & machine identity — deleting it is
	// irreversible (must re-login; relay sees a new device). Require a second
	// y/N confirmation (default N = keep) on top of the earlier y/N so the user
	// must explicitly opt in to wiping credentials. --yes skips the FIRST prompt
	// but NOT this one: wiping auth is too costly to bypass non-interactively.
	configDir := ""
	if home != "" {
		configDir = filepath.Join(home, ".pocketctl")
	}
	if configDir != "" {
		if _, err := os.Stat(configDir); err == nil {
			fmt.Println(i18n.T("doctor.rule"))
			fmt.Println(i18n.T("uninstall.config_warning_title"))
			fmt.Println(i18n.T("uninstall.config_warning_body"))
			fmt.Println(i18n.T("doctor.rule"))
			fmt.Print(i18n.T("uninstall.config_confirm"))
			reader := bufio.NewReader(os.Stdin)
			answer, _ := reader.ReadString('\n')
			answer = strings.ToLower(strings.TrimSpace(answer))
			// y/N: default N (keep). Must explicitly type y/yes to delete.
			if answer != "y" && answer != "yes" {
				fmt.Println(i18n.T("uninstall.config_skipped"))
			} else {
				fmt.Println(i18n.T("uninstall.removing", configDir))
				if err := os.RemoveAll(configDir); err != nil {
					fmt.Fprintln(os.Stderr, i18n.T("uninstall.remove_fail", configDir, err))
				}
			}
		}
	}

	// Remaining runtime dirs (e.g. /tmp/pocketctl): safe to remove without the
	// extra warning — just pid/log/lock scratch files, no credentials.
	for _, t := range targets {
		if t.path == configDir {
			continue // already handled above
		}
		if _, err := os.Stat(t.path); err != nil {
			continue
		}
		fmt.Println(i18n.T("uninstall.removing", t.path))
		if err := os.RemoveAll(t.path); err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("uninstall.remove_fail", t.path, err))
		}
	}

	// 3. Remove the binary (self-delete). On Linux this is straightforward; on
	//    macOS the running binary can unlink itself fine too.
	if exeErr == nil && !*keepBinary {
		if _, err := os.Stat(exePath); err == nil {
			fmt.Println(i18n.T("uninstall.removing", exePath))
			if err := os.Remove(exePath); err != nil {
				// Permission errors (e.g. /usr/local/bin) need sudo — tell the user.
				fmt.Fprintln(os.Stderr, i18n.T("uninstall.binary_fail", exePath, err))
				fmt.Println(i18n.T("uninstall.binary_hint", exePath))
			}
		}
	}

	fmt.Println()
	fmt.Println(i18n.T("uninstall.done"))
}

// ---------- login ----------

func cmdLogin(args []string) {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	relayURL := fs.String("relay", "", "Relay WebSocket URL (or POCKETCTL_RELAY_URL env)")
	production := fs.Bool("prod", false, "Use production relay (reads prod_relay_url from config)")
	emailMode := fs.Bool("email", false, "Force email verification code login (for headless servers)")
	fs.Parse(args)

	// Resolve relay URL: --relay > env var > --prod from config > default production
	baseURL := *relayURL
	if baseURL == "" {
		baseURL = os.Getenv("POCKETCTL_RELAY_URL")
	}
	if baseURL == "" && *production {
		if prodURL, err := config.LoadProdRelayURL(); err == nil && prodURL != "" {
			baseURL = prodURL
		} else {
			fmt.Fprintln(os.Stderr, i18n.T("error.prod_requires_url"))
			os.Exit(1)
		}
	}
	if baseURL == "" {
		baseURL = DefaultRelayURL
	}

	// Convert WebSocket URL to HTTP URL for API calls
	apiURL := strings.Replace(baseURL, "wss://", "https://", 1)
	apiURL = strings.Replace(apiURL, "ws://", "http://", 1)
	apiURL = strings.TrimSuffix(apiURL, "/ws")

	// Convert relay base URL to WebSocket URL for storage
	wsURL := strings.Replace(baseURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)
	if !strings.HasSuffix(wsURL, "/ws") {
		wsURL += "/ws"
	}

	fmt.Println(i18n.T("login.title"))
	fmt.Println(i18n.T("login.separator"))

	var accessToken, refreshToken string
	var err error

	// Choose login method
	if *emailMode || !canOpenBrowser() {
		// Headless mode: email verification code
		if *emailMode {
			fmt.Println(i18n.T("login.use_email"))
		} else {
			fmt.Println(i18n.T("login.no_browser"))
		}
		accessToken, refreshToken, err = loginViaEmail(apiURL)
	} else {
		// GUI mode: OAuth 2.0 Device Authorization Grant
		fmt.Println(i18n.T("login.use_oauth"))
		accessToken, refreshToken, err = loginViaDeviceFlow(apiURL)
	}

	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("login.failed", err))
		os.Exit(1)
	}

	// Save to config
	if err := config.SaveAuth(wsURL, accessToken, refreshToken); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("login.save_failed", err))
		os.Exit(1)
	}

	fmt.Println(i18n.T("login.success"))
	fmt.Println(i18n.T("login.token_saved"))
	fmt.Println(i18n.T("login.next_step"))
}

// ValidateExternalURL enforces the M-6 contract for any URL the CLI opens
// or prints from an authentication server response: absolute http(s) only,
// no userinfo, no control characters, bounded length, and plaintext HTTP is
// allowed only for loopback hosts (production surfaces are https).
func ValidateExternalURL(raw string) error {
	const maxURLLen = 2048
	if raw == "" {
		return fmt.Errorf("invalid URL: empty")
	}
	if len(raw) > maxURLLen {
		return fmt.Errorf("invalid URL: exceeds %d characters", maxURLLen)
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < 0x20 || raw[i] == 0x7f {
			return fmt.Errorf("invalid URL: control characters")
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if !u.IsAbs() || u.Host == "" {
		return fmt.Errorf("invalid URL: must be absolute with a host")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("invalid URL: scheme %q is not allowed", u.Scheme)
	}
	if u.User != nil {
		return fmt.Errorf("invalid URL: userinfo is not allowed")
	}
	if u.Scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return fmt.Errorf("invalid URL: plaintext http is only allowed for loopback hosts")
	}
	return nil
}

func isLoopbackHost(hostname string) bool {
	host := strings.ToLower(hostname)
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// WSLBrowserArgs builds the direct-argv opener for a WSL environment: the
// opener binary plus the URL as its own argument. No cmd.exe /c, no shell.
func WSLBrowserArgs(opener string, rawURL string) []string {
	switch {
	case strings.HasSuffix(opener, "rundll32.exe"):
		return []string{opener, "url.dll,FileProtocolHandler", rawURL}
	default:
		// wslview and explorer.exe take the URL as the single argument.
		return []string{opener, rawURL}
	}
}

// canOpenBrowser checks if the current environment can open a browser.
func canOpenBrowser() bool {
	if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
		return true
	}
	if runtime.GOOS == "darwin" && os.Getenv("SSH_TTY") == "" {
		return true
	}
	// WSL: wslview or a direct Windows opener hands off to the host browser.
	if runtime.GOOS == "linux" && isWSL() {
		for _, candidate := range []string{"wslview", "rundll32.exe", "explorer.exe"} {
			if _, err := exec.LookPath(candidate); err == nil {
				return true
			}
		}
	}
	if _, err := exec.LookPath("open"); err == nil {
		return true
	}
	if _, err := exec.LookPath("xdg-open"); err == nil {
		return true
	}
	if _, err := exec.LookPath("wslview"); err == nil {
		return true
	}
	return false
}

// isWSL delegates to daemon.IsWSL (shared implementation).
func isWSL() bool { return daemon.IsWSL() }

// loginViaDeviceFlow performs OAuth 2.0 Device Authorization Grant login.
func loginViaDeviceFlow(apiURL string) (string, string, error) {
	// Generate PKCE code verifier and challenge
	codeVerifier, err := api.GenerateCodeVerifier()
	if err != nil {
		return "", "", fmt.Errorf("%s", i18n.T("login.pkce_failed", err))
	}
	codeChallenge := api.ComputeCodeChallenge(codeVerifier)

	// Get machine ID
	machineID := daemon.MachineID()

	// Request device authorization
	fmt.Print(i18n.T("login.requesting_auth"))
	authResp, err := api.DeviceAuthorize(apiURL, "pocketctl-cli", codeChallenge, machineID)
	if err != nil {
		return "", "", fmt.Errorf("%s", i18n.T("login.auth_req_failed", err))
	}
	fmt.Println(i18n.T("login.check_ok"))

	// Open browser. M-6: the authorization server's URL is validated before
	// it is printed or handed to an opener; on rejection only a safe error is
	// shown — the hostile URL itself is never echoed.
	fmt.Println(i18n.T("login.opening_browser"))
	fmt.Println(i18n.T("login.manual_open"))
	if err := ValidateExternalURL(authResp.VerificationURIComplete); err != nil {
		fmt.Fprintf(os.Stderr, "warning: %v — open the login page manually from your relay's web app\n", err)
	} else {
		fmt.Printf("  %s\n\n", authResp.VerificationURIComplete)
		if err := openBrowser(authResp.VerificationURIComplete); err != nil {
			fmt.Fprintf(os.Stderr, "warning: %v\n", err)
		}
	}

	// Poll for token
	interval := authResp.Interval
	if interval < 5 {
		interval = 5
	}

	fmt.Print(i18n.T("login.waiting"))
	startTime := time.Now()
	for {
		select {
		case <-time.After(time.Duration(interval) * time.Second):
			elapsed := int(time.Since(startTime).Seconds())
			fmt.Printf(i18n.T("login.waiting_auth"), elapsed)

			result, err := api.DeviceToken(apiURL, authResp.DeviceCode, "pocketctl-cli", codeVerifier)
			if err != nil {
				continue // network error, retry
			}

			switch result.Error {
			case "":
				if result.AccessToken != "" {
					fmt.Println(i18n.T("login.auth_ok"))
					return result.AccessToken, result.RefreshToken, nil
				}
			case "authorization_pending":
				continue
			case "slow_down":
				interval += 5
				continue
			case "expired_token":
				return "", "", fmt.Errorf("%s", i18n.T("login.auth_timeout"))
			default:
				return "", "", fmt.Errorf("%s", i18n.T("login.auth_failed", result.Error))
			}

			if elapsed > authResp.ExpiresIn {
				return "", "", fmt.Errorf("%s", i18n.T("login.auth_timeout"))
			}
		}
	}
}

// openBrowser opens the given URL in the default browser. The URL is
// validated first (M-6) and every platform path passes it as a direct argv
// element — no command interpreter is ever involved.
func openBrowser(rawURL string) error {
	if err := ValidateExternalURL(rawURL); err != nil {
		return fmt.Errorf("%w (refusing to open)", err)
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", rawURL)
	case "linux":
		// WSL: wslview first, then direct Windows openers. Never cmd.exe /c.
		if isWSL() {
			for _, candidate := range []string{"wslview", "rundll32.exe", "explorer.exe"} {
				if p, err := exec.LookPath(candidate); err == nil {
					args := WSLBrowserArgs(p, rawURL)
					cmd = exec.Command(args[0], args[1:]...)
					break
				}
			}
			if cmd == nil {
				return fmt.Errorf("no WSL browser opener found (install wslu for wslview)")
			}
			break
		}
		cmd = exec.Command("xdg-open", rawURL)
	default:
		return fmt.Errorf("unsupported platform for browser opening")
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to open browser: %w", err)
	}
	return nil
}

func loginViaEmail(apiURL string) (string, string, error) {
	fmt.Print(i18n.T("login.email_prompt"))
	var email string
	fmt.Scanln(&email)

	email = strings.TrimSpace(email)
	if !strings.Contains(email, "@") {
		return "", "", fmt.Errorf("%s", i18n.T("login.invalid_email"))
	}

	fmt.Print(i18n.T("login.sending_code"))
	if err := api.SendEmailCode(apiURL, email, i18n.CurrentCode()); err != nil {
		return "", "", fmt.Errorf("%s", i18n.T("login.send_failed", err))
	}
	fmt.Println(i18n.T("login.code_sent"))

	fmt.Print(i18n.T("login.code_prompt"))
	var code string
	fmt.Scanln(&code)

	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return "", "", fmt.Errorf("%s", i18n.T("login.invalid_code"))
	}

	fmt.Print(i18n.T("login.verifying"))
	return api.VerifyEmailCode(apiURL, email, code, i18n.CurrentCode(), daemon.MachineID())
}

// ---------- daemon start (continued) ----------

// startSpinner renders an animated braille spinner with the given message to
// stdout and returns a stop function that halts the animation and clears the
// line. On a non-interactive stdout (piped / redirected) it prints the message
// once and animates nothing, so captured output stays free of escape codes.
func startSpinner(msg string) (stop func()) {
	isTTY := false
	if fi, err := os.Stdout.Stat(); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
		isTTY = true
	}
	if !isTTY {
		fmt.Println(msg)
		return func() {}
	}

	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		frames := []rune{'⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'}
		ticker := time.NewTicker(90 * time.Millisecond)
		defer ticker.Stop()
		for i := 0; ; i++ {
			select {
			case <-done:
				return
			case <-ticker.C:
				fmt.Printf("\r\033[36m%c\033[0m %s", frames[i%len(frames)], msg)
			}
		}
	}()
	return func() {
		close(done)
		<-finished
		fmt.Print("\r\033[K") // carriage return + erase to end of line
	}
}

// pruneOrphanSpools deletes spool files in spoolDir that don't belong to the
// current daemon ID. The active spool is "<id>.log" (plus a transient
// "<id>.log.tmp" during a rewrite); anything else is from a prior daemon whose
// ID drifted (hostname/MAC change) and is never reclaimed otherwise. Best-effort:
// removal errors are logged at debug and ignored.
func pruneOrphanSpools(spoolDir, id string, logger *slog.Logger) {
	entries, err := os.ReadDir(spoolDir)
	if err != nil {
		return
	}
	keep := id + ".log"
	keepTmp := keep + ".tmp"
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if name == keep || name == keepTmp {
			continue
		}
		if !strings.HasSuffix(name, ".log") && !strings.HasSuffix(name, ".log.tmp") {
			continue // don't touch unrelated files
		}
		if err := os.Remove(filepath.Join(spoolDir, name)); err != nil {
			logger.Debug("prune orphan spool failed", "file", name, "error", err)
		} else {
			logger.Info("pruned orphan spool", "file", name)
		}
	}
}

func cmdDaemonStart(args []string) {
	fs := flag.NewFlagSet("daemon start", flag.ExitOnError)
	relayURL := fs.String("relay", "", "Relay WebSocket URL (or POCKETCTL_RELAY_URL env)")
	production := fs.Bool("prod", false, "Use production relay (reads prod_relay_url from config)")
	token := fs.String("token", "", "JWT token (or POCKETCTL_TOKEN env)")
	daemonID := fs.String("id", "", "Daemon ID (auto-generated if empty)")
	foreground := fs.Bool("foreground", false, "Run in foreground (don't daemonize)")
	debug := fs.Bool("debug", false, "Verbose debug logging; with --foreground also streams logs to the console")
	trustedActionPolicy := fs.String("trusted-action-policy", "", "Trusted approval action policy: off, observe, or on")
	noAgentAutoEnable := fs.Bool("no-agent-auto-enable", false, "Skip optional managed-agent auto-enable")
	noAgentPrompt := fs.Bool("no-agent-prompt", false, "Deprecated alias for --no-agent-auto-enable")
	allowedCwdRoots := multiFlag{}
	fs.Var(&allowedCwdRoots, "allowed-cwd-root", "Absolute directory that remote sessions may use as cwd (repeatable; required for remote session creation)")
	allowDangerousRemotePermissions := fs.Bool("allow-dangerous-remote-permissions", false, "Allow remote sessions to request bypassPermissions / dangerous bypass / approval never / danger-full-access")
	fs.Parse(args)
	cwdPolicy, cwdPolicyErr := session.NewCwdPolicy(allowedCwdRoots)
	if cwdPolicyErr != nil {
		fmt.Fprintln(os.Stderr, cwdPolicyErr)
		os.Exit(2)
	}
	fmt.Printf("[daemon] remote cwd policy: %d allowed root(s); dangerous remote permissions=%v\n", len(cwdPolicy.Roots()), *allowDangerousRemotePermissions)
	normalizedTrustedActionPolicy, policyErr := validateTrustedActionPolicyFlag(*trustedActionPolicy)
	if policyErr != nil {
		fmt.Fprintln(os.Stderr, policyErr)
		os.Exit(2)
	}
	effectiveTrustedActionPolicyValue := effectiveTrustedActionPolicy(normalizedTrustedActionPolicy)

	// --debug also implies running in the foreground so the operator sees logs
	// live on the console (the whole point of debug mode is interactive
	// troubleshooting). It still writes the full debug log to daemon.log.
	if *debug {
		*foreground = true
	}

	// Resolve relay URL: --relay > env var > --prod from config > default production
	url := *relayURL
	if url == "" {
		url = os.Getenv("POCKETCTL_RELAY_URL")
	}
	if url == "" && *production {
		if prodURL, err := config.LoadProdRelayURL(); err == nil && prodURL != "" {
			url = prodURL
		} else {
			fmt.Fprintln(os.Stderr, i18n.T("error.prod_requires_url"))
			os.Exit(1)
		}
	}
	if url == "" {
		url = DefaultRelayURL
	}

	// Resolve token
	tok := *token
	if tok == "" {
		tok = os.Getenv("POCKETCTL_TOKEN")
	}
	if tok == "" {
		// Try stored config
		if stored, err := config.LoadToken(); err == nil && stored != "" {
			tok = stored
		}
	}
	if tok == "" {
		fmt.Fprintln(os.Stderr, i18n.T("error.token_required"))
		os.Exit(1)
	}
	// Persist the identity that this daemon starts with. Status must not consult
	// auth.json later: a subsequent `pocketctl login` may replace those tokens
	// while this daemon is still connected as the original account.
	accountEmail, _ := api.ParseJWTEmail(tok)

	restartReadyFile := consumeRestartReadyEnv()
	observedIntent, observedIntentExists, intentErr := daemon.ObserveStopIntent()
	if intentErr != nil {
		fmt.Fprintln(os.Stderr, intentErr)
		os.Exit(1)
	}
	if restartReadyFile != "" {
		if observedIntentExists {
			os.Exit(0)
		}
	}
	// A replacement deliberately starts while the old owner is alive. It must
	// bypass only this racy PID pre-check; the instance lock remains authoritative.
	pid, running, runtimeErr := daemon.RuntimeStatus()
	if runtimeErr != nil {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.status_uncertain", runtimeErr))
		os.Exit(1)
	}
	if running && restartReadyFile == "" && !observedIntentExists {
		fmt.Println(i18n.T("daemon.already_running", pid))
		os.Exit(0)
	}

	agentSetupSkipped := *noAgentAutoEnable || *noAgentPrompt
	agentAutoEnable := maybeAutoEnableAgentsForDaemon(agentSetupSkipped, restartReadyFile)

	// Determine daemon ID before forking so the launcher can print it and pass
	// it to the child. This avoids the child re-deriving an ID that might differ
	// if machine sources (hostname/MAC) changed since the last run.
	preForkID := *daemonID
	if preForkID == "" {
		if existing, err := daemon.ReadState(); err == nil && existing.DaemonID != "" {
			preForkID = existing.DaemonID
		}
		if preForkID == "" {
			preForkID = daemon.MachineID()
		}
	}

	// Daemonize: fork into the background BEFORE any initialization. Doing this
	// early prevents the launcher process from transiently opening the approval
	// socket, connecting to the relay, registering, then being torn down by
	// os.Exit (which skips defers) — a sequence that orphaned resources and
	// raced the real child's relay registration (stale 'close' evicted the
	// fresh connection, marking the host permanently offline). Only the child
	// (or a --foreground run) performs the work below.
	if !*foreground && os.Getenv("POCKETCTL_DAEMON_CHILD") != "1" {
		childEnv := append(os.Environ(), "POCKETCTL_DAEMON_CHILD=1", "POCKETCTL_DAEMON_ID="+preForkID)
		exe, err := os.Executable()
		if err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("error.executable_path", err))
			os.Exit(1)
		}
		// PR2: daemonize fork via platform.Daemonizer (was direct exec.Cmd + SysProcAttr{Setsid}).
		proc, err := daemonizer.ForkDetached(exe, os.Args[1:], childEnv)
		if err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("error.daemonize", err))
			os.Exit(1)
		}

		// Show a startup animation while the detached child boots. The child
		// writes its PID file early and flips state.Connected=true once the relay
		// handshake succeeds, so poll both: the spinner stops the moment the relay
		// is connected, and the banner reflects real status instead of an
		// optimistic "started" printed before anything actually came up.
		stop := startSpinner(i18n.T("daemon.starting"))
		var running, connected bool
		var startupUncertainty error
		deadline := time.Now().Add(12 * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(200 * time.Millisecond)
			runningNow, connectedNow, observationErr := observeDetachedDaemonStartup(
				daemon.RuntimeStatus,
				daemon.ReadState,
				daemon.VerifyRuntimeIdentity,
			)
			if observationErr != nil {
				startupUncertainty = observationErr
				continue
			}
			if !runningNow {
				continue
			}
			running = true
			startupUncertainty = nil
			if connectedNow {
				connected = true
				break
			}
		}
		stop()

		// Print the startup banner from the launcher (the child's stdout is nil /
		// detached, so only the launcher can write to the user's terminal).
		if !running || startupUncertainty != nil {
			renderDetachedDaemonStartupFailure(
				os.Stdout,
				daemon.LogPath(),
				startupUncertainty,
			)
			os.Exit(1)
		}
		fmt.Println(i18n.T("daemon.started", preForkID, proc.Pid))
		fmt.Println(i18n.T("daemon.version", version))
		if connected {
			fmt.Println(i18n.T("daemon.relay_connected", url))
		} else {
			fmt.Println(i18n.T("daemon.relay_connecting", url))
		}
		printDaemonAgentStartupStatus(os.Stdout, agentAutoEnable, agentSetupSkipped)
		fmt.Println(i18n.T("daemon.logs", daemon.LogPath()))
		os.Exit(0)
	}

	// Generate daemon ID — prefer the value passed by the launcher via env (set
	// above) so both processes always use the same ID without re-deriving.

	// Acquire a single-instance flock as the race-free guard (this is the child
	// or --foreground process — the launcher has already exited). IsRunning above
	// is a fast pre-check, but it can't tell two simultaneous starts apart; this
	// lock can. Without it, a second daemon could start, load a stale token, and
	// become an invalid-token zombie when the token later rotates.
	var instanceLock io.Closer
	var err error
	if restartReadyFile != "" {
		instanceLock, err = waitForRestartOwnership(restartReadyFile, 20*time.Second, daemon.AcquireInstanceLock)
		if err == nil {
			instanceLock, err = finalizeRestartOwnership(instanceLock)
		}
	} else {
		instanceLock, err = daemon.AcquireInstanceLock()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.lock_held"))
		os.Exit(1)
	}
	defer instanceLock.Close()
	// Only the process that owns the singleton lock may publish the effective
	// restart policy. A failed or concurrent start therefore cannot overwrite
	// the policy of the daemon that is actually running.
	if err := persistDaemonSecurityPolicy(
		cwdPolicy,
		*allowDangerousRemotePermissions,
		effectiveTrustedActionPolicyValue,
	); err != nil {
		fmt.Fprintln(os.Stderr, "persist daemon security policy:", err)
		os.Exit(1)
	}
	runtimeInstanceToken, err := daemon.CurrentInstanceToken()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.status_uncertain", err))
		os.Exit(1)
	}

	id := *daemonID
	if id == "" {
		if envID := os.Getenv("POCKETCTL_DAEMON_ID"); envID != "" {
			id = envID
		} else if existing, err := daemon.ReadState(); err == nil && existing.DaemonID != "" {
			id = existing.DaemonID
		}
		if id == "" {
			id = daemon.MachineID()
		}
	}

	daemonStartedAt := time.Now()
	initialState := daemon.DaemonState{
		DaemonID:             id,
		RuntimeInstanceToken: runtimeInstanceToken,
		Version:              version,
		RelayURL:             url,
		AccountEmail:         accountEmail,
		ConnectionStatus:     string(ws.ConnectionReconnecting),
		UpdatedAt:            daemonStartedAt.UTC(),
		StartedAt:            daemonStartedAt,
		PID:                  os.Getpid(),
		EventWindow:          -1,
		UnackedEvents:        -1,
	}
	// Persist daemon_id immediately so the next start always reads the same ID,
	// even if the process is killed before the relay connection callback fires.
	var statePersistence *daemonStatePersistence
	if err := persistInitialDaemonStateAndContinue(
		initialState,
		daemon.WriteState,
		func() {
			_ = instanceLock.Close()
		},
		func(persistence *daemonStatePersistence) {
			statePersistence = persistence
		},
	); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.initial_state_fail", err))
		os.Exit(1)
	}

	// Setup logging: a date-rotating writer under ~/.pocketctl/logs so logs are
	// split by day (daemon-YYYY-MM-DD.log) for easier troubleshooting. The
	// writer switches files automatically when the calendar date changes, and
	// always appends (each day's file is naturally bounded; restarts within a
	// day accumulate rather than truncate).
	logWriter, err := daemon.NewRotatingLogWriter(daemon.LogDir(), daemon.LogPrefix())
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("error.create_log_dir", daemon.LogDir(), err))
		os.Exit(1)
	}
	defer logWriter.Close()

	// In normal mode, mirror stderr (and stdout) to the current daemon log file.
	// The daemonized child runs with stdin/stdout/stderr = nil (→ /dev/null), so
	// Go's runtime panic stack traces — which it prints via the raw fd 2 syscall,
	// bypassing os.Stderr — would otherwise be silently discarded. Redirecting
	// fd 1/2 to the log file at the OS level (dup2) ensures any panic not caught
	// by our recover handlers lands in the log instead of vanishing. Note: the
	// dup targets the file open at startup, so a runtime panic after a midnight
	// rotation lands in the start-day file; slog records (incl. our recover
	// handlers) always follow the rotation since they go through logWriter.
	//
	// In --debug mode we DON'T redirect: the run is foreground and interactive,
	// so we keep the operator's real terminal on fd 1/2 (panic traces + the
	// streamed console logs below land on screen where they're being watched).
	if !*debug {
		if f := logWriter.File(); f != nil {
			dupFileToFd(f, 1)
			dupFileToFd(f, 2)
		}
	}

	// --debug lowers the log level to Debug and, because it's foreground, also
	// streams every record to the console in human-readable text — while still
	// writing the full structured JSON to the dated log file for later inspection.
	logLevel := slog.LevelInfo
	if *debug {
		logLevel = slog.LevelDebug
	}
	var handler slog.Handler = slog.NewJSONHandler(logWriter, &slog.HandlerOptions{Level: logLevel})
	if *debug {
		console := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel})
		handler = fanoutHandler{handlers: []slog.Handler{handler, console}}
	}
	logger := slog.New(handler)
	slog.SetDefault(logger) // so packages using slog.Default() (e.g. opencode coordinator) log to the daemon log
	if *debug {
		fmt.Fprintln(os.Stderr, i18n.T("daemon.debug_banner", logWriter.CurrentPath()))
	}
	logger.Info("starting daemon", "version", version, "id", id, "relay", url, "debug", *debug)
	// Write PID file
	var observedIntentPtr *daemon.StopIntent
	if observedIntentExists {
		observedIntentPtr = &observedIntent
	}
	if err := daemon.PublishDaemonPID(os.Getpid(), restartReadyFile != "", observedIntentPtr); err != nil {
		logger.Error("write pid", "error", err)
		os.Exit(1)
	}
	defer os.Remove(daemon.PIDPath())

	// Lower our OOM score (Linux) so the kernel OOM killer disfavors the daemon
	// relative to its PTY children under memory pressure. No-op elsewhere.
	_ = daemon.ProtectFromOOM(logger)

	// Discover agents
	agents := discovery.DiscoverAgents()
	agentTypes := make([]string, 0, len(agents))
	agentVersions := make(map[string]string)
	agentLatests := make(map[string]string)
	agentManageable := make(map[string]bool)
	for _, a := range agents {
		agentTypes = append(agentTypes, a.Type)
		if a.Version != "" {
			agentVersions[a.Type] = a.Version
		}
		if a.Latest != "" {
			agentLatests[a.Type] = a.Latest
		}
		agentManageable[a.Type] = a.Manageable
		logger.Info("discovered agent", "type", a.Type, "path", a.Path, "version", a.Version, "latest", a.Latest)
	}
	if len(agentTypes) == 0 {
		logger.Warn("no coding agent discovered; clients will be prompted to install one")
	}

	// Create shared event channel
	outputCh := make(chan protocol.DaemonEvent, 256)

	// Create session manager
	sm := session.NewSessionManagerWithTrustedActionPolicy(outputCh, effectiveTrustedActionPolicyValue)
	// Turn lifecycle journal (stage 2): persists only active-turn identity
	// (no content). Corruption is logged and startup continues (fail-open).
	if journalDir, err := config.ConfigDir(); err == nil {
		if jerr := sm.EnableTurnJournal(filepath.Join(journalDir, "turn-state-v1.json")); jerr != nil {
			logger.Warn("turn state journal corrupt; continuing without restore", "error", jerr)
		}
	}
	// Post-restore reconciliation (review P1-6): once session discovery has
	// settled, restored turns whose sessions are no longer observably running
	// terminalize as abandoned instead of swallowing the next input as an
	// addendum of a turn that died while the daemon was down.
	time.AfterFunc(30*time.Second, sm.ReconcileRestoredTurns)
	// H-7: remote session cwd and dangerous-permission gates are configured by
	// the local operator only; relay clients cannot extend them.
	sm.SetCwdPolicy(cwdPolicy)
	sm.SetRemotePermissionPolicy(adapter.RemotePermissionPolicy{AllowDangerous: *allowDangerousRemotePermissions})

	// ZCode read-only observer (only when the user has explicitly enabled the
	// sync). It is fully isolated from the SessionManager: it never enters
	// ActiveRootSessionIDs, never drives a session, and emits only through the
	// low-priority gate below so ZCode congestion never starves the other
	// agents. See docs/adr/0001-zcode-independent-read-only-observer.md.
	outputCap := cap(outputCh)
	tryEmitLowPriority := func(ev protocol.DaemonEvent) bool {
		// Low-watermark gate: only send when the shared channel is at/below 25%
		// capacity, using a non-blocking send. Rejection keeps the observer's
		// pending state intact (it retries the same stable event later).
		if len(outputCh) > outputCap/4 {
			return false
		}
		select {
		case outputCh <- ev:
			return true
		default:
			return false
		}
	}
	var zcodeObserver *zcode.Observer
	if zcCfg, err := zcode.LoadConfig(); err == nil && zcCfg.Enabled {
		storage := zcode.ResolveStorageDir(zcCfg)
		// emitDirect bypasses the low-watermark gate for critical metadata events
		// (session_status). These are tiny (1 event) and directly affect the
		// user-visible running/completed state — they must not be starved by
		// content backfill backpressure. Still non-blocking (never hangs).
		emitDirect := func(ev protocol.DaemonEvent) bool {
			select {
			case outputCh <- ev:
				return true
			default:
				return false
			}
		}
		zcodeObserver = zcode.NewObserver(zcode.ObserverConfig{
			SourceID:     zcCfg.SourceID,
			StorageDir:   storage,
			History:      zcCfg.History,
			LookbackDays: zcCfg.LookbackDays,
			Emit:         tryEmitLowPriority,
			EmitDirect:   emitDirect,
			Logger:       logger,
		})
		// Start is deferred until the daemon ctx exists (see below).
	}
	var recoveredClaudeApprovalMu sync.Mutex
	var recoveredClaudeApprovals []daemon.ClaudeApprovalStateItem
	if previous, readErr := daemon.ReadClaudeApprovalState(); readErr == nil {
		recoveredClaudeApprovals = append(recoveredClaudeApprovals, previous.Requests...)
	} else if !os.IsNotExist(readErr) {
		// Corrupt or insecure state is never made actionable. Leave a
		// diagnostic and continue daemon startup.
		logger.Warn("Claude approval state unavailable", "error", readErr)
	}
	sm.SetClaudeApprovalRecorder(func(references []session.ClaudeApprovalReference) error {
		recoveredClaudeApprovalMu.Lock()
		defer recoveredClaudeApprovalMu.Unlock()
		requests := make([]daemon.ClaudeApprovalStateItem, 0, len(recoveredClaudeApprovals)+len(references))
		requests = append(requests, recoveredClaudeApprovals...)
		for _, reference := range references {
			requests = append(requests, daemon.ClaudeApprovalStateItem{
				SessionID: reference.SessionID,
				RequestID: reference.RequestID,
				CreatedAt: reference.CreatedAt,
			})
		}
		return daemon.WriteClaudeApprovalState(daemon.ClaudeApprovalState{
			DaemonID: id,
			Requests: requests,
		})
	})
	sm.SetOpenCodeRuntimeHealthRecorder(func(healthy bool) {
		_ = agentcontrol.RecordOpenCodeRuntimeHealth(healthy)
	})
	sm.SetClaudeTelemetryRecorder(func(metric, reason string) {
		switch metric {
		case "finish":
			_ = agentcontrol.RecordClaudeApprovalFinish(reason)
		case "resolved_elsewhere":
			_ = agentcontrol.RecordClaudeResolvedElsewhere()
		}
	})

	// Start the local Agent Control endpoint before any relay connection loop.
	// A terminal launcher can therefore acquire the shared OpenCode runtime even
	// while the relay is offline; remote synchronization catches up separately.
	agentControlServer := agentcontrol.NewServer(config.AgentControlSocketPath(), daemonRuntimeProviders(sm))
	if err := agentControlServer.Start(); err != nil {
		logger.Warn("agent control server disabled", "error", err)
	} else {
		logger.Info("agent control server listening", "path", config.AgentControlSocketPath())
		defer agentControlServer.Close()
	}
	// Claude Channels use a dedicated permission-only IPC endpoint. Failure is
	// non-fatal and leaves every terminal invocation on native Claude approval.
	claudeChannelServer, channelErr := startClaudeChannelIPC(logger, sm)
	if channelErr != nil {
		logger.Warn("Claude Channel IPC disabled", "error", channelErr)
	} else {
		logger.Info("Claude Channel IPC listening", "path", config.ClaudeChannelSocketPath())
		defer claudeChannelServer.Close()
	}
	// If a previous daemon relinquished a live Codex app-server because an
	// official TUI still held a lease, adopt it immediately and resume the
	// persisted managed threads. With no handoff this is a no-op and Codex stays
	// lazy until the next acquire/session start.
	daemon.Go("codex-runtime-recover", logger, func() {
		recoverCtx, recoverCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer recoverCancel()
		if err := sm.CodexRuntimeProvider().Recover(recoverCtx); err != nil {
			logger.Warn("Codex app-server recovery unavailable", "error", err)
		}
	})

	// Start the legacy in-process approval broker for daemon-owned Claude PTYs.
	// Their project-scoped PreToolUse hook connects here. External terminal
	// sessions use the official Channel path and never depend on this broker or
	// on a global ~/.claude/settings.json hook. Failures are non-fatal.
	approvalSocket := config.ApprovalSocketPath()
	pocketctlPath, _ := os.Executable()
	if pocketctlPath == "" {
		pocketctlPath = os.Args[0]
	}
	if approvalSocket != "" {
		approvalSrv := approval.NewServer(approvalSocket, logger)
		if err := approvalSrv.Start(); err != nil {
			logger.Warn("approval server disabled", "error", err)
		} else {
			sm.SetApprovalServer(approvalSrv, pocketctlPath)
			defer approvalSrv.Close()

			// External terminal Claude sessions use the official Channel path.
			// Keep this broker only for daemon-owned PTYs, whose project-scoped
			// hooks are installed by SessionManager lifecycle code.
		}
	}

	// When a daemon-created session resolves its real ID, wait for assistant
	// reply then send generate_title_request to relay for LLM-based title generation.
	sm.OnSessionIDResolved = func(realSessionID, cwd, agent string) {
		daemon.Go("title-resolve", logger, func() {
			for i := 0; i < 30; i++ {
				time.Sleep(1 * time.Second)
				jsonlPath, err := adapter.ResolveJSONLPathFor(agent, realSessionID, cwd)
				if err != nil {
					continue
				}
				if _, err := os.Stat(jsonlPath); err != nil {
					continue // file not created yet
				}
				// Read lines looking for both user and assistant messages
				lines := readJSONLLines(jsonlPath, 500)
				userMsg := adapter.ExtractFirstUserMessageFor(lines, 200, agent)
				assistantMsg := adapter.ExtractFirstAssistantMessageFor(lines, 200, agent)
				if userMsg != "" && assistantMsg != "" {
					sm.GenerateTitle(realSessionID, userMsg, assistantMsg)
					return
				}
			}
		})
	}

	// Create session watcher
	sw, err := watcher.NewSessionWatcher()
	if err != nil {
		logger.Error("create session watcher", "error", err)
		os.Exit(1)
	}
	defer sw.Close()

	// Create process monitor
	pm := watcher.NewProcessMonitor()

	// Create WebSocket client
	client := ws.NewClient(url, tok, id, agentTypes, agentVersions, agentLatests, outputCh, logger)
	memoryContextGrants := wireMemoryContext(sm, client)
	client.OnControlMessage = sm.DispatchMemoryContextControl
	client.SetAgentManageable(agentManageable)
	client.SetVersion(version)
	client.SetStartedAt(time.Now().Unix())
	var codexReplayCursor *watcher.CodexReplayCursorStore
	if cfgDir, cfgErr := config.ConfigDir(); cfgErr == nil {
		cursorPath := filepath.Join(cfgDir, "codex-replay-cursors.json")
		if cursor, cursorErr := watcher.NewCodexReplayCursorStore(cursorPath); cursorErr != nil {
			logger.Warn("Codex replay cursor disabled", "error", cursorErr)
		} else {
			codexReplayCursor = cursor
		}
	}
	// Optional TLS certificate pinning: when POCKETCTL_RELAY_PIN is set
	// (base64 SHA-256 of the relay cert's SPKI), the daemon pins the relay's
	// public key so a MITM with a trusted-but-malicious cert is rejected.
	if pin := os.Getenv("POCKETCTL_RELAY_PIN"); pin != "" {
		client.SetRelayPin(pin)
		logger.Info("relay certificate pinning enabled")
	}

	// Auto-refresh the access token when the relay rejects it with 4001. Without
	// this, a daemon whose 24h access token has simply expired would go permanently
	// offline and spam the relay with invalid-token reconnects — and a remote user
	// can't reach the machine to `pocketctl login`. The 7d refresh token lets the
	// daemon self-heal; only when the refresh token itself is dead does the daemon
	// park and ask the user to re-login.
	client.OnTokenRefresh = func() (string, bool) {
		relayURL, _, refreshToken, err := config.LoadAuth()
		if err != nil || refreshToken == "" {
			logger.Error("token refresh: no stored refresh token", "error", err)
			return "", false
		}
		baseURL := strings.TrimSuffix(relayURL, "/ws")
		baseURL = strings.TrimSuffix(baseURL, "/")
		baseURL = strings.Replace(baseURL, "wss://", "https://", 1)
		baseURL = strings.Replace(baseURL, "ws://", "http://", 1)
		newAccess, newRefresh, err := api.RefreshToken(baseURL, refreshToken, daemon.MachineID())
		if err != nil {
			logger.Error("token refresh failed; refresh token may be expired", "error", err)
			return "", false
		}
		// Persist the new tokens with retries. This MUST NOT be swallowed: the
		// relay has already rotated the old refresh token, so if we don't
		// durably save the new one the next refresh reuses the rotated one and
		// gets judged a breach (the m3-pro incident). Only report success once
		// persisted; otherwise abort so the daemon doesn't act on a half-applied
		// refresh (it'll retry on the next 4001, and park if refresh stays broken).
		var saveErr error
		for attempt := 0; attempt < 3; attempt++ {
			if saveErr = config.SaveAuth(relayURL, newAccess, newRefresh); saveErr == nil {
				break
			}
			logger.Warn("persist refreshed token failed; retrying", "attempt", attempt+1, "error", saveErr)
			time.Sleep(time.Duration(100*(attempt+1)) * time.Millisecond)
		}
		if saveErr != nil {
			logger.Error("persist refreshed token failed after retries; aborting refresh to avoid stale-token reuse", "error", saveErr)
			return "", false
		}
		logger.Info("access token refreshed; reconnecting with new token")
		return newAccess, true
	}

	// Durable outbound spool: mirror unacked events to disk so a daemon process
	// crash doesn't lose them (replayed on next start). Default on; disable with
	// POCKETCTL_SPOOL=0. A setup failure is non-fatal — fall back to in-memory.
	spoolReady := false
	if os.Getenv("POCKETCTL_SPOOL") != "0" {
		if cfgDir, err := config.ConfigDir(); err == nil {
			spoolDir := filepath.Join(cfgDir, "spool")
			spoolPath := filepath.Join(spoolDir, id+".log")
			if err := client.InitSpool(spoolPath); err != nil {
				logger.Warn("outbound spool disabled", "error", err)
			} else {
				spoolReady = true
			}
			// Remove orphan spool files left by a previous daemon whose ID changed
			// (machine.id drift): each is bounded but never reclaimed otherwise.
			pruneOrphanSpools(spoolDir, id, logger)
		}
	}
	if codexReplayCursor != nil && spoolReady {
		client.OnEventsAcknowledged = func(eventIDs []string) {
			if err := codexReplayCursor.AdvanceEventIDs(eventIDs); err != nil {
				logger.Warn("persist Codex replay cursor failed", "error", err)
			}
			// Combined ACK: also advance the isolated ZCode observer's cursor.
			// The two are independent — a failure in one does not block the
			// other (each has its own diagnostics).
			if zcodeObserver != nil {
				zcodeObserver.AcknowledgeEventIDs(eventIDs)
			}
		}
	} else if zcodeObserver != nil {
		client.OnEventsAcknowledged = func(eventIDs []string) {
			zcodeObserver.AcknowledgeEventIDs(eventIDs)
		}
	}

	// Start system metrics collector
	sysinfo.Start()
	defer sysinfo.Stop()
	client.SetMetricsFn(func() (float64, float64, float64) {
		m := sysinfo.Get()
		return m.CpuPct, m.MemPct, m.DiskPct
	})
	client.SetOpenCodeRuntimeTelemetryFn(func() protocol.OpenCodeRuntimeTelemetry {
		snapshot, err := agentcontrol.LoadOpenCodeTelemetry()
		if err != nil {
			return protocol.OpenCodeRuntimeTelemetry{}
		}
		return protocol.OpenCodeRuntimeTelemetry{
			FallbackReasons: snapshot.FallbackReasons,
			HealthOK:        snapshot.HealthOK, HealthFailed: snapshot.HealthFailed,
		}
	})
	// Seed this daemon's active session IDs into the register message so the
	// relay can rebuild its session→daemon routing table synchronously on
	// (re)connection, before any session_discovered events arrive.
	client.SetActiveSessionIDsFn(func() []string {
		return sm.ActiveRootSessionIDs()
	})

	// Dirty flag for state persistence — only write when changed
	var stateDirty atomic.Bool
	sm.OnStateChanged = func() {
		stateDirty.Store(true)
	}

	// Re-sync sessions after (re)connection
	client.OnReconnected = func() {
		sessions := sm.ListSessions()
		count := len(sessions)
		logger.Info(fmt.Sprintf("resyncing %d sessions after reconnect", count))
		reconnectEvents := reconnectSessionEvents(sessions, sm.PendingClaudeApprovals)
		for _, evt := range reconnectEvents {
			client.SendMsg(evt)
		}
		_ = agentcontrol.RecordClaudeReplay(len(reconnectEvents) - len(sessions))
		if len(recoveredClaudeApprovals) > 0 {
			recoveredClaudeApprovalMu.Lock()
			if len(recoveredClaudeApprovals) > 0 {
				_ = agentcontrol.RecordClaudeOrphanClosure(len(recoveredClaudeApprovals))
				for _, evt := range recoverClaudeApprovalEvents(&daemon.ClaudeApprovalState{Requests: recoveredClaudeApprovals}) {
					client.SendMsg(evt)
				}
				recoveredClaudeApprovals = nil
				references := sm.ClaudeApprovalReferences()
				requests := make([]daemon.ClaudeApprovalStateItem, 0, len(references))
				for _, reference := range references {
					requests = append(requests, daemon.ClaudeApprovalStateItem{
						SessionID: reference.SessionID,
						RequestID: reference.RequestID,
						CreatedAt: reference.CreatedAt,
					})
				}
				if err := daemon.WriteClaudeApprovalState(daemon.ClaudeApprovalState{DaemonID: id, Requests: requests}); err != nil {
					logger.Warn("clear recovered Claude approval state", "error", err)
				}
			}
			recoveredClaudeApprovalMu.Unlock()
		}
		logger.Info("resync done")
		// Ask the isolated ZCode observer to re-emit its resync metadata through
		// the low-priority gate (ordered before new content). It does NOT burst
		// all history here, and does NOT enter SessionManager resync.
		if zcodeObserver != nil {
			zcodeObserver.QueueResync()
		}
	}

	// Connection state tracking
	client.OnStateChange = func(connected bool) {
		stateDirty.Store(true)
		if connected {
			logger.Info("connected to relay")
		} else {
			logger.Warn("disconnected from relay")
		}
	}
	client.OnConnectionStatus = func(status ws.ConnectionStatus, reason string) {
		stateDirty.Store(true)
		if err := statePersistence.updateConnectionWithDiagnostics(status, reason, time.Now().UTC(), client.DurableIngressDiagnostics()); err != nil {
			logger.Error("write daemon connection state", "error", err)
		}
	}

	// Detect runtime model switches: every outgoing agent_text event now carries
	// the model Claude actually used (filled by the adapters). When it differs
	// from the session's cached model, update the cache and emit a
	// session_model_changed event so the relay + Web/iOS clients reflect the
	// /model switch in real time.
	client.OnEvent = func(evt protocol.DaemonEvent) []protocol.DaemonEvent {
		enrichRepositoryFacts(context.Background(), &evt)
		// Turn lifecycle chokepoint: registry sync + single (turn, state)
		// emission dedup for every producer (codex projection, claude JSONL
		// tracker, opencode backend). Dropped duplicates never reach the relay.
		if evt.Type == protocol.EventTypeTurnStatus {
			if !sm.ObserveTurnStatusEvent(evt) {
				return nil
			}
			sm.EnrichOutgoingEvent(&evt)
			return []protocol.DaemonEvent{evt}
		}
		// Central outgoing classifier: metadata-only enrichment (actor/flow/
		// content class + unassigned-event counter), never filtering.
		sm.EnrichOutgoingEvent(&evt)
		if evt.Type == "session_model_changed" && evt.Model != "" && evt.SessionID != "" {
			current, _ := sm.GetSessionModel(evt.SessionID)
			if evt.Model == current {
				return nil
			}
			sm.SetSessionModel(evt.SessionID, evt.Model)
			if current == "" {
				// This is first discovery, not an explicit user model switch. Keep
				// it durable for the session list while clients suppress the stream
				// notice and only update their model badge.
				evt.Reason = "initial_model"
				return []protocol.DaemonEvent{evt}
			}
			logger.Info("session model changed", "session", evt.SessionID, "model", evt.Model, "prev", current)
			return []protocol.DaemonEvent{evt}
		}
		if evt.Type != "agent_text" || evt.Model == "" || evt.SessionID == "" {
			return []protocol.DaemonEvent{evt}
		}
		current, _ := sm.GetSessionModel(evt.SessionID)
		if evt.Model == current {
			return []protocol.DaemonEvent{evt}
		}
		sm.SetSessionModel(evt.SessionID, evt.Model)
		logger.Info("session model changed", "session", evt.SessionID, "model", evt.Model, "prev", current)
		// Older agents report only on agent_text. New Codex turn_context records
		// are handled above and therefore reach clients before this reply.
		return []protocol.DaemonEvent{evt, {
			Type:      "session_model_changed",
			SessionID: evt.SessionID,
			Model:     evt.Model,
		}}
	}

	// Wire terminal notifications
	sm.OnNotifyTerminal = func(sessionID, ttyPath string) {
		msg := fmt.Sprintf("Session %s received a message", sessionID[:8])
		notify.NotifyTerminal(ttyPath, msg, msg)
	}

	// Route content-free resume lifecycle counters into telemetry.
	wireResumeCleanupTelemetry(sm)

	// Context with signal handling
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start the ZCode observer now that the daemon ctx exists. Fail-closed: if
	// the storage/schema probe fails the observer is dropped but the daemon's
	// other agents and the Relay loop continue unaffected.
	if zcodeObserver != nil {
		if err := zcodeObserver.Start(ctx); err != nil {
			logger.Warn("zcode observer disabled (storage/schema unavailable)", "error", err)
			zcodeObserver.Stop()
			zcodeObserver = nil
		}
	}

	sigCh := make(chan os.Signal, 1)
	installSignalHandler(sigCh) // PR2: platform split (Unix SIGINT/SIGTERM, Windows os.Interrupt)

	var shutdownNoticeOnce sync.Once
	sendShutdownNotice := func() {
		shutdownNoticeOnce.Do(func() {
			client.SendMsg(protocol.DaemonEvent{
				Type:    "daemon_shutdown",
				Reason:  "daemon_stop",
				Message: "daemon is shutting down",
			})
			logger.Info("daemon shutdown notice sent")
		})
	}

	// PR4: Windows 控制通道(Unix no-op)。收 stop → 通知 relay → cancel → 优雅退出。
	// detached Windows daemon 收不到信号,靠控制 pipe 接收 daemon stop 命令。
	if err := daemon.StartControlChannel(func() {
		sendShutdownNotice()
		cancel()
	}); err != nil {
		logger.Warn("control channel not started", "error", err)
	}

	// keep-awake: 本地控制 socket + 休眠抑制管理器。用户经
	// `pocketctl daemon keep-awake on/off/status` 显式控制;不默认开启。
	// 平台不支持(macOS/Windows 之外)时 Manager 仍可用,仅抑制器返回 ErrUnsupported,
	// socket 正常响应"not supported"。电池保护:WatchForBattery 在 active 且检测到
	// 电池供电时自动 Disable,避免电量耗尽强制关机反而中断任务。
	kaMgr := keepawake.NewManager(logger)
	kaServer := keepawake.NewServer(config.ControlSocketPath(), kaMgr, logger)
	if err := kaServer.Start(); err != nil {
		logger.Warn("keep-awake control socket not started", "error", err)
	} else {
		logger.Info("keep-awake control socket listening", "path", kaServer.ListenPath())
		daemon.RunLoop(ctx, "keep-awake-watch", logger, func() { kaMgr.WatchForBattery(ctx) })
		daemon.Go("keep-awake-server", logger, func() { kaServer.Serve(ctx) })
	}

	// Start session watcher (Claude terminal sessions)
	if err := sw.Start(ctx); err != nil {
		logger.Error("start session watcher", "error", err)
		os.Exit(1)
	}

	// Start codex terminal-session watcher (CODEX_HOME-aware rollout discovery).
	// Non-fatal: a host without codex just yields no events.
	cw := watcher.NewCodexSessionWatcherWithReplayCursor(codexReplayCursor)
	if err := cw.Start(ctx); err != nil {
		logger.Warn("codex session watcher not started", "error", err)
	}

	// Start process monitor
	daemon.RunLoop(ctx, "process-monitor", logger, func() { pm.Run(ctx) })

	// Start WebSocket client
	daemon.RunLoop(ctx, "ws-client", logger, func() {
		if err := client.Run(ctx); err != nil && ctx.Err() == nil {
			logger.Error("ws client exited", "error", err)
		}
	})

	// Handle watcher events (Claude + Codex share the same discovery handler).
	// These MUST be supervised: a panic here used to silently kill the goroutine,
	// freeze the event channel, and leave session discovery (incl. --continue
	// resumes) permanently blind. See internal/daemon/safego.go.
	daemon.RunLoop(ctx, "watcher-claude", logger, func() {
		handleWatcherEvents(ctx, sw.Events(), adapter.AgentClaude, sm, pm, outputCh, logger, &stateDirty)
	})
	daemon.RunLoop(ctx, "watcher-codex", logger, func() {
		handleWatcherEvents(ctx, cw.Events(), adapter.AgentCodex, sm, pm, outputCh, logger, &stateDirty)
	})

	// Handle process monitor events
	daemon.RunLoop(ctx, "process-events", logger, func() {
		handleProcessEvents(ctx, pm, sm, logger, &stateDirty)
	})

	// Handle commands from relay
	daemon.RunLoop(ctx, "commands", logger, func() {
		// Phase 1 memory MCP: bridge processes ask this daemon for short
		// memory.mcp grants over a dedicated user-private socket; the daemon
		// brokers them over its authenticated relay connection.
		memoryMcpBroker := memorymcp.NewWsBroker(client)
		memoryMcpServer := &memorymcp.Server{
			SocketPath: config.MemoryMcpSocketPath(),
			Request:    memoryMcpBroker.Request,
			Logger:     logger,
		}
		if ln, err := memoryMcpServer.Start(); err != nil {
			logger.Warn("memory-mcp bridge socket not started", "error", err)
		} else {
			logger.Info("memory-mcp bridge socket listening", "path", config.MemoryMcpSocketPath())
			daemon.Go("memory-mcp-server", logger, func() { memoryMcpServer.Serve(ctx, ln) })
		}

		handleCommands(ctx, client, sm, logger, &stateDirty, memoryMcpBroker, memoryContextGrants)
	})

	// Periodic state update. Durable-ingress diagnostics are refreshed on this
	// bounded cadence because normal ACKs do not necessarily change connection
	// status or session state.
	daemon.RunLoop(ctx, "state-persist", logger, func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !stateDirty.Swap(false) {
					if err := statePersistence.refreshDiagnostics(client.DurableIngressDiagnostics()); err != nil {
						logger.Error("write daemon ingress diagnostics", "error", err)
					}
					continue
				}
				sessions := sm.ListSessions()
				stateSessions := make([]daemon.SessionState, len(sessions))
				for i, s := range sessions {
					stateSessions[i] = daemon.SessionState{
						SessionID:      s.SessionID,
						Agent:          s.Agent,
						Cwd:            s.Cwd,
						Status:         s.Status,
						StartedAt:      s.StartedAt,
						LastActivityAt: s.LastActivityAt,
					}
				}
				if err := statePersistence.updateSessionsWithDiagnostics(stateSessions, client.DurableIngressDiagnostics()); err != nil {
					logger.Error("write daemon session state", "error", err)
				}
			}
		}
	})

	fmt.Println(i18n.T("daemon.started", id, os.Getpid()))
	fmt.Println(i18n.T("daemon.version", version))
	fmt.Println(i18n.T("daemon.relay", url))
	fmt.Println(i18n.T("daemon.agents", strings.Join(agentTypes, ", ")))
	printDaemonAgentStartupStatus(os.Stdout, agentAutoEnable, agentSetupSkipped)
	fmt.Println(i18n.T("daemon.logs", daemon.LogPath()))

	// Discover terminal-started opencode sessions via the shared `opencode serve`
	// (current opencode is DB-backed; the daemon's serve sees terminal sessions
	// over its HTTP API and the message poller syncs them). Started here — AFTER
	// the daemonize gate — so only the real daemon process spawns `opencode
	// serve`; otherwise the short-lived launcher process would orphan a second
	// serve (PPID=1) that races the shared SQLite DB.
	if err := sm.StartOpencodeDiscovery(); err != nil {
		logger.Warn("opencode discovery not started", "error", err)
	}

	// Wait for signal
	select {
	case <-sigCh:
		sendShutdownNotice()
	case <-ctx.Done(): // PR4: 控制通道 stop → cancel → 这里唤醒
		sendShutdownNotice()
	}
	logger.Info("shutting down")
	fmt.Println(i18n.T("daemon.shutting_down"))
	runDaemonShutdownSequence(daemonShutdownSteps{
		ReleaseKeepAwake:  func() { _ = kaMgr.Disable(keepawake.ReasonShutdown) },
		CloseKeepAwake:    func() { _ = kaServer.Close() },
		CloseAgentControl: func() { _ = agentControlServer.Close() },
		DrainResumes: func() {
			drainCtx, drainCancel := context.WithTimeout(context.Background(), daemonResumeDrainTimeout)
			defer drainCancel()
			_ = drainResumeProcessesBeforeExit(drainCtx, sm, logger)
		},
		ShutdownCodex: func() {
			if err := sm.ShutdownCodex(); err != nil {
				logger.Warn("Codex app-server shutdown incomplete", "error", err)
			}
		},
		StopZCodeObserver: func() {
			if zcodeObserver != nil {
				zcodeObserver.Stop()
			}
		},
		ShutdownOpencode: func() { sm.ShutdownOpencode() },
	})
	cancel()
	time.Sleep(500 * time.Millisecond)
}

// daemonResumeDrainTimeout bounds the owned-resume drain before exit.
const daemonResumeDrainTimeout = 5 * time.Second

// wireResumeCleanupTelemetry routes content-free resume lifecycle counters
// from the SessionManager into agentcontrol telemetry, preserving package
// boundaries (session never imports agentcontrol for this).
func wireResumeCleanupTelemetry(sm *session.SessionManager) func(reason string) {
	rec := func(reason string) {
		if err := agentcontrol.RecordResumeCleanup(reason); err != nil {
			slog.Default().Warn("resume cleanup telemetry rejected", "error", err)
		}
	}
	sm.SetResumeCleanupRecorder(rec)
	return rec
}

// resumeShutdowner is the SessionManager seam the exit paths use to drain
// daemon-owned one-shot resume processes.
type resumeShutdowner interface {
	ShutdownResumeProcesses(context.Context) error
}

// drainResumeProcessesBeforeExit cancels and reaps every daemon-owned
// one-shot resume within ctx. An error is logged but never blocks exit.
func drainResumeProcessesBeforeExit(ctx context.Context, sm resumeShutdowner, logger *slog.Logger) error {
	if sm == nil {
		return nil
	}
	err := sm.ShutdownResumeProcesses(ctx)
	if err != nil && logger != nil {
		logger.Warn("daemon resume cleanup incomplete", "error", err)
	}
	return err
}

// daemonShutdownSteps is the normal daemon shutdown sequence as injectable
// steps so ordering can be regression-tested without a real daemon.
type daemonShutdownSteps struct {
	ReleaseKeepAwake  func()
	CloseKeepAwake    func()
	CloseAgentControl func()
	DrainResumes      func()
	ShutdownCodex     func()
	StopZCodeObserver func()
	ShutdownOpencode  func()
}

// runDaemonShutdownSequence tears the daemon down in the required order:
// owned one-shot resumes are drained after the daemon stops accepting new
// launcher requests and before the runtime providers (Codex, ZCode,
// OpenCode) shut down.
func runDaemonShutdownSequence(steps daemonShutdownSteps) {
	if steps.ReleaseKeepAwake != nil {
		steps.ReleaseKeepAwake()
	}
	if steps.CloseKeepAwake != nil {
		steps.CloseKeepAwake()
	}
	if steps.CloseAgentControl != nil {
		steps.CloseAgentControl()
	}
	if steps.DrainResumes != nil {
		steps.DrainResumes()
	}
	if steps.ShutdownCodex != nil {
		steps.ShutdownCodex()
	}
	if steps.StopZCodeObserver != nil {
		steps.StopZCodeObserver()
	}
	if steps.ShutdownOpencode != nil {
		steps.ShutdownOpencode()
	}
}

// restartChildHandle identifies the replacement daemon process of a hot
// restart.
type restartChildHandle struct {
	pid       int
	readyPath string
	proc      *os.Process
}

// daemonRestartDeps is the hot-restart flow as injectable steps so the
// drain-before-exit ordering and the failure-preservation guarantees are
// testable without spawning a real daemon.
type daemonRestartDeps struct {
	logger           *slog.Logger
	activeStop       func() bool
	resolveExe       func() (string, error)
	prepare          func() error
	cancelRestart    func()
	spawnReplacement func(exe string) (restartChildHandle, error)
	awaitReady       func(restartChildHandle) error
	alive            func(restartChildHandle) bool
	terminate        func(restartChildHandle)
	resumeShutdowner resumeShutdowner
	exit             func()
}

// runDaemonHotRestart attempts one hot restart: prepare, spawn, await
// readiness, then — only once the replacement is provably ready — drain
// daemon-owned one-shot resumes and exit. Every failure path preserves the
// current daemon and its active resumes.
func runDaemonHotRestart(d daemonRestartDeps) {
	if d.activeStop != nil && d.activeStop() {
		return
	}
	exe, err := d.resolveExe()
	if err != nil {
		d.logger.Error("daemon restart failed: get executable", "error", err)
		return
	}
	if err := d.prepare(); err != nil {
		d.logger.Error("daemon restart aborted: preserve opencode serve", "error", err)
		return
	}
	child, err := d.spawnReplacement(exe)
	if err != nil {
		if d.cancelRestart != nil {
			d.cancelRestart()
		}
		d.logger.Error("daemon restart failed: spawn", "error", err)
		return
	}
	if err := d.awaitReady(child); err != nil {
		if d.cancelRestart != nil {
			d.cancelRestart()
		}
		if d.terminate != nil {
			d.terminate(child)
		}
		d.logger.Error("daemon restart failed: replacement not ready", "error", err)
		return
	}
	if d.alive != nil && !d.alive(child) {
		if d.cancelRestart != nil {
			d.cancelRestart()
		}
		if d.terminate != nil {
			d.terminate(child)
		}
		d.logger.Error("daemon restart failed: replacement died after readiness")
		return
	}
	if d.activeStop != nil && d.activeStop() {
		if d.cancelRestart != nil {
			d.cancelRestart()
		}
		if d.terminate != nil {
			d.terminate(child)
		}
		return
	}
	d.logger.Info("new daemon spawned, exiting")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), daemonResumeDrainTimeout)
	_ = drainResumeProcessesBeforeExit(shutdownCtx, d.resumeShutdowner, d.logger)
	shutdownCancel()
	if d.exit != nil {
		d.exit()
	}
}

func daemonRuntimeProviders(sm *session.SessionManager) map[string]agentcontrol.RuntimeProvider {
	return map[string]agentcontrol.RuntimeProvider{
		agentcontrol.AgentOpenCode: sm,
		agentcontrol.AgentCodex:    sm.CodexRuntimeProvider(),
	}
}

func parserAgentForPublicAgent(agent string) string {
	if agent == adapter.AgentCodexDesktop {
		return adapter.AgentCodex
	}
	return agent
}

func reconnectDiscoveryEvent(s session.SessionInfo) protocol.DaemonEvent {
	source := s.Source
	if source == "" {
		source = "terminal"
	}
	event := protocol.DaemonEvent{
		Type:         "session_discovered",
		SessionID:    s.SessionID,
		Cwd:          s.Cwd,
		Status:       s.Status,
		Source:       source,
		Agent:        s.Agent,
		Model:        s.Model,
		ControlMode:  s.ControlMode,
		Capabilities: s.Capabilities,
		Resync:       true,
	}
	if !s.LastActivityAt.IsZero() {
		event.LastActivityAt = s.LastActivityAt.UTC().Format(time.RFC3339Nano)
	}
	enrichRepositoryFacts(context.Background(), &event)
	return event
}

func enrichRepositoryFacts(ctx context.Context, event *protocol.DaemonEvent) {
	if event == nil || event.Cwd == "" ||
		(event.Type != "session_discovered" && event.Type != "session_created") {
		return
	}
	observation, ok := repositoryidentity.Resolve(ctx, event.Cwd)
	if !ok {
		return
	}
	event.RepositoryID = observation.RepositoryID
	event.Branch = observation.Branch
	event.CommitSHA = observation.CommitSHA
}

func observeJSONLLifecycle(sm *session.SessionManager, event protocol.DaemonEvent) bool {
	if sm == nil || event.Type != "session_status" || event.Resync {
		return false
	}
	return sm.ObserveJSONLSessionStatus(event.SessionID, event.Status)
}

// reconnectSessionEvents keeps the existing discovery stream intact and then
// appends only Claude Hook approvals that are still answerable by this daemon.
// Codex and OpenCode retain their own reconnect/reconciliation authorities.
func reconnectSessionEvents(sessions []session.SessionInfo, pendingClaude func(string) []protocol.DaemonEvent) []protocol.DaemonEvent {
	events := make([]protocol.DaemonEvent, 0, len(sessions))
	for _, info := range sessions {
		events = append(events, reconnectDiscoveryEvent(info))
	}
	if pendingClaude == nil {
		return events
	}
	for _, info := range sessions {
		events = append(events, pendingClaude(info.SessionID)...)
	}
	return events
}

func recoverClaudeApprovalEvents(state *daemon.ClaudeApprovalState) []protocol.DaemonEvent {
	if state == nil {
		return nil
	}
	events := make([]protocol.DaemonEvent, 0, len(state.Requests))
	for _, request := range state.Requests {
		events = append(events, protocol.DaemonEvent{
			Type:      "approval_resolved",
			SessionID: request.SessionID,
			RequestID: request.RequestID,
			Reason:    "daemon_restarted",
		})
	}
	return events
}

// terminalHydrationEvents projects the first full JSONL pass into historical
// content plus one current watcher status. Persisted turn-completion records
// describe old turns, not the current terminal process; forwarding them as live
// session_status events can overwrite a freshly discovered busy/idle state.
func terminalHydrationEvents(events []protocol.DaemonEvent, sessionID, currentStatus string) []protocol.DaemonEvent {
	projected := make([]protocol.DaemonEvent, 0, len(events)+1)
	for _, event := range events {
		if event.Type == "session_status" {
			continue
		}
		if event.SessionID == "" {
			event.SessionID = sessionID
		}
		event.Resync = true
		projected = append(projected, event)
	}
	if currentStatus != "" {
		projected = append(projected, protocol.DaemonEvent{
			Type:      "session_status",
			SessionID: sessionID,
			Status:    currentStatus,
			Resync:    true,
		})
	}
	return projected
}

// Claude rewrites its watcher metadata in place during continue. A watcher can
// observe the live PID before the status field is present; treat that transient
// snapshot as idle instead of publishing an empty lifecycle status.
func normalizeWatcherSessionStatus(agentType string, discovered *watcher.DiscoveredSession) {
	if discovered == nil || discovered.Status != "" || discovered.Pid <= 0 || agentType != adapter.AgentClaude {
		return
	}
	discovered.Status = protocol.StatusIdle
}

func interactionCommandResultEvent(operation, sessionID, requestID string, err error) protocol.DaemonEvent {
	if errors.Is(err, adapter.ErrObserverReadOnly) {
		return session.ObserverReadOnlyEvent(operation, sessionID, requestID, "", err)
	}
	var resolved *session.ResolvedElsewhereError
	if errors.As(err, &resolved) {
		return protocol.DaemonEvent{
			Type: "interaction_result", SessionID: sessionID, RequestID: resolved.RequestID,
			Operation: operation, Status: session.InteractionResolvedElsewhere, Reason: session.InteractionResolvedElsewhere,
		}
	}
	return protocol.DaemonEvent{
		Type: "error", SessionID: sessionID, RequestID: requestID,
		Operation: operation, Error: err.Error(),
	}
}

func controlCommandErrorEvent(operation, sessionID, requestID string, err error) protocol.DaemonEvent {
	if errors.Is(err, adapter.ErrObserverReadOnly) {
		return session.ObserverReadOnlyEvent(operation, sessionID, requestID, "", err)
	}
	return protocol.DaemonEvent{
		Type: "error", SessionID: sessionID, RequestID: requestID, Operation: operation, Error: err.Error(),
	}
}

func codexSubagentDiscoveryEvent(s watcher.DiscoveredSession) protocol.DaemonEvent {
	rootID := s.RootSessionID
	if rootID == "" {
		rootID = s.ParentSessionID
	}
	desc := strings.TrimSpace(s.AgentNickname)
	if desc == "" && strings.TrimSpace(s.AgentPath) != "" {
		desc = filepath.Base(strings.TrimRight(s.AgentPath, string(filepath.Separator)))
		if desc == "." || desc == string(filepath.Separator) {
			desc = ""
		}
	}
	if desc == "" {
		desc = s.SessionID
		if len(desc) > 8 {
			desc = desc[len(desc)-8:]
		}
	}
	return protocol.DaemonEvent{
		Type:            "subagent_discovered",
		EventID:         "codex-subagent:" + s.SessionID + ":discovery",
		SessionID:       rootID,
		AgentID:         s.SessionID,
		ParentSessionID: rootID,
		RootSessionID:   rootID,
		IsSubagent:      true,
		Agent:           adapter.AgentCodex,
		SubAgentType:    adapter.AgentCodex,
		SubAgentDesc:    desc,
	}
}

// ---------- daemon stop ----------

func cmdDaemonStop() {
	if err := daemon.Stop(); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("error.generic", err))
		os.Exit(1)
	}
	fmt.Println(i18n.T("daemon.stopped"))
}

// ---------- daemon keep-awake ----------

// cmdDaemonKeepAwake 实现 `pocketctl daemon keep-awake on|off|status`。
// 通过本地控制 socket 与运行中的 daemon 通信(不经 relay)。daemon 未运行时
// socket 不存在,返回可识别错误。开启后若检测到电池供电,daemon 会在下一次
// 轮询自动关闭以保护电量(不推送通知,需手动 status 查看)。
func cmdDaemonKeepAwake(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, i18n.T("keepawake.usage"))
		os.Exit(1)
	}
	action := args[0]
	switch action {
	case "on", "off", "status":
	default:
		fmt.Fprintln(os.Stderr, i18n.T("keepawake.bad_action", action))
		os.Exit(1)
	}
	resp, err := keepawake.Ask(config.ControlSocketPath(), keepawake.Request{
		Cmd:    "keep-awake",
		Action: action,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("keepawake.connect_failed"))
		fmt.Fprintln(os.Stderr, "  "+err.Error())
		os.Exit(1)
	}
	if !resp.OK {
		fmt.Fprintln(os.Stderr, i18n.T("keepawake.failed", resp.Error))
		os.Exit(1)
	}
	// 成功:打印消息与状态摘要。
	fmt.Println(resp.Msg)
	switch {
	case resp.OnBattery:
		// 已在 msg 里附带电池提示,无需重复。
	case resp.Enabled:
		fmt.Println(i18n.T("keepawake.state_on"))
	default:
		fmt.Println(i18n.T("keepawake.state_off"))
		if resp.Reason != "" {
			fmt.Println(i18n.T("keepawake.reason", resp.Reason))
		}
	}
}

// ---------- daemon status ----------

func cmdDaemonStatus() {
	pid, running, runtimeErr := daemon.RuntimeStatus()
	if runtimeErr != nil {
		renderDaemonStatusUncertainty(os.Stdout, runtimeErr)
		return
	}
	if !running {
		fmt.Println(i18n.T("daemon.not_running"))
		return
	}

	state, err := daemon.ReadState()
	if err != nil {
		fmt.Println(i18n.T("daemon.running_no_state", pid))
		return
	}
	renderVerifiedDaemonStatus(os.Stdout, *state, pid, daemon.VerifyRuntimeIdentity)
}

func renderDaemonStatusUncertainty(out io.Writer, err error) {
	fmt.Fprintln(out, i18n.T("daemon.status_uncertain", err))
}

type detachedDaemonStartupStage uint8

const (
	detachedDaemonStartupRuntime detachedDaemonStartupStage = iota + 1
	detachedDaemonStartupState
	detachedDaemonStartupIdentity
)

type detachedDaemonStartupUncertainty struct {
	stage detachedDaemonStartupStage
	cause error
}

func newDetachedDaemonStartupUncertainty(
	stage detachedDaemonStartupStage,
	cause error,
) error {
	if cause == nil {
		cause = errors.New("daemon startup observation was incomplete")
	}
	return &detachedDaemonStartupUncertainty{stage: stage, cause: cause}
}

func (e *detachedDaemonStartupUncertainty) Error() string {
	return "detached daemon startup status is uncertain"
}

func (e *detachedDaemonStartupUncertainty) Unwrap() []error {
	return []error{daemon.ErrRuntimeStatusUncertain, e.cause}
}

func observeDetachedDaemonStartup(
	runtimeStatus func() (int, bool, error),
	readState func() (*daemon.DaemonState, error),
	verify func(int, string) (bool, error),
) (bool, bool, error) {
	_, running, err := runtimeStatus()
	if err != nil {
		return false, false, newDetachedDaemonStartupUncertainty(
			detachedDaemonStartupRuntime,
			err,
		)
	}
	if !running {
		return false, false, nil
	}
	state, err := readState()
	if err != nil {
		return true, false, newDetachedDaemonStartupUncertainty(
			detachedDaemonStartupState,
			err,
		)
	}
	verified, err := verify(state.PID, state.RuntimeInstanceToken)
	if err != nil {
		return true, false, newDetachedDaemonStartupUncertainty(
			detachedDaemonStartupIdentity,
			err,
		)
	}
	if !verified {
		return false, false, newDetachedDaemonStartupUncertainty(
			detachedDaemonStartupIdentity,
			errors.New("daemon process identity did not match startup state"),
		)
	}
	return true, state.Connected, nil
}

func renderDetachedDaemonStartupFailure(
	out io.Writer,
	logPath string,
	uncertainty error,
) {
	fmt.Fprintln(out, i18n.T("daemon.start_failed", logPath))
	if uncertainty == nil {
		return
	}
	fmt.Fprintln(out, localizedDetachedDaemonStartupUncertainty(uncertainty))
}

func localizedDetachedDaemonStartupUncertainty(err error) string {
	if errors.Is(err, os.ErrPermission) {
		return i18n.T("daemon.start_uncertain_permission")
	}
	var startupErr *detachedDaemonStartupUncertainty
	if !errors.As(err, &startupErr) {
		return i18n.T("daemon.start_uncertain")
	}
	switch startupErr.stage {
	case detachedDaemonStartupRuntime:
		return i18n.T("daemon.start_uncertain_runtime")
	case detachedDaemonStartupState:
		return i18n.T("daemon.start_uncertain_state")
	case detachedDaemonStartupIdentity:
		return i18n.T("daemon.start_uncertain_identity")
	default:
		return i18n.T("daemon.start_uncertain")
	}
}

func renderVerifiedDaemonStatus(
	out io.Writer,
	state daemon.DaemonState,
	pidfilePID int,
	verify func(int, string) (bool, error),
) {
	running, err := verify(state.PID, state.RuntimeInstanceToken)
	if err != nil {
		renderDaemonStatusUncertainty(out, err)
		return
	}
	if !running {
		fmt.Fprintln(out, i18n.T("daemon.not_running"))
		return
	}
	if state.PID != pidfilePID {
		renderDaemonStatusUncertainty(
			out,
			fmt.Errorf(
				"%w: state pid %d does not match runtime pid %d",
				daemon.ErrRuntimeStatusUncertain,
				state.PID,
				pidfilePID,
			),
		)
		return
	}
	renderDaemonStatus(out, state, pidfilePID, func(int) bool { return true })
}

func renderDaemonStatus(out io.Writer, state daemon.DaemonState, pidfilePID int, isAlive func(int) bool) {
	if pidfilePID <= 0 || state.PID != pidfilePID || !isAlive(pidfilePID) {
		fmt.Fprintln(out, i18n.T("daemon.not_running"))
		return
	}
	fmt.Fprintln(out, i18n.T("status.daemon", state.DaemonID))
	ver := state.Version
	if ver == "" {
		// Older daemon that predates the Version field — surface it explicitly
		// so a version mismatch (stale daemon, new CLI) is visible, not silent.
		ver = i18n.T("status.unknown")
	}
	fmt.Fprintln(out, i18n.T("status.version", ver))
	fmt.Fprintln(out, i18n.T("status.pid", state.PID))
	fmt.Fprintln(out, i18n.T("status.relay", state.RelayURL))
	accountEmail := state.AccountEmail
	if accountEmail == "" {
		accountEmail = i18n.T("status.unknown")
	}
	fmt.Fprintln(out, i18n.T("status.account", accountEmail))
	conn := localizedConnectionStatus(state)
	fmt.Fprintln(out, i18n.T("status.status_line", conn))
	if state.ConnectionReason != "" {
		fmt.Fprintln(out, i18n.T("status.reason", state.ConnectionReason))
	}
	if !state.UpdatedAt.IsZero() {
		fmt.Fprintln(out, i18n.T("status.updated", state.UpdatedAt.Format(time.RFC3339)))
	}
	fmt.Fprintln(out, i18n.T("status.started", state.StartedAt.Format(time.RFC3339)))
	fmt.Fprintf(out, "Ingress spool: %d events, %d bytes\n", state.SpoolEvents, state.SpoolBytes)
	fmt.Fprintf(out, "Ingress window: %s\n", diagnosticCount(state.EventWindow))
	fmt.Fprintf(out, "Ingress unacked: %s\n", diagnosticCount(state.UnackedEvents))
	if state.LastACKAt.IsZero() {
		fmt.Fprintln(out, "Ingress last ACK: unknown")
	} else {
		fmt.Fprintln(out, "Ingress last ACK:", state.LastACKAt.Format(time.RFC3339))
	}
	fmt.Fprintln(out, "Reconnects:", state.ReconnectCount)
	backpressureDuration := state.BackpressureDuration
	if !state.BackpressureSince.IsZero() {
		backpressureDuration += time.Since(state.BackpressureSince)
	}
	fmt.Fprintln(out, "Backpressure duration:", backpressureDuration.Round(time.Millisecond))

	if len(state.Sessions) > 0 {
		fmt.Fprintln(out, i18n.T("status.sessions", len(state.Sessions)))
		for _, s := range state.Sessions {
			fmt.Fprintln(out, i18n.T("status.session_row", s.SessionID[:8], s.Status, s.Cwd))
		}
	}
}

func diagnosticCount(value int) string {
	if value < 0 {
		return "unknown"
	}
	return strconv.Itoa(value)
}

func localizedConnectionStatus(state daemon.DaemonState) string {
	if state.ConnectionStatus == "" {
		if state.Connected {
			return i18n.T("status.connected")
		}
		return i18n.T("status.disconnected")
	}
	keys := map[string]string{
		string(ws.ConnectionConnected):     "status.connected",
		string(ws.ConnectionReconnecting):  "status.reconnecting",
		string(ws.ConnectionBackpressured): "status.backpressured",
		string(ws.ConnectionAuthUncertain): "status.auth_uncertain",
		string(ws.ConnectionLoginRequired): "status.login_required",
		string(ws.ConnectionRevoked):       "status.revoked",
		string(ws.ConnectionStopped):       "status.stopped",
	}
	if key, ok := keys[state.ConnectionStatus]; ok {
		return i18n.T(key)
	}
	return i18n.T("status.connection_unknown", state.ConnectionStatus)
}

type daemonStatePersistence struct {
	mu    sync.Mutex
	state daemon.DaemonState
}

func newDaemonStatePersistence(initial daemon.DaemonState) *daemonStatePersistence {
	initial.Sessions = append([]daemon.SessionState(nil), initial.Sessions...)
	return &daemonStatePersistence{state: initial}
}

func persistInitialDaemonStateAndContinue(
	initial daemon.DaemonState,
	write func(*daemon.DaemonState) error,
	cleanup func(),
	continueStartup func(*daemonStatePersistence),
) error {
	persistence := newDaemonStatePersistence(initial)
	if err := write(&persistence.state); err != nil {
		cleanup()
		return fmt.Errorf("write initial daemon state: %w", err)
	}
	continueStartup(persistence)
	return nil
}

func (p *daemonStatePersistence) write() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return daemon.WriteState(&p.state)
}

func (p *daemonStatePersistence) updateConnection(status ws.ConnectionStatus, reason string, updatedAt time.Time) error {
	return p.updateConnectionWithDiagnostics(status, reason, updatedAt, ws.DurableIngressDiagnostics{
		EventWindow:   -1,
		UnackedEvents: -1,
	})
}

func (p *daemonStatePersistence) updateConnectionWithDiagnostics(status ws.ConnectionStatus, reason string, updatedAt time.Time, diagnostics ws.DurableIngressDiagnostics) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if status == ws.ConnectionReconnecting && p.state.ConnectionStatus != string(ws.ConnectionReconnecting) {
		p.state.ReconnectCount++
	}
	if status == ws.ConnectionBackpressured && p.state.BackpressureSince.IsZero() {
		p.state.BackpressureSince = updatedAt
	}
	if status != ws.ConnectionBackpressured && !p.state.BackpressureSince.IsZero() {
		p.state.BackpressureDuration += updatedAt.Sub(p.state.BackpressureSince)
		p.state.BackpressureSince = time.Time{}
	}
	p.state.SpoolEvents = diagnostics.SpoolEvents
	p.state.SpoolBytes = diagnostics.SpoolBytes
	p.state.EventWindow = diagnostics.EventWindow
	p.state.UnackedEvents = diagnostics.UnackedEvents
	p.state.LastACKAt = diagnostics.LastACKAt
	p.state.ReconnectCount = diagnostics.Reconnects
	p.state.Connected = status == ws.ConnectionConnected
	p.state.ConnectionStatus = string(status)
	p.state.ConnectionReason = reason
	p.state.UpdatedAt = updatedAt
	return daemon.WriteState(&p.state)
}

func (p *daemonStatePersistence) updateSessions(sessions []daemon.SessionState) error {
	return p.updateSessionsWithDiagnostics(sessions, ws.DurableIngressDiagnostics{})
}

func (p *daemonStatePersistence) updateSessionsWithDiagnostics(sessions []daemon.SessionState, diagnostics ws.DurableIngressDiagnostics) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.state.Sessions = append(p.state.Sessions[:0], sessions...)
	p.applyDiagnostics(diagnostics)
	return daemon.WriteState(&p.state)
}

func (p *daemonStatePersistence) refreshDiagnostics(diagnostics ws.DurableIngressDiagnostics) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.applyDiagnostics(diagnostics)
	return daemon.WriteState(&p.state)
}

func (p *daemonStatePersistence) applyDiagnostics(diagnostics ws.DurableIngressDiagnostics) {
	p.state.SpoolEvents = diagnostics.SpoolEvents
	p.state.SpoolBytes = diagnostics.SpoolBytes
	p.state.EventWindow = diagnostics.EventWindow
	p.state.UnackedEvents = diagnostics.UnackedEvents
	p.state.LastACKAt = diagnostics.LastACKAt
	p.state.ReconnectCount = diagnostics.Reconnects
}

// ---------- daemon logs ----------

func cmdDaemonLogs() {
	// Prefer today's file; if the daemon last ran on an earlier day, fall back
	// to the most recent dated log so `daemon logs` always shows something useful.
	path := daemon.LogPath()
	if _, err := os.Stat(path); err != nil {
		if latest := daemon.LatestLogPath(); latest != "" {
			path = latest
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("error.read_log", err))
		os.Exit(1)
	}
	os.Stdout.Write(data)
}

// ---------- daemon doctor ----------

func cmdDoctor() {
	fmt.Println(i18n.T("doctor.title"))
	fmt.Println(i18n.T("doctor.rule"))

	pass := 0
	total := 0

	// Helper: print check result
	check := func(name string, ok bool, detail string) {
		total++
		if ok {
			pass++
			fmt.Println(i18n.T("doctor.check_pass", name, detail))
		} else {
			fmt.Println(i18n.T("doctor.check_fail", name, detail))
		}
	}

	// 1. Config file
	relayURL, accessToken, _, err := config.LoadAuth()
	check(i18n.T("doctor.check_config"), err == nil, func() string {
		if err != nil {
			return i18n.T("doctor.not_logged_in")
		}
		return i18n.T("doctor.config_exists")
	}())

	// 2. Token validity
	if accessToken != "" {
		exp, err := api.ParseJWTExpiry(accessToken)
		if err != nil {
			check(i18n.T("doctor.check_token"), false, i18n.T("doctor.token_invalid"))
		} else if time.Now().After(exp) {
			check(i18n.T("doctor.check_token"), false, i18n.T("doctor.token_expired"))
		} else {
			check(i18n.T("doctor.check_token"), true, i18n.T("doctor.token_valid", exp.Format("2006-01-02 15:04")))
		}
	} else {
		check(i18n.T("doctor.check_token"), false, i18n.T("doctor.no_token"))
	}

	// Derive base URL from relay URL
	baseURL := relayURL
	if baseURL == "" {
		// No relay URL configured — report partial results
		fmt.Println()
		fmt.Println(i18n.T("doctor.rule"))
		fmt.Println(i18n.T("doctor.result_partial_no_relay", pass, total))
		fmt.Println(i18n.T("doctor.rule"))
		os.Exit(1)
	}
	// Strip /ws suffix for HTTP calls
	baseURL = strings.TrimSuffix(baseURL, "/ws")
	baseURL = strings.TrimSuffix(baseURL, "/")
	// Convert ws:// to http:// and wss:// to https:// for HTTP calls
	baseURL = strings.Replace(baseURL, "wss://", "https://", 1)
	baseURL = strings.Replace(baseURL, "ws://", "http://", 1)

	// 3. DNS resolution
	hostname := ""
	if u, err := url.Parse(baseURL); err == nil {
		hostname = u.Hostname()
	}
	if hostname != "" {
		addrs, err := net.LookupHost(hostname)
		check(i18n.T("doctor.check_dns"), err == nil, func() string {
			if err != nil {
				return i18n.T("doctor.dns_fail", hostname)
			}
			return i18n.T("doctor.dns_ok", hostname, addrs[0])
		}())
	} else {
		check(i18n.T("doctor.check_dns"), false, i18n.T("doctor.dns_no_host"))
	}

	// 4. HTTP health check
	start := time.Now()
	healthBody, healthErr := api.HealthCheck(baseURL)
	elapsed := time.Since(start).Milliseconds()
	check(i18n.T("doctor.check_http"), healthErr == nil, func() string {
		if healthErr != nil {
			return i18n.T("doctor.http_fail", baseURL, healthErr)
		}
		return i18n.T("doctor.http_ok", elapsed)
	}())

	// 5. Relay health status
	if healthErr == nil {
		var parsed map[string]any
		if json.Unmarshal([]byte(healthBody), &parsed) == nil {
			status, _ := parsed["status"].(string)
			check(i18n.T("doctor.check_relay"), status == "ok", func() string {
				if status == "ok" {
					return i18n.T("doctor.relay_ok")
				}
				return i18n.T("doctor.relay_status", status)
			}())
		}
	} else {
		check(i18n.T("doctor.check_relay"), false, i18n.T("doctor.relay_no_http"))
	}

	// 6. WebSocket + 7. Auth + 8. Daemon limit (combined in one WS probe)
	if relayURL != "" && accessToken != "" {
		wsURL := relayURL
		if !strings.HasSuffix(wsURL, "/ws") {
			wsURL = strings.TrimRight(wsURL, "/") + "/ws"
		}

		u, parseErr := url.Parse(wsURL)
		if parseErr != nil {
			check(i18n.T("doctor.check_ws"), false, parseErr.Error())
			check(i18n.T("doctor.check_auth"), false, i18n.T("doctor.ws_fail"))
			check(i18n.T("doctor.check_limit"), false, i18n.T("doctor.ws_fail"))
		} else {
			q := u.Query()
			q.Set("type", "daemon")
			u.RawQuery = q.Encode()

			hdr := http.Header{}
			hdr.Set("Authorization", "Bearer "+accessToken)
			wsConn, _, wsErr := websocket.DefaultDialer.Dial(u.String(), hdr)
			if wsErr != nil {
				check(i18n.T("doctor.check_ws"), false, wsErr.Error())
				check(i18n.T("doctor.check_auth"), false, i18n.T("doctor.ws_fail"))
				check(i18n.T("doctor.check_limit"), false, i18n.T("doctor.ws_fail"))
			} else {
				check(i18n.T("doctor.check_ws"), true, i18n.T("doctor.ws_ok"))

				// Send register message
				hostname, _ := os.Hostname()
				registerMsg, _ := json.Marshal(map[string]any{
					"type":      "register",
					"daemon_id": "doctor-probe",
					"hostname":  hostname,
					"agents":    []string{"claude-code"},
				})
				wsConn.WriteMessage(websocket.TextMessage, registerMsg)

				// Wait for response (5s timeout)
				wsConn.SetReadDeadline(time.Now().Add(5 * time.Second))
				_, resp, readErr := wsConn.ReadMessage()
				wsConn.Close()

				if readErr != nil {
					check(i18n.T("doctor.check_auth"), false, i18n.T("doctor.ws_timeout", readErr))
					check(i18n.T("doctor.check_limit"), false, i18n.T("doctor.cannot_check"))
				} else {
					var result map[string]any
					json.Unmarshal(resp, &result)
					msgType, _ := result["type"].(string)
					code, _ := result["code"].(string)

					if msgType == "register_ack" {
						check(i18n.T("doctor.check_auth"), true, i18n.T("doctor.auth_ack"))
						check(i18n.T("doctor.check_limit"), true, i18n.T("doctor.limit_ok"))
					} else if code == "DAEMON_LIMIT_REACHED" {
						errMsg, _ := result["error"].(string)
						check(i18n.T("doctor.check_auth"), true, i18n.T("doctor.auth_ok"))
						check(i18n.T("doctor.check_limit"), false, errMsg)
					} else if msgType == "error" {
						errMsg, _ := result["error"].(string)
						check(i18n.T("doctor.check_auth"), false, errMsg)
						check(i18n.T("doctor.check_limit"), false, i18n.T("doctor.auth_fail"))
					} else {
						check(i18n.T("doctor.check_auth"), false, i18n.T("doctor.auth_unknown", msgType))
						check(i18n.T("doctor.check_limit"), false, i18n.T("doctor.cannot_check"))
					}
				}
			}
		}
	} else {
		check(i18n.T("doctor.check_ws"), false, i18n.T("doctor.ws_missing"))
		check(i18n.T("doctor.check_auth"), false, i18n.T("doctor.config_missing"))
		check(i18n.T("doctor.check_limit"), false, i18n.T("doctor.config_missing"))
	}

	// Summary
	fmt.Println()
	fmt.Println(i18n.T("doctor.rule"))
	if pass == total {
		fmt.Println(i18n.T("doctor.result_all_pass", pass, total))
	} else {
		fmt.Println(i18n.T("doctor.result_partial", pass, total, total-pass))
	}
	fmt.Println(i18n.T("doctor.rule"))

	if pass < total {
		os.Exit(1)
	}
}

// handleWatcherEvents consumes session-discovery events from a watcher (Claude's
// SessionWatcher or Codex's CodexSessionWatcher — both emit watcher.SessionEvent)
// and registers/tails them under the given agentType.
func handleWatcherEvents(ctx context.Context, events <-chan watcher.SessionEvent, agentType string, sm *session.SessionManager, pm *watcher.ProcessMonitor, outputCh chan protocol.DaemonEvent, logger *slog.Logger, stateDirty *atomic.Bool) {
	for {
		select {
		case <-ctx.Done():
			return
		case evt := <-events:
			switch evt.Action {
			case "subagent_discovered":
				if agentType != adapter.AgentCodex {
					logger.Warn("ignoring unsupported subagent watcher event", "agent", agentType, "session", evt.Session.SessionID)
					break
				}
				outputCh <- codexSubagentDiscoveryEvent(evt.Session)
				daemon.RunLoop(ctx, "tailer:codex-subagent:"+evt.Session.SessionID, logger, func() {
					var tailer *watcher.SubAgentTailer
					var err error
					if evt.Replay {
						tailer, err = watcher.NewCodexReplaySubAgentTailer(
							evt.Filepath,
							evt.Session.SessionID,
							evt.Session.RootSessionID,
							adapter.AgentCodex,
							evt.ReplayNotBefore,
							evt.ReplayStartLine,
						)
					} else {
						tailer, err = watcher.NewSubAgentTailerForAgent(
							evt.Filepath,
							evt.Session.SessionID,
							evt.Session.RootSessionID,
							adapter.AgentCodex,
							adapter.AgentCodex,
						)
					}
					if err != nil {
						logger.Warn("codex subagent tailer start failed", "session", evt.Session.SessionID, "error", err)
						return
					}
					tailer.Run(ctx, outputCh)
				})

			case "discovered":
				normalizeWatcherSessionStatus(agentType, &evt.Session)
				logger.Info("session discovered", "session", evt.Session.SessionID, "pid", evt.Session.Pid)
				publishedAgent := evt.Session.AgentType
				if publishedAgent == "" {
					publishedAgent = agentType
				}
				parserAgent := parserAgentForPublicAgent(publishedAgent)
				source := evt.Session.Source
				if source == "" {
					source = "terminal"
				}
				startTailer := false
				reclassified := false
				if source == "observer" {
					registration, shouldStartHistoryTailer := sm.RegisterObservedSessionForHistory(
						evt.Session.SessionID, evt.Session.Cwd, evt.Session.Status, publishedAgent,
					)
					startTailer = shouldStartHistoryTailer
					reclassified = registration == session.ObservedSessionReclassified
				} else {
					startTailer = sm.RegisterTerminalSession(
						evt.Session.SessionID, evt.Session.Cwd, evt.Session.Pid, "", evt.Session.Status, publishedAgent,
					)
				}
				// Register with process monitor
				if evt.Session.Pid > 0 {
					pm.Register(evt.Session.Pid, evt.Session.SessionID)
				}
				// Try to get TTY for notifications
				if evt.Session.Pid > 0 {
					if ttyPath, err := notify.GetTTYForPID(evt.Session.Pid); err == nil {
						// Update TTY info (returns false if already registered, that is fine)
						sm.RegisterTerminalSession(evt.Session.SessionID, evt.Session.Cwd, evt.Session.Pid, ttyPath, evt.Session.Status, publishedAgent)
					}
				}
				// Only start JSONL tailer if this is a genuinely new session
				if reclassified {
					model, _ := sm.GetSessionModel(evt.Session.SessionID)
					discoveryEvent := protocol.DaemonEvent{
						Type:         "session_discovered",
						SessionID:    evt.Session.SessionID,
						Cwd:          evt.Session.Cwd,
						Status:       evt.Session.Status,
						Source:       "observer",
						Agent:        publishedAgent,
						Model:        model,
						ControlMode:  sm.SessionControlMode(evt.Session.SessionID),
						Capabilities: sm.SessionCapabilities(evt.Session.SessionID),
					}
					if activity, ok := sm.SessionActivityAt(evt.Session.SessionID); ok && !activity.IsZero() {
						discoveryEvent.LastActivityAt = activity.UTC().Format(time.RFC3339Nano)
					}
					outputCh <- discoveryEvent
					stateDirty.Store(true)
				}
				if !startTailer {
					logger.Debug("session already known, skipping tailer", "session", evt.Session.SessionID)
					// Re-discovered (e.g. --continue): tailer already running on same JSONL,
					// but emit session_status so relay/DB updates from "exited" → current status.
					sm.SyncRediscoveredTerminalStatus(evt.Session.SessionID, evt.Session.Status)
					break
				}
				// Start JSONL tailer from beginning to replay history and tail new events.
				// Supervised via RunLoop: if the tail loop ever panics it restarts (the
				// tailer tracks its own offset, so a restart resumes safely) rather than
				// silently dying and leaving the session — including a later --continue
				// resume — with no message forwarding.
				daemon.RunLoop(ctx, "tailer:"+evt.Session.SessionID, logger, func() {
					// Default title baked into session_discovered so the relay row is created
					// with it (not NULL), avoiding the race where session_title_update lands
					// before the row exists and the default never sticks (2fec2498 case).
					shortID := evt.Session.SessionID
					if len(shortID) > 8 {
						shortID = shortID[len(shortID)-8:]
					}
					defaultTitle := "Terminal Session-" + shortID
					resolution, resolveErr := resolveTerminalJSONLForSession(
						ctx, sm, evt, parserAgent, defaultTerminalJSONLResolvePolicy(), logger,
					)
					if resolveErr != nil {
						if ctx.Err() != nil {
							return
						}
						if errors.Is(resolveErr, errTerminalJSONLSessionRetired) {
							logger.Info("ghost session retired (metadata no longer references unresolved jsonl)",
								"session", evt.Session.SessionID)
							// This function is supervised by RunLoop. A true ghost must stay
							// parked or a clean return would restart its resolver forever.
							<-ctx.Done()
							return
						}
						logger.Warn("terminal jsonl resolution failed", "session", evt.Session.SessionID, "error", resolveErr)
						return
					}
					jsonlPath := resolution.path
					sessionSnapshot := resolution.session
					jsonlActivityAt := time.Time{}
					if info, statErr := os.Stat(jsonlPath); statErr == nil {
						jsonlActivityAt, _ = sm.RestoreSessionActivity(sessionSnapshot.SessionID, info.ModTime())
					}
					if resolution.recoveredLate {
						if source == "observer" {
							sm.RegisterObservedSession(sessionSnapshot.SessionID, sessionSnapshot.Cwd,
								sessionSnapshot.Status, publishedAgent)
						} else if sessionSnapshot.Pid > 0 {
							if ttyPath, ttyErr := notify.GetTTYForPID(sessionSnapshot.Pid); ttyErr == nil {
								sm.RegisterTerminalSession(sessionSnapshot.SessionID, sessionSnapshot.Cwd,
									sessionSnapshot.Pid, ttyPath, sessionSnapshot.Status, publishedAgent)
							}
						}
						logger.Info("late session jsonl resolved", "session", sessionSnapshot.SessionID, "path", jsonlPath)
					}

					var tailer *watcher.JSONLTailer
					var err error
					if parserAgent == adapter.AgentClaude && watcher.ClaudeJSONLV2Enabled() {
						tailer, err = watcher.NewClaudeJSONLTailerFromStart(jsonlPath, sessionSnapshot.SessionID)
					} else if publishedAgent == adapter.AgentCodexDesktop {
						tailer, err = watcher.NewCodexObserverJSONLTailerFromStart(jsonlPath)
					} else {
						tailer, err = watcher.NewJSONLTailerFromStart(jsonlPath, parserAgent)
					}
					if err != nil {
						logger.Warn("terminal jsonl tailer start failed", "session", sessionSnapshot.SessionID, "error", err)
						return
					}
					model := ""
					if data, readErr := os.ReadFile(jsonlPath); readErr == nil {
						model = adapter.NewStorage(parserAgent).ExtractModel(strings.Split(string(data), "\n"))
						if model != "" {
							sm.SetSessionModel(sessionSnapshot.SessionID, model)
						}
					}
					// Associate tailer with session so sendToIdleTerminal can pause/resume it (D2)
					sm.SetTailer(sessionSnapshot.SessionID, tailer)
					// Tailer started successfully — now emit session_discovered
					discoveryEvent := protocol.DaemonEvent{
						Type:         "session_discovered",
						SessionID:    sessionSnapshot.SessionID,
						Cwd:          sessionSnapshot.Cwd,
						Status:       sessionSnapshot.Status,
						Source:       source,
						Agent:        publishedAgent,
						Title:        defaultTitle,
						Model:        model,
						ControlMode:  sm.SessionControlMode(sessionSnapshot.SessionID),
						Capabilities: sm.SessionCapabilities(sessionSnapshot.SessionID),
					}
					if !jsonlActivityAt.IsZero() {
						discoveryEvent.LastActivityAt = jsonlActivityAt.UTC().Format(time.RFC3339Nano)
					}
					outputCh <- discoveryEvent
					// codex/opencode terminal 会话:session_discovered 带的 model 受
					// upsertSession 的 COALESCE 约束(空值不覆盖、已有非空值不覆盖),
					// 历史 rollout 解析出的 model 可能写不进已有空记录。补发一个
					// session_model_changed —— relay 侧无条件覆盖,确保 DB 一定刷新。
					if model != "" {
						outputCh <- protocol.DaemonEvent{
							Type:      "session_model_changed",
							SessionID: sessionSnapshot.SessionID,
							Model:     model,
						}
					}
					// P0: start sub-agent discoverer (only Claude Code has subagents/ dir)
					if parserAgent == adapter.AgentClaude {
						disc := watcher.NewSubAgentDiscoverer(jsonlPath, sessionSnapshot.SessionID, outputCh, 2*time.Second)
						go disc.Run(ctx)
					}
					defer tailer.Close()

					// Mirror the default title locally too (session_discovered already
					// carries it), so the daemon's in-memory state agrees with the relay row.
					sm.UpdateSessionTitle(sessionSnapshot.SessionID, defaultTitle)

					// Tail loop: send parsed events with session_id stamped
					ticker := time.NewTicker(1 * time.Second)
					defer ticker.Stop()
					hydrating := true
					for {
						select {
						case <-ctx.Done():
							return
						case <-ticker.C:
							if tailer.IsPaused() {
								continue // D2: paused during sendToIdleTerminal, skip forwarding
							}
							events, rawLines, err := tailer.TailNewLines()
							if err != nil {
								continue
							}
							initialHydration := hydrating && (len(events) > 0 || len(rawLines) > 0)
							if initialHydration {
								events = terminalHydrationEvents(events, sessionSnapshot.SessionID, sessionSnapshot.Status)
								hydrating = false
							}
							for i := range events {
								if events[i].SessionID == "" {
									events[i].SessionID = sessionSnapshot.SessionID
								}
								if events[i].Type == "session_status" && !events[i].Resync {
									if !observeJSONLLifecycle(sm, events[i]) {
										continue
									}
									stateDirty.Store(true)
								}
								protocol.FinalizeAgentPlanEvent(&events[i])
								if parserAgent == adapter.AgentClaude && events[i].Type == "sync_warning" {
									_ = agentcontrol.RecordClaudeJSONLWarning(events[i].Reason)
								}
								sm.ObservePermissionEvent(events[i])
								outputCh <- events[i]
							}
							// Check for title generation trigger (user + assistant messages
							// ready). Re-fires each new conversation round; GenerateTitle caps
							// total attempts at MaxTitleAttempts and the relay skips once an AI
							// title is written, so re-evaluating per tick is safe.
							if len(rawLines) > 0 {
								// title 提取需 user+assistant 都有。增量 rawLines 常把两者拆到不同
								// tick(codex discovered 早时 user_message 在一增量、agent_message 在另一
								// 增量),ExtractFirst(当前增量)永远凑不齐 → 永不触发 GenerateTitle。
								// 直接读全量 JSONL 提取首条 user+assistant 确保凑齐。本地 IO 不增 token
								// (ExtractFirst 只取首条截断 200;GenerateTitle 有 MaxTitleAttempts + relay
								// hasDefaultTitle 防重复调 DeepSeek)。
								if jsonlPath, perr := adapter.ResolveJSONLPathFor(parserAgent, evt.Session.SessionID, evt.Session.Cwd); perr == nil {
									allLines := readJSONLLines(jsonlPath, 500)
									userMsg := adapter.ExtractFirstUserMessageFor(allLines, 200, parserAgent)
									assistantMsg := adapter.ExtractFirstAssistantMessageFor(allLines, 200, parserAgent)
									if userMsg != "" && assistantMsg != "" {
										sm.GenerateTitle(sessionSnapshot.SessionID, userMsg, assistantMsg)
									}
								}
							}
						}
					}
				})

			case "changed":
				normalizeWatcherSessionStatus(agentType, &evt.Session)
				logger.Debug("session changed", "session", evt.Session.SessionID, "status", evt.Session.Status)
				if agentType == adapter.AgentClaude {
					ttyPath := ""
					if evt.Session.Pid > 0 {
						ttyPath, _ = notify.GetTTYForPID(evt.Session.Pid)
					}
					if sm.SyncLiveTerminalSession(
						evt.Session.SessionID, evt.Session.Cwd, evt.Session.Pid, ttyPath,
						evt.Session.Status, adapter.AgentClaude,
					) {
						pm.Register(evt.Session.Pid, evt.Session.SessionID)
					} else {
						logger.Debug("ignored unverified Claude watcher status", "session", evt.Session.SessionID, "pid", evt.Session.Pid)
					}
				} else {
					sm.SetSessionStatus(evt.Session.SessionID, evt.Session.Status)
				}

			case "removed":
				logger.Info("session removed", "session", evt.Session.SessionID)
				sm.SetSessionExited(evt.Session.SessionID, protocol.ExitReasonNormalExit)
				stateDirty.Store(true)
				if evt.Session.Pid > 0 {
					pm.Unregister(evt.Session.Pid)
				}
			}
		}
	}
}

func handleProcessEvents(ctx context.Context, pm *watcher.ProcessMonitor, sm *session.SessionManager, logger *slog.Logger, stateDirty *atomic.Bool) {
	for {
		select {
		case <-ctx.Done():
			return
		case change := <-pm.Changes():
			if !change.Alive {
				logger.Info("process died", "pid", change.Pid, "session", change.SessionID)
				stateDirty.Store(true)
				sm.SetSessionExited(change.SessionID, protocol.ExitReasonProcessCrash)
			}
		}
	}
}

func quotaReservationID(grant *protocol.QuotaGrant) string {
	if grant == nil {
		return ""
	}
	return grant.ReservationID
}

// observerCommandRejection is the daemon command-loop preflight. The caller
// runs it before quota validation, state-dirty markers, or any native resolver.
func observerCommandRejection(sm *session.SessionManager, cmd protocol.ClientMessage) (protocol.DaemonEvent, bool) {
	if cmd.Type == "upgrade_agent" && adapter.IsObserverAgent(cmd.Agent) {
		return session.ObserverUpgradeRejectedEvent(cmd.Agent, cmd.RequestID), true
	}
	if cmd.Type == "session_create" {
		agent := cmd.Agent
		if agent == "" {
			agent = adapter.AgentClaude
		}
		if adapter.IsObserverAgent(agent) {
			return session.ObserverCreateRejectedEvent(cmd.RequestID, quotaReservationID(cmd.QuotaGrant)), true
		}
		return protocol.DaemonEvent{}, false
	}
	if !session.IsObserverDriveCommand(cmd.Type) {
		return protocol.DaemonEvent{}, false
	}
	var err error
	if cmd.Type == "user_message" {
		err = sm.RejectObserverUserMessage(cmd.SessionID)
	} else {
		err = sm.RejectObserverDrive(cmd.SessionID)
	}
	if err == nil {
		return protocol.DaemonEvent{}, false
	}
	return session.ObserverReadOnlyEvent(cmd.Type, cmd.SessionID, cmd.RequestID, cmd.MsgID, err), true
}

func buildSessionMeta(ctx context.Context, sm *session.SessionManager, sessionID string, requestID string, logger *slog.Logger) protocol.DaemonEvent {
	// Historical Claude/Codex sessions are JSONL-backed. Restore them before
	// consulting OpenCode: when the optional OpenCode serve is unavailable,
	// EnsureOpencodeSessionLoaded intentionally reports no authoritative result
	// and used to prevent a valid Codex rollout from being loaded at all.
	if !sm.EnsureSessionLoaded(sessionID) {
		sm.EnsureOpencodeSessionLoaded(sessionID)
	}
	agentType, _ := sm.GetSessionAgent(sessionID)
	parserAgent := parserAgentForPublicAgent(agentType)
	storage := adapter.NewStorage(parserAgent)
	model, exists := sm.GetSessionModel(sessionID)
	effort := sm.GetSessionEffort(sessionID)
	if model == "" && agentType == adapter.AgentOpencode {
		model = sm.OpencodeSessionModelFromServe(sessionID)
	}
	needsModel := model == "" && agentType != adapter.AgentOpencode
	needsCodexEffort := effort == "" && parserAgent == adapter.AgentCodex
	if needsModel || needsCodexEffort {
		cwd, cwdOk := sm.GetSessionCwd(sessionID)
		if !cwdOk {
			logger.Info("get_session_meta: not in memory", "session", sessionID, "exists", exists)
		} else if path, perr := storage.ResolveJSONLPath(sessionID, cwd); perr != nil {
			logger.Info("get_session_meta: resolve path failed", "session", sessionID, "cwd", cwd, "error", perr)
		} else if data, ferr := os.ReadFile(path); ferr != nil {
			logger.Info("get_session_meta: read jsonl failed", "session", sessionID, "path", path, "error", ferr)
		} else {
			lines := strings.Split(string(data), "\n")
			if needsModel {
				m := storage.ExtractModel(lines)
				logger.Info("get_session_meta: extracted", "session", sessionID, "lines", len(lines), "model", m)
				if m != "" {
					sm.SetSessionModel(sessionID, m)
					model = m
				}
			}
			if needsCodexEffort {
				effort = (adapter.CodexSessionStorage{}).ExtractEffort(lines)
				if effort != "" {
					sm.SetSessionEffort(sessionID, effort)
				}
			}
		}
	}
	logger.Info("get_session_meta", "session", sessionID, "model", model)
	cwd, _ := sm.GetSessionCwd(sessionID)
	meta := protocol.DaemonEvent{
		Type:      "session_meta",
		SessionID: sessionID,
		RequestID: requestID,
		Cwd:       cwd,
		Model:     model,
		Effort:    effort,
	}
	if parserAgent == adapter.AgentCodex {
		meta.Capabilities = sm.SessionCapabilities(sessionID)
		meta.ControlMode = sm.SessionControlMode(sessionID)
	} else if agentType == adapter.AgentOpencode {
		meta.Capabilities = sm.OpenCodeInteractionCapabilities(sessionID)
		meta.ControlMode = sm.SessionControlMode(sessionID)
		agentCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		meta.CurrentAgent = sm.CurrentSessionAgent(agentCtx, sessionID)
		cancel()
	}
	if permission, mutable, modes, ok := sm.GetPermissionMeta(sessionID); ok {
		meta.Permission, meta.PermissionMutable, meta.PermissionMutableModes = permission, mutable, modes
	}
	return meta
}

type userMessageSession interface {
	SendMessage(context.Context, string, string) error
	SendMessageWithInput(context.Context, session.UserMessageInput) error
	GetSessionAgent(string) (string, bool)
	SessionControlMode(string) string
}

func deliverUserMessage(
	ctx context.Context,
	sm userMessageSession,
	cmd protocol.ClientMessage,
	send func(protocol.DaemonEvent),
) error {
	agent, exists := sm.GetSessionAgent(cmd.SessionID)
	emitsReceipt := exists && agent != "" && cmd.MsgID != ""
	err := sm.SendMessageWithInput(ctx, session.UserMessageInput{
		SessionID: cmd.SessionID,
		Content:   cmd.Content,
		RequestID: cmd.RequestID,
		MsgID:     cmd.MsgID,
		InputMode: protocol.InputModeAuto,
	})
	if errors.Is(err, adapter.ErrObserverReadOnly) {
		send(session.ObserverReadOnlyEvent("user_message", cmd.SessionID, cmd.RequestID, cmd.MsgID, err))
		return err
	}
	// Typed interrupt-pending nack reaches the client for EVERY agent (review
	// P1-3): without request_id/reason/retryable a client can neither correlate
	// the rejection nor perform a controlled retry.
	var pending *turn.InterruptPendingError
	if errors.As(err, &pending) && cmd.RequestID != "" {
		retryable := true
		send(protocol.DaemonEvent{
			Type:      "user_message_receipt",
			SessionID: cmd.SessionID,
			MsgID:     cmd.MsgID,
			RequestID: cmd.RequestID,
			Status:    "rejected",
			Reason:    protocol.ReasonTurnInterruptPending,
			Retryable: &retryable,
		})
		return err
	}
	if err != nil && cmd.MsgID != "" {
		reason := "dispatch_failed"
		if errors.Is(err, session.ErrSessionExecutionIdentityUnavailable) {
			reason = "session_identity_unavailable"
		}
		retryable := false
		send(protocol.DaemonEvent{
			Type: "user_message_receipt", SessionID: cmd.SessionID, MsgID: cmd.MsgID, RequestID: cmd.RequestID,
			Status: "rejected", Reason: reason, Retryable: &retryable,
		})
		return err
	}
	if !emitsReceipt {
		return err
	}
	status := "accepted"
	reason := ""
	if err != nil {
		status = "rejected"
		reason = err.Error()
	}
	retryable := false
	send(protocol.DaemonEvent{
		Type:      "user_message_receipt",
		SessionID: cmd.SessionID,
		MsgID:     cmd.MsgID,
		RequestID: cmd.RequestID,
		Status:    status,
		Reason:    reason,
		Retryable: &retryable,
	})
	return err
}

func handleUserMessageCommand(
	ctx context.Context,
	sm *session.SessionManager,
	cmd protocol.ClientMessage,
	quotaGrants *session.QuotaGrantValidator,
	stateDirty *atomic.Bool,
	logger *slog.Logger,
	send func(protocol.DaemonEvent),
) {
	err := sm.WithObserverDrive(ctx, cmd.SessionID, func(driveCtx context.Context) error {
		logger.Info("user message", "session", cmd.SessionID)
		if identityErr := sm.ValidateExecutionIdentity(cmd.SessionID); identityErr != nil {
			retryable := false
			send(protocol.DaemonEvent{
				Type: "user_message_receipt", SessionID: cmd.SessionID, RequestID: cmd.RequestID, MsgID: cmd.MsgID,
				Status: "rejected", Reason: "session_identity_unavailable", Retryable: &retryable,
			})
			return nil
		}
		stateDirty.Store(true)
		requiresResume := sm.RequiresResume(cmd.SessionID)
		if requiresResume {
			duplicate, grantErr := quotaGrants.Validate(cmd.RequestID, cmd.QuotaGrant, "resume", time.Now())
			if grantErr != nil || duplicate {
				errText := "resume request already processed"
				if grantErr != nil {
					errText = grantErr.Error()
				}
				retryable := false
				send(protocol.DaemonEvent{
					Type: "user_message_receipt", SessionID: cmd.SessionID, RequestID: cmd.RequestID, MsgID: cmd.MsgID,
					ReservationID: quotaReservationID(cmd.QuotaGrant), Status: "rejected", Reason: "quota_grant_invalid",
					Error: errText, Retryable: &retryable,
				})
				return nil
			}
		}
		if err := deliverUserMessage(driveCtx, sm, cmd, send); err != nil {
			if errors.Is(err, adapter.ErrObserverReadOnly) {
				return nil // deliverUserMessage already sent the single typed nack.
			}
			logger.Error("send message failed", "error", err)
			reason := "dispatch_failed"
			if errors.Is(err, session.ErrSessionExecutionIdentityUnavailable) {
				reason = "session_identity_unavailable"
			}
			send(protocol.DaemonEvent{
				Type: "error", SessionID: cmd.SessionID, RequestID: cmd.RequestID,
				MsgID: cmd.MsgID, Operation: "user_message", Reason: reason, Error: err.Error(),
			})
		} else if requiresResume {
			send(protocol.DaemonEvent{
				Type: "session_status", SessionID: cmd.SessionID, Status: protocol.StatusRunning,
				RequestID: cmd.RequestID, ReservationID: quotaReservationID(cmd.QuotaGrant),
			})
		}
		return nil
	})
	if errors.Is(err, adapter.ErrObserverReadOnly) {
		send(session.ObserverReadOnlyEvent("user_message", cmd.SessionID, cmd.RequestID, cmd.MsgID, err))
		return
	}
	if err != nil {
		logger.Error("authorize user message failed", "session", cmd.SessionID, "error", err)
		send(controlCommandErrorEvent("user_message", cmd.SessionID, cmd.RequestID, err))
	}
}

type memoryContextControlSender interface {
	SendControlPayload([]byte) error
}

// wireMemoryContext installs the authenticated daemon→Relay broker and the
// direct Memory client. Relay/Memory failures remain fail-open inside the
// coordinator; only an exact per-session runtime probe can enable injection.
func wireMemoryContext(sm *session.SessionManager, sender memoryContextControlSender) *memorycontext.GrantClient {
	grants := &memorycontext.GrantClient{
		Send:    func(_ context.Context, payload []byte) error { return sender.SendControlPayload(payload) },
		Timeout: 750 * time.Millisecond,
	}
	grants.Reply = grants.WaitReply
	sm.SetMemoryContext(&memorycontext.Coordinator{
		Grants: grants, Memory: memorycontext.NewMemoryClient(), Deadline: 750 * time.Millisecond,
	}, func() bool { return true }, sm.MemoryContextCapability)
	return grants
}

func deliverDeferredInitialPrompt(
	ctx context.Context,
	grants *memorycontext.GrantClient,
	sessionID, prompt, requestID string,
	send func(session.UserMessageInput) error,
) error {
	registrationID := "memory-register-" + requestID
	if requestID == "" {
		registrationID = "memory-register-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	_, registrationErr := grants.RegisterSession(ctx, registrationID, sessionID)
	return send(session.UserMessageInput{
		SessionID: sessionID, Content: prompt, RequestID: requestID,
		SkipMemoryContext: registrationErr != nil,
	})
}

func handleCommands(ctx context.Context, client *ws.Client, sm *session.SessionManager, logger *slog.Logger, stateDirty *atomic.Bool, memoryMcpBroker *memorymcp.WsBroker, memoryContextGrants *memorycontext.GrantClient) {
	quotaGrants := session.NewQuotaGrantValidator()
	for {
		select {
		case <-ctx.Done():
			return
		case cmd := <-client.CommandCh:
			if sm.DispatchMemoryContextControl(cmd) {
				continue
			}
			if event, rejected := observerCommandRejection(sm, cmd); rejected {
				client.SendMsg(event)
				continue
			}
			switch cmd.Type {
			case "memory_mcp_grant_result", "memory_mcp_grant_error":
				memoryMcpBroker.Dispatch(cmd)
				continue
			case "session_create":
				duplicate, grantErr := quotaGrants.Validate(cmd.RequestID, cmd.QuotaGrant, "create", time.Now())
				if grantErr != nil || duplicate {
					reason := "quota_grant_invalid"
					errText := "invalid quota grant"
					if duplicate {
						reason, errText = "duplicate_request", "session create request already processed"
					} else if grantErr != nil {
						errText = grantErr.Error()
					}
					client.SendMsg(protocol.DaemonEvent{
						Type: "session_create_failed", RequestID: cmd.RequestID,
						ReservationID: quotaReservationID(cmd.QuotaGrant), Reason: reason, Error: errText,
					})
					continue
				}
				logger.Info("create session", "agent", cmd.Agent, "cwd", cmd.Cwd, "model", cmd.Model,
					"worktree", cmd.Worktree, "auto_create_dir", cmd.AutoCreateDir, "force", cmd.Force)
				stateDirty.Store(true)
				config := protocol.SessionConfig{
					Agent:         cmd.Agent,
					Cwd:           cmd.Cwd,
					Prompt:        cmd.Prompt,
					Permission:    cmd.Permission,
					Model:         cmd.Model,
					Worktree:      cmd.Worktree,
					AutoCreateDir: cmd.AutoCreateDir,
					Force:         cmd.Force,
				}
				if config.Agent == "" {
					config.Agent = "claude-code"
				}
				if config.Prompt != "" && (config.Agent == adapter.AgentCodex || config.Agent == adapter.AgentOpencode) {
					config.DeferInitialPrompt = true
				}
				sessionID, err := sm.CreateSession(ctx, config)
				if err != nil {
					logger.Error("create session failed", "error", err)
					reason := classifyCreateError(err.Error())
					client.SendMsg(protocol.DaemonEvent{
						Type: "session_create_failed", RequestID: cmd.RequestID,
						ReservationID: quotaReservationID(cmd.QuotaGrant), Reason: reason, Error: err.Error(),
					})
					continue
				}
				logger.Info("session created", "session", sessionID)

				// Notify relay that session was created so it can link the originating client.
				// Carry the resolved model so the web client can show it (/model command).
				model, _ := sm.GetSessionModel(sessionID)
				evt := protocol.DaemonEvent{
					Type:          "session_created",
					SessionID:     sessionID,
					Title:         config.Prompt,
					Model:         model,
					RequestID:     cmd.RequestID,
					ReservationID: quotaReservationID(cmd.QuotaGrant),
					Capabilities:  sm.SessionCapabilities(sessionID),
				}
				if permission, mutable, modes, ok := sm.GetPermissionMeta(sessionID); ok {
					evt.Permission = permission
					evt.PermissionMutable = mutable
					evt.PermissionMutableModes = modes
				}
				// Scheme D: surface the worktree path/branch so clients can show it.
				if wt, branch, ok := sm.GetWorktreeInfo(sessionID); ok {
					evt.WorktreePath = wt
					evt.WorktreeBranch = branch
				}
				// Scheme A: let the client know how many sessions now share this cwd.
				if cwd, ok := sm.GetSessionCwd(sessionID); ok {
					evt.Cwd = cwd
					evt.CwdSessions = sm.CwdSessionCount(cwd)
				}
				enrichRepositoryFacts(ctx, &evt)
				client.SendMsg(evt)
				if prompt, deferred := sm.TakeDeferredInitialPrompt(sessionID); deferred {
					// The command loop must remain free to receive and dispatch the
					// registration ACK that this goroutine is waiting for.
					daemon.Go("memory-context-initial-prompt", logger, func() {
						if err := deliverDeferredInitialPrompt(ctx, memoryContextGrants, sessionID, prompt, cmd.RequestID,
							func(input session.UserMessageInput) error { return sm.SendMessageWithInput(ctx, input) }); err != nil {
							logger.Warn("managed initial prompt dispatch failed", "session", sessionID, "error", err)
						}
					})
				}

			case "abort_create":
				logger.Info("abort create session", "session", cmd.SessionID)
				if cmd.SessionID != "" {
					if _, err := sm.AbortSessionWithError(cmd.SessionID); err != nil {
						client.SendMsg(controlCommandErrorEvent("abort_create", cmd.SessionID, cmd.RequestID, err))
					}
				}

			case "daemon_restart":
				logger.Info("daemon restart requested")
				daemon.Go("daemon-restart", logger, func() {
					time.Sleep(500 * time.Millisecond) // allow ack to send
					if daemon.ExplicitStopIntentActive() {
						return
					}
					runDaemonHotRestart(daemonRestartDeps{
						logger:        logger,
						activeStop:    daemon.ExplicitStopIntentActive,
						resolveExe:    os.Executable,
						prepare:       func() error { return prepareDaemonRestart(sm) },
						cancelRestart: sm.CancelDaemonRestart,
						spawnReplacement: func(exe string) (restartChildHandle, error) {
							readyPath := filepath.Join(filepath.Dir(daemon.PIDPath()), fmt.Sprintf("restart-%d-%d.ready", os.Getpid(), time.Now().UnixNano()))
							childEnv := restartChildEnv(append(os.Environ(), "POCKETCTL_DAEMON_CHILD=1"), readyPath)
							proc, err := daemonizer.ForkDetached(exe, os.Args[1:], childEnv)
							if err != nil {
								return restartChildHandle{}, err
							}
							return restartChildHandle{pid: proc.Pid, readyPath: readyPath, proc: proc}, nil
						},
						awaitReady: func(child restartChildHandle) error {
							return waitForRestartReady(child.readyPath, child.pid, 10*time.Second)
						},
						alive:            func(child restartChildHandle) bool { return platform.NewProcessController().IsAlive(child.pid) },
						terminate:        func(child restartChildHandle) { terminateRestartChild(child.proc, child.readyPath) },
						resumeShutdowner: sm,
						exit:             func() { os.Exit(0) },
					})
				})

			case "user_message":
				handleUserMessageCommand(ctx, sm, cmd, quotaGrants, stateDirty, logger, func(event protocol.DaemonEvent) {
					client.SendMsg(event)
				})

			case "session_kill":
				logger.Info("kill session", "session", cmd.SessionID)
				if err := sm.KillSession(cmd.SessionID); err != nil {
					logger.Error("kill session failed", "error", err)
					client.SendMsg(controlCommandErrorEvent("session_kill", cmd.SessionID, cmd.RequestID, err))
				} else {
					stateDirty.Store(true)
				}

			case "session_interrupt":
				logger.Info("interrupt session", "session", cmd.SessionID)
				if err := sm.InterruptSession(cmd.SessionID); err != nil {
					logger.Error("interrupt session failed", "error", err)
					client.SendMsg(controlCommandErrorEvent("session_interrupt", cmd.SessionID, cmd.RequestID, err))
				}

			case "set_permission_config":
				if err := sm.SetPermissionConfig(cmd.SessionID, cmd.Permission); err != nil {
					logger.Error("set permission config failed", "error", err)
					client.SendMsg(controlCommandErrorEvent("set_permission_config", cmd.SessionID, cmd.RequestID, err))
				}

			case "set_effort":
				// Switch the Claude TUI's thinking-effort level by injecting
				// `/effort <level>` into the PTY. Effort is a runtime-only TUI
				// state, so the recorded value reflects only what pocketctl set.
				logger.Info("set effort", "session", cmd.SessionID, "level", cmd.Content)
				agentType, _ := sm.GetSessionAgent(cmd.SessionID)
				if !adapter.Capabilities(agentType).SupportsEffort {
					client.SendMsg(protocol.DaemonEvent{
						Type:      "error",
						SessionID: cmd.SessionID,
						Error:     "effort switching is not supported for " + agentType,
					})
					continue
				}
				if err := sm.SetEffort(cmd.SessionID, cmd.Content); err != nil {
					logger.Error("set effort failed", "error", err)
					client.SendMsg(controlCommandErrorEvent("set_effort", cmd.SessionID, cmd.RequestID, err))
				}

			case "list_commands":
				logger.Debug("list commands", "session", cmd.SessionID)
				cwd, ok := sm.GetSessionCwd(cmd.SessionID)
				if !ok {
					// Unknown session / no cwd: return an empty list so the client
					// still gets a response and can degrade gracefully.
					client.SendMsg(protocol.DaemonEvent{
						Type:      "command_list",
						SessionID: cmd.SessionID,
						Commands:  []protocol.CommandItem{},
					})
					continue
				}
				// available = slash commands the agent reported in its init event
				// (authoritative for the -p environment); empty falls back to scan.
				available, _ := sm.GetSessionSlashCommands(cmd.SessionID)
				agentType, _ := sm.GetSessionAgent(cmd.SessionID)
				if agentType == adapter.AgentOpencode {
					commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
					items, err := sm.CommandsForSession(commandCtx, cmd.SessionID)
					cancel()
					if err != nil {
						logger.Error("list opencode commands failed", "session", cmd.SessionID, "error", err)
						client.SendMsg(protocol.DaemonEvent{Type: "error", SessionID: cmd.SessionID, Operation: "list_commands", Error: err.Error()})
						items = []protocol.CommandItem{}
					}
					client.SendMsg(protocol.DaemonEvent{Type: "command_list", SessionID: cmd.SessionID, Commands: items})
					continue
				}
				client.SendMsg(protocol.DaemonEvent{
					Type:      "command_list",
					SessionID: cmd.SessionID,
					Commands:  commands.ListCommands(cwd, agentType, available),
				})

			case "list_session_agents":
				agentCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
				agents, err := sm.ListSessionAgents(agentCtx, cmd.SessionID)
				cancel()
				if err != nil {
					logger.Error("list session agents failed", "session", cmd.SessionID, "error", err)
					client.SendMsg(protocol.DaemonEvent{Type: "error", SessionID: cmd.SessionID, Operation: "list_session_agents", Error: err.Error()})
					continue
				}
				client.SendMsg(protocol.DaemonEvent{Type: "session_agent_list", SessionID: cmd.SessionID, Agents: agents})

			case "set_session_agent":
				agentCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
				err := sm.SetSessionAgent(agentCtx, cmd.SessionID, cmd.AgentName)
				cancel()
				if err != nil {
					logger.Error("set session agent failed", "session", cmd.SessionID, "agent", cmd.AgentName, "error", err)
					client.SendMsg(controlCommandErrorEvent("set_session_agent", cmd.SessionID, cmd.RequestID, err))
				}

			case "get_session_meta":
				// Web client queries a session's resolved model (for the /model
				// command). Unlike session_created (one-shot, fired before the web
				// subscribes), this is a request/response the client issues on mount.
				client.SendMsg(buildSessionMeta(ctx, sm, cmd.SessionID, cmd.RequestID, logger))
				if evt, ok := sm.PendingInteractivePrompt(cmd.SessionID); ok {
					logger.Info("get_session_meta: replay pending interactive prompt", "session", cmd.SessionID, "req", evt.RequestID)
					client.SendMsg(evt)
				}
				for _, evt := range sm.PendingOpencodeInteractions(cmd.SessionID) {
					client.SendMsg(evt)
				}
				for _, evt := range sm.PendingClaudeApprovals(cmd.SessionID) {
					client.SendMsg(evt)
				}
				for _, evt := range sm.PendingClaudeChannelApprovals(cmd.SessionID) {
					client.SendMsg(evt)
				}

			case "list_models":
				// Web client queries the host's available models to populate the
				// session-creation picker. Claude reads ~/.claude/settings.json;
				// codex returns its own model list.
				client.SendMsg(protocol.DaemonEvent{
					Type:   "model_list",
					Agent:  cmd.Agent,
					Models: sm.ModelsForAgent(cmd.Agent),
				})

			case "upgrade_agent":
				daemon.Go("upgrade-agent", logger, func() { handleUpgradeAgent(client, logger, cmd.Agent) })

			case "approval_response":
				// Client answered a tool-use approval request (Yes/No). Resolves
				// the blocked PreToolUse hook so Claude proceeds (allow) or is
				// told to stop (deny).
				logger.Info("approval response", "session", cmd.SessionID, "req", cmd.RequestID, "approved", cmd.Approved, "action", cmd.Action)
				var err error
				if cmd.Action != "" {
					err = sm.ResolveApprovalAction(cmd.SessionID, cmd.RequestID, cmd.Action)
				} else {
					err = sm.ResolveApproval(cmd.SessionID, cmd.RequestID, cmd.Approved)
				}
				if err != nil {
					event := interactionCommandResultEvent("approval_response", cmd.SessionID, cmd.RequestID, err)
					if event.Type == "error" {
						logger.Error("resolve approval failed", "error", err)
					} else {
						logger.Info("approval already resolved", "session", cmd.SessionID, "req", cmd.RequestID)
					}
					client.SendMsg(event)
				}

			case "question_response":
				if err := sm.ResolveQuestion(cmd.SessionID, cmd.RequestID, cmd.Answers); err != nil {
					event := interactionCommandResultEvent("question_response", cmd.SessionID, cmd.RequestID, err)
					if event.Type == "error" {
						logger.Error("resolve question failed", "error", err)
					} else {
						logger.Info("question already resolved", "session", cmd.SessionID, "req", cmd.RequestID)
					}
					client.SendMsg(event)
				}

			case "question_reject":
				if err := sm.RejectQuestion(cmd.SessionID, cmd.RequestID); err != nil {
					event := interactionCommandResultEvent("question_reject", cmd.SessionID, cmd.RequestID, err)
					if event.Type == "error" {
						logger.Error("reject question failed", "error", err)
					} else {
						logger.Info("question already resolved", "session", cmd.SessionID, "req", cmd.RequestID)
					}
					client.SendMsg(event)
				}

			case "mcp_elicitation_response":
				if err := sm.ResolveMcpElicitation(cmd.SessionID, cmd.RequestID, cmd.ElicitationAction, cmd.ElicitationContent); err != nil {
					event := interactionCommandResultEvent("mcp_elicitation_response", cmd.SessionID, cmd.RequestID, err)
					if event.Type == "error" {
						logger.Error("resolve MCP elicitation failed", "session", cmd.SessionID, "req", cmd.RequestID, "error", err)
					} else {
						logger.Info("MCP elicitation already resolved", "session", cmd.SessionID, "req", cmd.RequestID)
					}
					client.SendMsg(event)
				}

			case "interactive_response":
				// Client answered a PTY selection prompt (interactive_prompt card)
				// — e.g. a host PreToolUse hook's "❯1.Yes 2.No" menu that the TUI
				// rendered but never wrote to JSONL. Writes the chosen index back
				// to the PTY so the agent's blocking prompt proceeds.
				logger.Info("interactive response", "session", cmd.SessionID, "req", cmd.RequestID, "choice", cmd.Choice)
				if err := sm.ResolveInteractivePrompt(cmd.SessionID, cmd.RequestID, cmd.Choice); err != nil {
					logger.Error("resolve interactive prompt failed", "error", err)
					client.SendMsg(controlCommandErrorEvent("interactive_response", cmd.SessionID, cmd.RequestID, err))
				}

			default:
				logger.Debug("unknown command", "type", cmd.Type)
			}
		}
	}
}

type daemonRestartPreparer interface {
	PrepareDaemonRestart() error
}

func prepareDaemonRestart(preparer daemonRestartPreparer) error {
	return preparer.PrepareDaemonRestart()
}

func waitForRestartOwnership(readyPath string, timeout time.Duration, acquire func() (io.Closer, error)) (io.Closer, error) {
	if err := os.MkdirAll(filepath.Dir(readyPath), 0o700); err != nil {
		return nil, err
	}
	cleanupRestartHandshake(readyPath)
	defer cleanupRestartHandshake(readyPath)
	heartbeatPath := restartHeartbeatPath(readyPath)
	challengePath := restartChallengePath(readyPath)
	ackPath := restartAckPath(readyPath)
	if err := os.WriteFile(heartbeatPath, []byte(fmt.Sprintf("%d", os.Getpid())), 0o600); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	pidText := fmt.Sprintf("%d", os.Getpid())
	for time.Now().Before(deadline) {
		if daemon.ExplicitStopIntentActive() {
			return nil, fmt.Errorf("explicit stop intent active")
		}
		if lock, err := acquire(); err == nil {
			return lock, nil
		}
		if data, err := os.ReadFile(challengePath); err == nil {
			if challenge := strings.TrimSpace(string(data)); challenge != "" {
				_ = os.WriteFile(ackPath, []byte(pidText+":"+challenge), 0o600)
			}
		}
		_ = os.WriteFile(heartbeatPath, []byte(pidText), 0o600)
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("timed out waiting for previous daemon ownership release")
}

func waitForRestartReady(path string, wantPID int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var firstMod time.Time
	heartbeatPath := restartHeartbeatPath(path)
	challengePath := restartChallengePath(path)
	ackPath := restartAckPath(path)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(heartbeatPath); err == nil && strings.TrimSpace(string(data)) == fmt.Sprintf("%d", wantPID) {
			if info, statErr := os.Stat(heartbeatPath); statErr == nil {
				if firstMod.IsZero() {
					firstMod = info.ModTime()
				} else if info.ModTime().After(firstMod) {
					challengeBytes := make([]byte, 16)
					if _, err := rand.Read(challengeBytes); err != nil {
						return fmt.Errorf("generate restart challenge: %w", err)
					}
					challenge := hex.EncodeToString(challengeBytes)
					_ = os.Remove(ackPath)
					if err := os.WriteFile(challengePath, []byte(challenge), 0o600); err != nil {
						return err
					}
					for time.Now().Before(deadline) {
						data, err := os.ReadFile(ackPath)
						if err == nil && strings.TrimSpace(string(data)) == fmt.Sprintf("%d:%s", wantPID, challenge) {
							if !platform.NewProcessController().IsAlive(wantPID) {
								return fmt.Errorf("replacement pid %d died before readiness acknowledgment", wantPID)
							}
							return nil
						}
						time.Sleep(10 * time.Millisecond)
					}
					return fmt.Errorf("replacement pid %d died before readiness acknowledgment", wantPID)
				}
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	return fmt.Errorf("replacement pid %d did not enter ownership wait", wantPID)
}

func restartHeartbeatPath(base string) string { return base + ".heartbeat" }
func restartChallengePath(base string) string { return base + ".challenge" }
func restartAckPath(base string) string       { return base + ".ack" }

func cleanupRestartHandshake(base string) {
	for _, path := range []string{base, restartHeartbeatPath(base), restartChallengePath(base), restartAckPath(base)} {
		_ = os.Remove(path)
	}
}

func terminateRestartChild(proc *os.Process, handshakeBase string) {
	_ = proc.Kill()
	_, _ = proc.Wait()
	cleanupRestartHandshake(handshakeBase)
}

func restartChildEnv(base []string, readyPath string) []string {
	return replaceEnv(base, "POCKETCTL_RESTART_READY_FILE", readyPath)
}

func consumeRestartReadyEnv() string {
	value := os.Getenv("POCKETCTL_RESTART_READY_FILE")
	_ = os.Unsetenv("POCKETCTL_RESTART_READY_FILE")
	return value
}

func finalizeRestartOwnership(lock io.Closer) (io.Closer, error) {
	if daemon.ExplicitStopIntentActive() {
		_ = lock.Close()
		return nil, fmt.Errorf("explicit stop intent active after ownership claim")
	}
	return lock, nil
}

func replaceEnv(base []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(base)+1)
	for _, item := range base {
		if !strings.HasPrefix(item, prefix) {
			out = append(out, item)
		}
	}
	return append(out, prefix+value)
}

// runAgentUpgrade executes the agent's built-in update command when present
// (e.g. `claude update`, `opencode upgrade`) against the resolved absolute
// binary path, otherwise falls back to `npm install -g <package>@latest`
// (used for codex and any agent without a native updater). Returns combined
// stdout+stderr.
func runAgentUpgrade(ctx context.Context, binPath, updateCmd, pkg string) ([]byte, error) {
	if updateCmd != "" {
		// updateCmd 形如 "claude update"；用解析出的绝对二进制替换裸名，保留子命令。
		parts := strings.Fields(updateCmd)
		args := parts[1:]
		return exec.CommandContext(ctx, binPath, args...).CombinedOutput()
	}
	return exec.CommandContext(ctx, "npm", "install", "-g", pkg+"@latest").CombinedOutput()
}

// isPermissionDenied reports whether an upgrade failure is a write-permission
// problem rather than a real error (network, not-found, etc.). Matched against
// the combined output of `claude update` / `npm install -g`.
func isPermissionDenied(out string) bool {
	s := strings.ToLower(out)
	return strings.Contains(s, "insufficient permissions") ||
		strings.Contains(s, "eacces") ||
		strings.Contains(s, "eperm") ||
		strings.Contains(s, "permission denied")
}

// handleUpgradeAgent upgrades the requested agent via its built-in command (claude update /
// opencode upgrade) or `npm install -g <package>@latest` (codex). Only manageable
// (user-owned) installs are upgraded; a root-owned/system install is reported as
// permission_denied so the UI can prompt the user to upgrade it themselves — pocketctl
// must never perform a native install on the user's behalf. Re-discovers versions,
// pushes a fresh register + upgrade_result event.
// upgradeGateDecision is the pure gating logic for handleUpgradeAgent: given the
// resolution result (found/manageable), it decides whether to proceed with the
// upgrade and, if not, returns the on-wire status/reason/error message.
//   - !found      → not installed (no reason; empty)
//   - !manageable → system (root-owned) install → permission_denied
//   - otherwise   → proceed
func upgradeGateDecision(found, manageable bool, agentName, path string) (proceed bool, status, reason, errMsg string) {
	if !found {
		return false, "failed", "", fmt.Sprintf("%s 未安装", agentName)
	}
	if !manageable {
		return false, "failed", protocol.ReasonPermissionDenied, fmt.Sprintf("%s 为系统(root)安装，pocketctl 无法升级，请自行 sudo-free 升级", path)
	}
	return true, "", "", ""
}

type daemonMessageSender interface {
	SendMsg(any)
	SetAgentVersions(map[string]string)
	SetAgentLatests(map[string]string)
	SetAgentManageable(map[string]bool)
	ResendRegister()
}

func handleUpgradeAgent(client daemonMessageSender, logger *slog.Logger, agent string) {
	agentName := agent
	if agentName == "" {
		agentName = "claude-code"
	}
	if adapter.IsObserverAgent(agentName) {
		client.SendMsg(session.ObserverUpgradeRejectedEvent(agentName, ""))
		return
	}
	cli, err := discovery.AgentTypeToCLI(agentName)
	if err != nil {
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "failed", Error: err.Error()})
		return
	}
	path, manageable, found := discovery.ResolveAgent(cli)
	if proceed, status, reason, errMsg := upgradeGateDecision(found, manageable, agentName, path); !proceed {
		if !found {
			// not installed — no extra log
		} else {
			logger.Warn("agent upgrade refused: system (root-owned) install", "agent", agentName, "path", path)
		}
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: status, Reason: reason, Error: errMsg})
		return
	}

	updateCmd, pkg, err := discovery.AgentUpgradeInfo(agentName)
	if err != nil {
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "failed", Error: err.Error()})
		return
	}
	oldVer := ""
	for _, a := range discovery.DiscoverAgents() {
		if a.Type == agentName {
			oldVer = a.Version
		}
	}
	logger.Info("agent upgrade start", "agent", agentName, "old_version", oldVer, "path", path, "cmd", updateCmd)

	upCtx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	out, err := runAgentUpgrade(upCtx, path, updateCmd, pkg)
	if err != nil {
		reason := ""
		if isPermissionDenied(string(out)) {
			reason = protocol.ReasonPermissionDenied
		}
		logger.Error("agent upgrade failed", "agent", agentName, "error", err, "output", string(out))
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "failed", Reason: reason, Error: fmt.Sprintf("%v: %s", err, strings.TrimSpace(string(out)))})
		return
	}

	agentVersions := make(map[string]string)
	agentLatests := make(map[string]string)
	agentManageable := make(map[string]bool)
	newVer := ""
	for _, a := range discovery.DiscoverAgents() {
		if a.Version != "" {
			agentVersions[a.Type] = a.Version
		}
		if a.Latest != "" {
			agentLatests[a.Type] = a.Latest
		}
		agentManageable[a.Type] = a.Manageable
		if a.Type == agentName {
			newVer = a.Version
		}
	}
	client.SetAgentVersions(agentVersions)
	client.SetAgentLatests(agentLatests)
	client.SetAgentManageable(agentManageable)
	client.ResendRegister()
	client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "success", Message: newVer})
	logger.Info("agent upgrade done", "agent", agentName, "old", oldVer, "new", newVer)
}

// readJSONLLines reads up to maxLines from a JSONL file and returns them as a slice.
// classifyCreateError maps a CreateSession error message to a reason code
// for the session_create_failed event (no_cli, bad_cwd, start_fail).
// classifyCreateError maps a CreateSession error message to a reason code
// for the session_create_failed event (no_cli, bad_cwd, cwd_in_use, start_fail).
func classifyCreateError(msg string) string {
	if strings.Contains(msg, "cwd_not_authorized") {
		return "cwd_not_authorized"
	}
	if strings.Contains(msg, adapter.ErrUnsupportedAgent.Error()) {
		return "unsupported_agent"
	}
	if strings.Contains(msg, "agent CLI not found") {
		return "no_cli"
	}
	if strings.HasPrefix(msg, "目录已被占用") {
		return "cwd_in_use"
	}
	if strings.HasPrefix(msg, "工作目录") {
		return "bad_cwd"
	}
	if strings.Contains(msg, "start process") || strings.Contains(msg, "stdout pipe") {
		return "start_fail"
	}
	return "start_fail"
}

func readJSONLLines(path string, maxLines int) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for i := 0; i < maxLines && scanner.Scan(); i++ {
		lines = append(lines, scanner.Text())
	}
	return lines
}

// ---------- daemon update ----------

func cmdDaemonUpdate(args []string) {
	fs := flag.NewFlagSet("daemon update", flag.ExitOnError)
	versionFlag := fs.String("version", "", "Specific version to update to (e.g. v0.1.0, default: latest)")
	noRestart := fs.Bool("no-restart", false, "Download and replace binary without restarting daemon")
	fs.Parse(args)

	fmt.Println()
	fmt.Println(i18n.T("update.title"))
	fmt.Println(strings.Repeat("─", 40))
	fmt.Println(i18n.T("update.current", version))
	fmt.Println(i18n.T("update.platform", runtime.GOOS, runtime.GOARCH))

	// 1. Check latest version
	var tag string
	var err error
	if *versionFlag != "" {
		fmt.Println(i18n.T("update.pinned", *versionFlag))
		tag, err = update.CheckVersion(*versionFlag)
	} else {
		fmt.Println(i18n.T("update.query"))
		tag, err = update.CheckLatest()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("update.query_fail", err))
		os.Exit(1)
	}

	fmt.Println(i18n.T("update.target", tag))

	// Strip 'v' prefix for comparison
	currentVer := strings.TrimPrefix(version, "v")
	targetVer := strings.TrimPrefix(tag, "v")

	if *versionFlag == "" && currentVer == targetVer {
		fmt.Println()
		fmt.Println(i18n.T("update.already_latest"))
		return
	}

	// 2. Resolve binary + checksum
	fmt.Println()
	fmt.Println(i18n.T("update.resolving"))
	binInfo, err := update.ResolveBinary(tag)
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("update.resolve_fail", err))
		os.Exit(1)
	}
	fmt.Println(i18n.T("update.download_name", binInfo.Name))
	if binInfo.SHA != "" {
		fmt.Println(i18n.T("update.checksum", binInfo.SHA[:16], binInfo.SHA[len(binInfo.SHA)-16:]))
	}

	// 3. Download
	fmt.Println()
	fmt.Println(i18n.T("update.downloading"))
	tmpPath, err := update.DownloadAndVerify(binInfo)
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("update.download_fail", err))
		os.Exit(1)
	}
	fmt.Println(i18n.T("update.download_ok"))

	// 4. Replace binary
	fmt.Println()
	fmt.Println(i18n.T("update.replacing"))
	if err := update.ReplaceBinary(tmpPath); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("update.replace_fail", err))
		fmt.Println()
		fmt.Println(i18n.T("update.permission_hint"))
		fmt.Printf("     sudo pocketctl daemon update")
		if *versionFlag != "" {
			fmt.Printf(" --version %s", *versionFlag)
		}
		fmt.Println()
		os.Exit(1)
	}
	fmt.Println(i18n.T("update.replaced"))

	// 5. Restart daemon (unless --no-restart)
	if !*noRestart {
		fmt.Println()
		fmt.Println(i18n.T("update.check_daemon"))
		if err := update.RestartDaemon(); err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("update.restart_fail", err))
		}
	}

	fmt.Println()
	fmt.Println(strings.Repeat("─", 40))
	fmt.Println(i18n.T("update.done"))
	fmt.Println(i18n.T("update.version_change", version, tag))
	fmt.Println()
}

func persistDaemonSecurityPolicy(
	policy *session.CwdPolicy,
	allowDangerousRemotePermissions bool,
	trustedActionPolicy string,
) error {
	return config.SaveDaemonSecurityPolicy(config.DaemonSecurityPolicy{
		AllowedCwdRoots:                 policy.Roots(),
		AllowDangerousRemotePermissions: allowDangerousRemotePermissions,
		TrustedActionPolicy:             trustedActionPolicy,
	})
}

// multiFlag collects a repeatable string flag (e.g. --allowed-cwd-root).
type multiFlag []string

func (m *multiFlag) String() string { return strings.Join(*m, ",") }

func (m *multiFlag) Set(v string) error {
	*m = append(*m, v)
	return nil
}
