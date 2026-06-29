package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/api"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/commands"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/notify"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/service"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/sysinfo"
	"github.com/pocketctl/pocketctl/internal/update"
	"github.com/pocketctl/pocketctl/internal/watcher"
	"github.com/pocketctl/pocketctl/internal/ws"
)

var version = "0.2.20"

// DefaultRelayURL is the public production relay used when no --relay flag,
// --prod config, or POCKETCTL_RELAY_URL env is provided. To target a local or
// self-hosted relay instead, override with --relay <url> (see `pocketctl help`).
const DefaultRelayURL = "wss://www.pocketctl.me/ws"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
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
	fs.Parse(args)

	// A token must already be stored — the supervised daemon resolves it from
	// config at launch, exactly like `daemon start`. Fail fast with a clear
	// message rather than installing a unit that will crash-loop on missing auth.
	if tok, err := config.LoadToken(); err != nil || tok == "" {
		fmt.Fprintln(os.Stderr, i18n.T("service.no_token"))
		os.Exit(1)
	}

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
	daemonArgs := []string{"daemon", "start", "--foreground"}
	if *production {
		daemonArgs = append(daemonArgs, "--prod")
	}
	if *relayURL != "" {
		daemonArgs = append(daemonArgs, "--relay", *relayURL)
	}

	// Ensure the log dir exists; launchd/systemd open the boot log but won't
	// create its parent directory.
	_ = os.MkdirAll(daemon.LogDir(), 0755)
	cfg := service.Config{ExePath: exe, Args: daemonArgs, LogPath: daemon.ServiceBootLogPath()}

	// If the daemon is already running standalone, stop it so it doesn't fight
	// the supervised instance for the relay registration / approval socket.
	if pid, running := daemon.IsRunning(); running {
		fmt.Println(i18n.T("service.stopping_standalone", pid))
		_ = daemon.Stop()
	}

	if err := service.Install(cfg); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("service.install_fail", err))
		os.Exit(1)
	}
	fmt.Println(i18n.T("service.installed", strings.Join(append([]string{filepath.Base(exe)}, daemonArgs...), " ")))
	info, _ := service.Status()
	if info.UnitPath != "" {
		fmt.Println(i18n.T("service.unit_path", info.UnitPath))
	}
	if runtime.GOOS == "linux" {
		fmt.Println(i18n.T("service.linger_note"))
	}
}

func cmdServiceUninstall() {
	if err := service.Uninstall(); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("service.uninstall_fail", err))
		os.Exit(1)
	}
	fmt.Println(i18n.T("service.uninstalled"))
}

func cmdServiceStatus() {
	info, err := service.Status()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("service.status_fail", err))
		os.Exit(1)
	}
	installed := i18n.T("service.no")
	if info.Installed {
		installed = i18n.T("service.yes")
	}
	running := i18n.T("service.no")
	if info.Running {
		running = i18n.T("service.yes")
	}
	fmt.Println(i18n.T("service.status_installed", installed))
	fmt.Println(i18n.T("service.status_running", running))
	if info.UnitPath != "" {
		fmt.Println(i18n.T("service.unit_path", info.UnitPath))
	}
	if info.Detail != "" {
		fmt.Println(i18n.T("service.status_detail", info.Detail))
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

	home, _ := os.UserHomeDir()
	if home != "" {
		targets = append(targets, removeTarget{
			filepath.Join(home, ".pocketctl"),
			i18n.T("uninstall.desc_config"),
		})
	}
	targets = append(targets, removeTarget{
		"/tmp/pocketctl",
		i18n.T("uninstall.desc_runtime"),
	})

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
	if pid, running := daemon.IsRunning(); running {
		fmt.Println(i18n.T("uninstall.stopping_daemon", pid))
		if err := daemon.Stop(); err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("uninstall.stop_fail", err))
		} else {
			fmt.Println(i18n.T("daemon.stopped"))
		}
	}

	// 2. Remove data/config directories.
	for _, t := range targets {
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

// canOpenBrowser checks if the current environment can open a browser.
func canOpenBrowser() bool {
	if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
		return true
	}
	if runtime.GOOS == "darwin" && os.Getenv("SSH_TTY") == "" {
		return true
	}
	// WSL: cmd.exe can hand off to the Windows host browser
	if runtime.GOOS == "linux" && isWSL() {
		if _, err := exec.LookPath("cmd.exe"); err == nil {
			return true
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

	// Open browser
	fmt.Println(i18n.T("login.opening_browser"))
	fmt.Println(i18n.T("login.manual_open"))
	fmt.Printf("  %s\n\n", authResp.VerificationURIComplete)

	openBrowser(authResp.VerificationURIComplete)

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

// openBrowser opens the given URL in the default browser.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		// WSL: prefer cmd.exe (hands off to Windows host browser)
		if isWSL() {
			if p, err := exec.LookPath("cmd.exe"); err == nil {
				cmd = exec.Command(p, "/c", "start", "", url)
				break
			}
		}
		// wslview (from wslu package)
		if _, err := exec.LookPath("wslview"); err == nil {
			cmd = exec.Command("wslview", url)
			break
		}
		cmd = exec.Command("xdg-open", url)
	default:
		return
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: failed to open browser: %v\n", err)
	}
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
	if err := api.SendEmailCode(apiURL, email); err != nil {
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
	return api.VerifyEmailCode(apiURL, email, code)
}

// ---------- daemon start (continued) ----------

func cmdDaemonStart(args []string) {
	fs := flag.NewFlagSet("daemon start", flag.ExitOnError)
	relayURL := fs.String("relay", "", "Relay WebSocket URL (or POCKETCTL_RELAY_URL env)")
	production := fs.Bool("prod", false, "Use production relay (reads prod_relay_url from config)")
	token := fs.String("token", "", "JWT token (or POCKETCTL_TOKEN env)")
	daemonID := fs.String("id", "", "Daemon ID (auto-generated if empty)")
	foreground := fs.Bool("foreground", false, "Run in foreground (don't daemonize)")
	debug := fs.Bool("debug", false, "Verbose debug logging; with --foreground also streams logs to the console")
	fs.Parse(args)

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

	// Check if already running
	if pid, running := daemon.IsRunning(); running {
		fmt.Println(i18n.T("daemon.already_running", pid))
		os.Exit(0)
	}

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
		child := &exec.Cmd{
			Path:   exe,
			Args:   os.Args,
			Env:    childEnv,
			Stdin:  nil,
			Stdout: nil,
			Stderr: nil,
			SysProcAttr: &syscall.SysProcAttr{
				Setsid: true,
			},
		}
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, i18n.T("error.daemonize", err))
			os.Exit(1)
		}
		// Print startup banner from the launcher so the user sees it immediately.
		// The child's stdout is nil (detached), so only the launcher can write here.
		fmt.Println(i18n.T("daemon.started", preForkID, child.Process.Pid))
		fmt.Println(i18n.T("daemon.relay", url))
		fmt.Println(i18n.T("daemon.logs", daemon.LogPath()))
		os.Exit(0)
	}

	// Generate daemon ID — prefer the value passed by the launcher via env (set
	// above) so both processes always use the same ID without re-deriving.
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

	// Persist daemon_id immediately so the next start always reads the same ID,
	// even if the process is killed before the relay connection fires OnStateChange.
	_ = daemon.WriteState(&daemon.DaemonState{
		DaemonID: id,
		RelayURL: url,
		PID:      os.Getpid(),
	})

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
	if err := daemon.WritePID(os.Getpid()); err != nil {
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
	sm := session.NewSessionManager(outputCh)

	// Start the in-process approval broker. The PreToolUse hook connects here
	// to surface tool-use approvals to web/iOS clients. The socket lives at a
	// user-global fixed path (config.ApprovalSocketPath) so that a `claude`
	// process the user launched in their OWN terminal can reach this daemon —
	// not just daemon-spawned sessions. Failures are non-fatal: sessions simply
	// won't get approval prompts (they still default to bypassPermissions).
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

			// Install the user-global PreToolUse hook into ~/.claude/settings.json
			// so EVERY `claude` invocation (including ones the user starts in their
			// own terminal) routes permission prompts here. Idempotent; cleaned up
			// on shutdown via RemoveUserHook so we don't leave a dangling entry.
			if err := approval.EnsureUserHook(pocketctlPath); err != nil {
				logger.Warn("user-global approval hook not installed", "error", err)
			} else {
				logger.Info("user-global approval hook installed", "settings", "~/.claude/settings.json")
			}
			defer approval.RemoveUserHook()
		}
	}

	// When a daemon-created session resolves its real ID, wait for assistant
	// reply then send generate_title_request to relay for LLM-based title generation.
	sm.OnSessionIDResolved = func(realSessionID, cwd string) {
		daemon.Go("title-resolve", logger, func() {
			for i := 0; i < 30; i++ {
				time.Sleep(1 * time.Second)
				jsonlPath, err := watcher.ResolveJSONLPath(realSessionID, cwd)
				if err != nil {
					continue
				}
				if _, err := os.Stat(jsonlPath); err != nil {
					continue // file not created yet
				}
				// Read lines looking for both user and assistant messages
				lines := readJSONLLines(jsonlPath, 500)
				userMsg := adapter.ExtractFirstUserMessage(lines, 200)
				assistantMsg := adapter.ExtractFirstAssistantMessage(lines, 200)
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
	client.SetAgentManageable(agentManageable)
	client.SetVersion(version)
	client.SetStartedAt(time.Now().Unix())

	// Start system metrics collector
	sysinfo.Start()
	defer sysinfo.Stop()
	client.SetMetricsFn(func() (float64, float64, float64) {
		m := sysinfo.Get()
		return m.CpuPct, m.MemPct, m.DiskPct
	})
	// Seed this daemon's active session IDs into the register message so the
	// relay can rebuild its session→daemon routing table synchronously on
	// (re)connection, before any session_discovered events arrive.
	client.SetActiveSessionIDsFn(func() []string {
		sessions := sm.ListSessions()
		ids := make([]string, 0, len(sessions))
		for _, s := range sessions {
			ids = append(ids, s.SessionID)
		}
		return ids
	})

	// Dirty flag for state persistence — only write when changed
	var stateDirty atomic.Bool

	// Re-sync sessions after (re)connection
	client.OnReconnected = func() {
		count := len(sm.ListSessions())
		logger.Info(fmt.Sprintf("resyncing %d sessions after reconnect", count))
		for _, s := range sm.ListSessions() {
			client.SendMsg(protocol.DaemonEvent{
				Type:      "session_discovered",
				SessionID: s.SessionID,
				Cwd:       s.Cwd,
				Status:    s.Status,
				Source:    "terminal",
			})
		}
		logger.Info("resync done")
	}

	// Connection state tracking
	client.OnStateChange = func(connected bool) {
		stateDirty.Store(true)
		state := &daemon.DaemonState{
			DaemonID:  id,
			RelayURL:  url,
			Connected: connected,
			StartedAt: time.Now(),
			PID:       os.Getpid(),
		}
		if err := daemon.WriteState(state); err != nil {
			logger.Error("write state", "error", err)
		}
		if connected {
			logger.Info("connected to relay")
		} else {
			logger.Warn("disconnected from relay")
		}
	}

	// Detect runtime model switches: every outgoing agent_text event now carries
	// the model Claude actually used (filled by the adapters). When it differs
	// from the session's cached model, update the cache and emit a
	// session_model_changed event so the relay + Web/iOS clients reflect the
	// /model switch in real time.
	client.OnEvent = func(evt protocol.DaemonEvent) []protocol.DaemonEvent {
		if evt.Type != "agent_text" || evt.Model == "" || evt.SessionID == "" {
			return []protocol.DaemonEvent{evt}
		}
		current, _ := sm.GetSessionModel(evt.SessionID)
		if evt.Model == current {
			return []protocol.DaemonEvent{evt}
		}
		sm.SetSessionModel(evt.SessionID, evt.Model)
		logger.Info("session model changed", "session", evt.SessionID, "model", evt.Model, "prev", current)
		// Forward the original agent_text, then the derived change notification.
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

	// Context with signal handling
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Start session watcher (Claude terminal sessions)
	if err := sw.Start(ctx); err != nil {
		logger.Error("start session watcher", "error", err)
		os.Exit(1)
	}

	// Start codex terminal-session watcher (CODEX_HOME-aware rollout discovery).
	// Non-fatal: a host without codex just yields no events.
	cw := watcher.NewCodexSessionWatcher()
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
		handleCommands(ctx, client, sm, logger, &stateDirty)
	})

	// Periodic state update — only writes when stateDirty is true
	daemon.RunLoop(ctx, "state-persist", logger, func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !stateDirty.Load() {
					continue
				}
				stateDirty.Store(false)
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
				state := &daemon.DaemonState{
					DaemonID:  id,
					RelayURL:  url,
					Connected: true,
					StartedAt: time.Now(),
					PID:       os.Getpid(),
					Sessions:  stateSessions,
				}
				daemon.WriteState(state)
			}
		}
	})

	fmt.Println(i18n.T("daemon.started", id, os.Getpid()))
	fmt.Println(i18n.T("daemon.version", version))
	fmt.Println(i18n.T("daemon.relay", url))
	fmt.Println(i18n.T("daemon.agents", strings.Join(agentTypes, ", ")))
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
	<-sigCh
	logger.Info("shutting down")
	fmt.Println(i18n.T("daemon.shutting_down"))
	// Stop the shared opencode serve process (bound to its own context, not the
	// daemon ctx) so it doesn't linger and race the next daemon's serve on the
	// shared SQLite DB.
	sm.ShutdownOpencode()
	cancel()
	time.Sleep(500 * time.Millisecond)
}

// ---------- daemon stop ----------

func cmdDaemonStop() {
	if err := daemon.Stop(); err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("error.generic", err))
		os.Exit(1)
	}
	fmt.Println(i18n.T("daemon.stopped"))
}

// ---------- daemon status ----------

func cmdDaemonStatus() {
	pid, running := daemon.IsRunning()
	if !running {
		fmt.Println(i18n.T("daemon.not_running"))
		return
	}

	state, err := daemon.ReadState()
	if err != nil {
		fmt.Println(i18n.T("daemon.running_no_state", pid))
		return
	}

	fmt.Println(i18n.T("status.daemon", state.DaemonID))
	fmt.Println(i18n.T("status.pid", state.PID))
	fmt.Println(i18n.T("status.relay", state.RelayURL))
	conn := map[bool]string{true: i18n.T("status.connected"), false: i18n.T("status.disconnected")}[state.Connected]
	fmt.Println(i18n.T("status.status_line", conn))
	fmt.Println(i18n.T("status.started", state.StartedAt.Format(time.RFC3339)))

	if len(state.Sessions) > 0 {
		fmt.Println(i18n.T("status.sessions", len(state.Sessions)))
		for _, s := range state.Sessions {
			fmt.Println(i18n.T("status.session_row", s.SessionID[:8], s.Status, s.Cwd))
		}
	}
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
		wsURL += "?token=" + accessToken + "&type=daemon"

		wsConn, _, wsErr := websocket.DefaultDialer.Dial(wsURL, nil)
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
			case "discovered":
				logger.Info("session discovered", "session", evt.Session.SessionID, "pid", evt.Session.Pid)
				registered := sm.RegisterTerminalSession(evt.Session.SessionID, evt.Session.Cwd, evt.Session.Pid, "", evt.Session.Status)
				// Register with process monitor
				if evt.Session.Pid > 0 {
					pm.Register(evt.Session.Pid, evt.Session.SessionID)
				}
				// Try to get TTY for notifications
				if evt.Session.Pid > 0 {
					if ttyPath, err := notify.GetTTYForPID(evt.Session.Pid); err == nil {
						// Update TTY info (returns false if already registered, that is fine)
						sm.RegisterTerminalSession(evt.Session.SessionID, evt.Session.Cwd, evt.Session.Pid, ttyPath, evt.Session.Status)
					}
				}
				// Only start JSONL tailer if this is a genuinely new session
				if !registered {
					logger.Debug("session already known, skipping tailer", "session", evt.Session.SessionID)
					// Re-discovered (e.g. --continue): tailer already running on same JSONL,
					// but emit session_status so relay/DB updates from "exited" → current status.
					sm.SetSessionStatus(evt.Session.SessionID, evt.Session.Status)
					break
				}
				// Start JSONL tailer from beginning to replay history and tail new events.
				// Supervised via RunLoop: if the tail loop ever panics it restarts (the
				// tailer tracks its own offset, so a restart resumes safely) rather than
				// silently dying and leaving the session — including a later --continue
				// resume — with no message forwarding.
				daemon.RunLoop(ctx, "tailer:"+evt.Session.SessionID, logger, func() {
					var tailer *watcher.JSONLTailer
					// Retry: the agent may not have created the JSONL file yet
					for retry := 0; retry < 30; retry++ {
						jsonlPath, err := adapter.ResolveJSONLPathFor(agentType, evt.Session.SessionID, evt.Session.Cwd)
						if err == nil {
							tailer, err = watcher.NewJSONLTailerFromStart(jsonlPath, agentType)
							if err == nil {
								// Associate tailer with session so sendToIdleTerminal can pause/resume it (D2)
								sm.SetTailer(evt.Session.SessionID, tailer)
								// Tailer started successfully — now emit session_discovered
								outputCh <- protocol.DaemonEvent{
									Type:      "session_discovered",
									SessionID: evt.Session.SessionID,
									Cwd:       evt.Session.Cwd,
									Status:    evt.Session.Status,
									Source:    "terminal",
									Agent:     agentType,
								}
								break
							}
						}
						time.Sleep(2 * time.Second)
					}
					if tailer == nil {
						logger.Error("tailer start failed after retries", "session", evt.Session.SessionID)
						return
					}
					defer tailer.Close()

					// Set default title immediately
					sid := evt.Session.SessionID
					if len(sid) > 8 {
						sid = sid[len(sid)-8:]
					}
					sm.UpdateSessionTitle(evt.Session.SessionID, "Terminal Session-"+sid)

					// Track whether title generation request has been sent
					titleGenSent := false

					// Tail loop: send parsed events with session_id stamped
					ticker := time.NewTicker(1 * time.Second)
					defer ticker.Stop()
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
							// Update last activity when events are received from terminal session
							if len(events) > 0 {
								sm.UpdateLastActivity(evt.Session.SessionID)
							}
							for i := range events {
								if events[i].SessionID == "" {
									events[i].SessionID = evt.Session.SessionID
								}
								outputCh <- events[i]
							}
							// Check for title generation trigger (user + assistant messages ready)
							if !titleGenSent && len(rawLines) > 0 {
								userMsg := adapter.ExtractFirstUserMessage(rawLines, 200)
								assistantMsg := adapter.ExtractFirstAssistantMessage(rawLines, 200)
								if userMsg != "" && assistantMsg != "" {
									sm.GenerateTitle(evt.Session.SessionID, userMsg, assistantMsg)
									titleGenSent = true
								}
							}
						}
					}
				})

			case "changed":
				logger.Debug("session changed", "session", evt.Session.SessionID, "status", evt.Session.Status)
				sm.SetSessionStatus(evt.Session.SessionID, evt.Session.Status)

			case "removed":
				logger.Info("session removed", "session", evt.Session.SessionID)
				sm.SetSessionExited(evt.Session.SessionID, protocol.ExitReasonNormalExit)
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

func handleCommands(ctx context.Context, client *ws.Client, sm *session.SessionManager, logger *slog.Logger, stateDirty *atomic.Bool) {
	for {
		select {
		case <-ctx.Done():
			return
		case cmd := <-client.CommandCh:
			switch cmd.Type {
			case "session_create":
				logger.Info("create session", "agent", cmd.Agent, "cwd", cmd.Cwd, "model", cmd.Model,
					"worktree", cmd.Worktree, "auto_create_dir", cmd.AutoCreateDir, "force", cmd.Force)
				stateDirty.Store(true)
				config := protocol.SessionConfig{
					Agent:          cmd.Agent,
					Cwd:            cmd.Cwd,
					Prompt:         cmd.Prompt,
					PermissionMode: cmd.PermissionMode,
					Model:          cmd.Model,
					Worktree:       cmd.Worktree,
					AutoCreateDir:  cmd.AutoCreateDir,
					Force:          cmd.Force,
				}
				if config.Agent == "" {
					config.Agent = "claude-code"
				}
				sessionID, err := sm.CreateSession(ctx, config)
				if err != nil {
					logger.Error("create session failed", "error", err)
					reason := classifyCreateError(err.Error())
					client.SendMsg(protocol.DaemonEvent{
						Type:   "session_create_failed",
						Reason: reason,
						Error:  err.Error(),
					})
					continue
				}
				logger.Info("session created", "session", sessionID)

				// Notify relay that session was created so it can link the originating client.
				// Carry the resolved model so the web client can show it (/model command).
				model, _ := sm.GetSessionModel(sessionID)
				evt := protocol.DaemonEvent{
					Type:      "session_created",
					SessionID: sessionID,
					Title:     config.Prompt,
					Model:     model,
				}
				// Scheme D: surface the worktree path/branch so clients can show it.
				if wt, branch, ok := sm.GetWorktreeInfo(sessionID); ok {
					evt.WorktreePath = wt
					evt.WorktreeBranch = branch
				}
				// Scheme A: let the client know how many sessions now share this cwd.
				if cwd, ok := sm.GetSessionCwd(sessionID); ok {
					evt.CwdSessions = sm.CwdSessionCount(cwd)
				}
				client.SendMsg(evt)

			case "abort_create":
				logger.Info("abort create session", "session", cmd.SessionID)
				if cmd.SessionID != "" {
					sm.AbortSession(cmd.SessionID)
				}

			case "daemon_restart":
				logger.Info("daemon restart requested")
				daemon.Go("daemon-restart", logger, func() {
					time.Sleep(500 * time.Millisecond) // allow ack to send
					// Fork+exec: spawn a new daemon process before exiting
					exe, err := os.Executable()
					if err != nil {
						logger.Error("daemon restart failed: get executable", "error", err)
						return
					}
					cmd := exec.Command(exe, os.Args[1:]...)
					cmd.Stdout = nil
					cmd.Stderr = nil
					cmd.Stdin = nil
					cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
					if err := cmd.Start(); err != nil {
						logger.Error("daemon restart failed: spawn", "error", err)
						return
					}
					logger.Info("new daemon spawned, exiting", "newPID", cmd.Process.Pid)
					os.Exit(0)
				})

			case "user_message":
				logger.Info("user message", "session", cmd.SessionID)
				stateDirty.Store(true)
				if err := sm.SendMessage(ctx, cmd.SessionID, cmd.Content); err != nil {
					logger.Error("send message failed", "error", err)
					client.SendMsg(protocol.DaemonEvent{
						Type: "error", SessionID: cmd.SessionID, Error: err.Error(),
					})
				}

			case "session_kill":
				logger.Info("kill session", "session", cmd.SessionID)
				stateDirty.Store(true)
				if err := sm.KillSession(cmd.SessionID); err != nil {
					logger.Error("kill session failed", "error", err)
				}

			case "session_interrupt":
				logger.Info("interrupt session", "session", cmd.SessionID)
				if err := sm.InterruptSession(cmd.SessionID); err != nil {
					logger.Error("interrupt session failed", "error", err)
				}

			case "set_permission_mode":
				logger.Info("set permission mode", "session", cmd.SessionID, "mode", cmd.Content)
				agentType, _ := sm.GetSessionAgent(cmd.SessionID)
				if !adapter.Capabilities(agentType).SupportsPermissionCycle {
					client.SendMsg(protocol.DaemonEvent{
						Type:      "error",
						SessionID: cmd.SessionID,
						Error:     "permission mode switching is not supported for " + agentType,
					})
					continue
				}
				if err := sm.SetPermissionMode(ctx, cmd.SessionID, cmd.Content); err != nil {
					logger.Error("set permission mode failed", "error", err)
					client.SendMsg(protocol.DaemonEvent{
						Type:      "error",
						SessionID: cmd.SessionID,
						Error:     err.Error(),
					})
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
					client.SendMsg(protocol.DaemonEvent{
						Type:      "error",
						SessionID: cmd.SessionID,
						Error:     err.Error(),
					})
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
				client.SendMsg(protocol.DaemonEvent{
					Type:      "command_list",
					SessionID: cmd.SessionID,
					Commands:  commands.ListCommands(cwd, agentType, available),
				})

			case "get_session_meta":
				// Web client queries a session's resolved model (for the /model
				// command). Unlike session_created (one-shot, fired before the web
				// subscribes), this is a request/response the client issues on mount.
				agentType, _ := sm.GetSessionAgent(cmd.SessionID)
				storage := adapter.NewStorage(agentType)
				model, exists := sm.GetSessionModel(cmd.SessionID)
				if model == "" && agentType == adapter.AgentOpencode {
					// opencode terminal sessions carry no model at discovery and have no
					// claude-style JSONL; fetch the model from the serve instead.
					model = sm.OpencodeSessionModelFromServe(cmd.SessionID)
				}
				if model == "" && agentType != adapter.AgentOpencode {
					// Terminal sessions don't carry a model at discovery time — extract
					// it from the JSONL history (last real assistant message) and cache.
					cwd, cwdOk := sm.GetSessionCwd(cmd.SessionID)
					if !cwdOk {
						logger.Info("get_session_meta: not in memory", "session", cmd.SessionID, "exists", exists)
					} else if path, perr := storage.ResolveJSONLPath(cmd.SessionID, cwd); perr != nil {
						logger.Info("get_session_meta: resolve path failed", "session", cmd.SessionID, "cwd", cwd, "error", perr)
					} else if data, ferr := os.ReadFile(path); ferr != nil {
						logger.Info("get_session_meta: read jsonl failed", "session", cmd.SessionID, "path", path, "error", ferr)
					} else {
						lines := strings.Split(string(data), "\n")
						m := storage.ExtractModel(lines)
						logger.Info("get_session_meta: extracted", "session", cmd.SessionID, "lines", len(lines), "model", m)
						if m != "" {
							sm.SetSessionModel(cmd.SessionID, m)
							model = m
						}
					}
				}
				logger.Info("get_session_meta", "session", cmd.SessionID, "model", model)
				client.SendMsg(protocol.DaemonEvent{
					Type:      "session_meta",
					SessionID: cmd.SessionID,
					Model:     model,
					Effort:    sm.GetSessionEffort(cmd.SessionID),
				})

			case "list_models":
				// Web client queries the host's available models to populate the
				// session-creation picker. Claude reads ~/.claude/settings.json;
				// codex returns its own model list.
				client.SendMsg(protocol.DaemonEvent{
					Type:   "model_list",
					Models: sm.ModelsForAgent(cmd.Agent),
				})

			case "upgrade_agent":
				daemon.Go("upgrade-agent", logger, func() { handleUpgradeAgent(client, logger, cmd.Agent) })

			case "approval_response":
				// Client answered a tool-use approval request (Yes/No). Resolves
				// the blocked PreToolUse hook so Claude proceeds (allow) or is
				// told to stop (deny).
				logger.Info("approval response", "session", cmd.SessionID, "req", cmd.RequestID, "approved", cmd.Approved)
				if err := sm.ResolveApproval(cmd.SessionID, cmd.RequestID, cmd.Approved); err != nil {
					logger.Error("resolve approval failed", "error", err)
					client.SendMsg(protocol.DaemonEvent{
						Type:      "error",
						SessionID: cmd.SessionID,
						Error:     err.Error(),
					})
				}

			case "interactive_response":
				// Client answered a PTY selection prompt (interactive_prompt card)
				// — e.g. a host PreToolUse hook's "❯1.Yes 2.No" menu that the TUI
				// rendered but never wrote to JSONL. Writes the chosen index back
				// to the PTY so the agent's blocking prompt proceeds.
				logger.Info("interactive response", "session", cmd.SessionID, "req", cmd.RequestID, "choice", cmd.Choice)
				if err := sm.ResolveInteractivePrompt(cmd.SessionID, cmd.RequestID, cmd.Choice); err != nil {
					logger.Error("resolve interactive prompt failed", "error", err)
					client.SendMsg(protocol.DaemonEvent{
						Type:      "error",
						SessionID: cmd.SessionID,
						Error:     err.Error(),
					})
				}

			default:
				logger.Debug("unknown command", "type", cmd.Type)
			}
		}
	}
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

func handleUpgradeAgent(client *ws.Client, logger *slog.Logger, agent string) {
	agentName := agent
	if agentName == "" {
		agentName = "claude-code"
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
