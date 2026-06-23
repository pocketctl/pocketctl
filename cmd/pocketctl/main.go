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
	"github.com/pocketctl/pocketctl/internal/commands"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/notify"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/sysinfo"
	"github.com/pocketctl/pocketctl/internal/update"
	"github.com/pocketctl/pocketctl/internal/watcher"
	"github.com/pocketctl/pocketctl/internal/ws"
)

var version = "0.2.9"

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
	case "version":
		fmt.Println("pocketctl", version)
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
	default:
		fmt.Fprintln(os.Stderr, i18n.T("daemon.unknown_sub", args[0]))
		os.Exit(1)
	}
}

// ---------- daemon start ----------

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
	if _, err := exec.LookPath("open"); err == nil {
		return true
	}
	if _, err := exec.LookPath("xdg-open"); err == nil {
		return true
	}
	return false
}

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
		cmd = exec.Command("xdg-open", url)
	default:
		return
	}
	cmd.Start()
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
	fs.Parse(args)

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

	// Generate daemon ID — reuse persisted ID, or derive from machine hardware
	id := *daemonID
	if id == "" {
		if existing, err := daemon.ReadState(); err == nil && existing.DaemonID != "" {
			id = existing.DaemonID
		}
		if id == "" {
			id = daemon.MachineID()
		}
	}

	// Setup logging to file
	os.MkdirAll(filepath.Dir(daemon.LogPath()), 0755) // ensure /tmp/pocketctl exists
	logFlags := os.O_CREATE | os.O_WRONLY
	if os.Getenv("POCKETCTL_DAEMON_CHILD") == "1" {
		logFlags |= os.O_APPEND // child appends after parent's startup message
	} else {
		logFlags |= os.O_TRUNC
	}
	logFile, err := os.OpenFile(daemon.LogPath(), logFlags, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open log file: %v\n", err)
		os.Exit(1)
	}
	defer logFile.Close()

	logger := slog.New(slog.NewJSONHandler(logFile, &slog.HandlerOptions{Level: slog.LevelInfo}))
	logger.Info("starting daemon", "version", version, "id", id, "relay", url)

	// Write PID file
	if err := daemon.WritePID(os.Getpid()); err != nil {
		logger.Error("write pid", "error", err)
		os.Exit(1)
	}
	defer os.Remove(daemon.PIDPath())

	// Discover agents
	agents := discovery.DiscoverAgents()
	agentTypes := make([]string, 0, len(agents))
	agentVersions := make(map[string]string)
	agentLatests := make(map[string]string)
	for _, a := range agents {
		agentTypes = append(agentTypes, a.Type)
		if a.Version != "" {
			agentVersions[a.Type] = a.Version
		}
		if a.Latest != "" {
			agentLatests[a.Type] = a.Latest
		}
		logger.Info("discovered agent", "type", a.Type, "path", a.Path, "version", a.Version, "latest", a.Latest)
	}
	if len(agentTypes) == 0 {
		agentTypes = []string{"claude-code"} // default
		logger.Warn("no agents discovered, defaulting to claude-code")
	}

	// Create shared event channel
	outputCh := make(chan protocol.DaemonEvent, 256)

	// Create session manager
	sm := session.NewSessionManager(outputCh)

	// When a daemon-created session resolves its real ID, wait for assistant
	// reply then send generate_title_request to relay for LLM-based title generation.
	sm.OnSessionIDResolved = func(realSessionID, cwd string) {
		go func() {
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
		}()
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
	client.SetVersion(version)
	client.SetStartedAt(time.Now().Unix())

	// Start system metrics collector
	sysinfo.Start()
	defer sysinfo.Stop()
	client.SetMetricsFn(func() (float64, float64, float64) {
		m := sysinfo.Get()
		return m.CpuPct, m.MemPct, m.DiskPct
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

	// Start session watcher
	if err := sw.Start(ctx); err != nil {
		logger.Error("start session watcher", "error", err)
		os.Exit(1)
	}

	// Start process monitor
	go pm.Run(ctx)

	// Start WebSocket client
	go func() {
		if err := client.Run(ctx); err != nil && ctx.Err() == nil {
			logger.Error("ws client exited", "error", err)
		}
	}()

	// Handle watcher events
	go handleWatcherEvents(ctx, sw, sm, pm, outputCh, logger, &stateDirty)

	// Handle process monitor events
	go handleProcessEvents(ctx, pm, sm, logger, &stateDirty)

	// Handle commands from relay
	go handleCommands(ctx, client, sm, logger, &stateDirty)

	// Periodic state update — only writes when stateDirty is true
	go func() {
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
	}()

	fmt.Println(i18n.T("daemon.started", id, os.Getpid()))
	fmt.Println(i18n.T("daemon.relay", url))
	fmt.Println(i18n.T("daemon.agents", strings.Join(agentTypes, ", ")))
	fmt.Println(i18n.T("daemon.logs", daemon.LogPath()))

	// Daemonize: re-exec self in background
	if !*foreground && os.Getenv("POCKETCTL_DAEMON_CHILD") != "1" {
		childEnv := append(os.Environ(), "POCKETCTL_DAEMON_CHILD=1")
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
		os.Exit(0)
	}

	// Wait for signal
	<-sigCh
	logger.Info("shutting down")
	fmt.Println(i18n.T("daemon.shutting_down"))
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
	data, err := os.ReadFile(daemon.LogPath())
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
				"type":     "register",
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

func handleWatcherEvents(ctx context.Context, sw *watcher.SessionWatcher, sm *session.SessionManager, pm *watcher.ProcessMonitor, outputCh chan protocol.DaemonEvent, logger *slog.Logger, stateDirty *atomic.Bool) {
	for {
		select {
		case <-ctx.Done():
			return
		case evt := <-sw.Events():
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
				// Start JSONL tailer from beginning to replay history and tail new events
				go func() {
					var tailer *watcher.JSONLTailer
					// Retry: Claude Code may not have created the JSONL file yet
					for retry := 0; retry < 30; retry++ {
						jsonlPath, err := watcher.ResolveJSONLPath(evt.Session.SessionID, evt.Session.Cwd)
						if err == nil {
							tailer, err = watcher.NewJSONLTailerFromStart(jsonlPath)
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
				}()

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
				logger.Info("create session", "agent", cmd.Agent, "cwd", cmd.Cwd, "model", cmd.Model)
				stateDirty.Store(true)
				config := protocol.SessionConfig{
					Agent:          cmd.Agent,
					Cwd:            cmd.Cwd,
					Prompt:         cmd.Prompt,
					PermissionMode: cmd.PermissionMode,
					Model:          cmd.Model,
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
			client.SendMsg(protocol.DaemonEvent{
				Type:      "session_created",
				SessionID: sessionID,
				Title:     config.Prompt,
				Model:     model,
			})

			case "abort_create":
				logger.Info("abort create session", "session", cmd.SessionID)
				if cmd.SessionID != "" {
					sm.AbortSession(cmd.SessionID)
				}

			case "daemon_restart":
				logger.Info("daemon restart requested")
				go func() {
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
				}()

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
				if err := sm.SetPermissionMode(ctx, cmd.SessionID, cmd.Content); err != nil {
					logger.Error("set permission mode failed", "error", err)
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
				client.SendMsg(protocol.DaemonEvent{
					Type:      "command_list",
					SessionID: cmd.SessionID,
					Commands:  commands.ListCommands(cwd, available),
				})

			case "get_session_meta":
				// Web client queries a session's resolved model (for the /model
				// command). Unlike session_created (one-shot, fired before the web
				// subscribes), this is a request/response the client issues on mount.
				model, exists := sm.GetSessionModel(cmd.SessionID)
				if model == "" {
					// Terminal sessions don't carry a model at discovery time — extract
					// it from the JSONL history (last real assistant message) and cache.
					cwd, cwdOk := sm.GetSessionCwd(cmd.SessionID)
					if !cwdOk {
						logger.Info("get_session_meta: not in memory", "session", cmd.SessionID, "exists", exists)
					} else if path, perr := watcher.ResolveJSONLPath(cmd.SessionID, cwd); perr != nil {
						logger.Info("get_session_meta: resolve path failed", "session", cmd.SessionID, "cwd", cwd, "error", perr)
					} else if data, ferr := os.ReadFile(path); ferr != nil {
						logger.Info("get_session_meta: read jsonl failed", "session", cmd.SessionID, "path", path, "error", ferr)
					} else {
						lines := strings.Split(string(data), "\n")
						m := adapter.ExtractLastAssistantModel(lines)
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
				})

			case "list_models":
				// Web client queries the host's available models to populate the
				// session-creation picker. Reads ~/.claude/settings.json alias map.
				client.SendMsg(protocol.DaemonEvent{
					Type:   "model_list",
					Models: session.ListAvailableModels(),
				})

			case "upgrade_agent":
				go handleUpgradeAgent(client, logger, cmd.Agent)

			default:
				logger.Debug("unknown command", "type", cmd.Type)
			}
		}
	}
}

// handleUpgradeAgent upgrades the requested agent via its built-in command (claude update /
// opencode upgrade) or `npm install -g <package>@latest` (codex). Re-discovers versions,
// pushes a fresh register + upgrade_result event.
func handleUpgradeAgent(client *ws.Client, logger *slog.Logger, agent string) {
	agentName := agent
	if agentName == "" {
		agentName = "claude-code"
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
	logger.Info("agent upgrade start", "agent", agentName, "old_version", oldVer, "cmd", updateCmd)

	upCtx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	var out []byte
	if updateCmd != "" {
		parts := strings.Fields(updateCmd)
		out, err = exec.CommandContext(upCtx, parts[0], parts[1:]...).CombinedOutput()
	} else {
		out, err = exec.CommandContext(upCtx, "npm", "install", "-g", pkg+"@latest").CombinedOutput()
	}
	if err != nil {
		logger.Error("agent upgrade failed", "agent", agentName, "error", err, "output", string(out))
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "failed", Error: fmt.Sprintf("%v: %s", err, strings.TrimSpace(string(out)))})
		return
	}

	agentVersions := make(map[string]string)
	agentLatests := make(map[string]string)
	newVer := ""
	for _, a := range discovery.DiscoverAgents() {
		if a.Version != "" {
			agentVersions[a.Type] = a.Version
		}
		if a.Latest != "" {
			agentLatests[a.Type] = a.Latest
		}
		if a.Type == agentName {
			newVer = a.Version
		}
	}
	client.SetAgentVersions(agentVersions)
	client.SetAgentLatests(agentLatests)
	client.ResendRegister()
	client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "success", Message: newVer})
	logger.Info("agent upgrade done", "agent", agentName, "old", oldVer, "new", newVer)
}

// readJSONLLines reads up to maxLines from a JSONL file and returns them as a slice.
// classifyCreateError maps a CreateSession error message to a reason code
// for the session_create_failed event (no_cli, bad_cwd, start_fail).
func classifyCreateError(msg string) string {
	if strings.Contains(msg, "agent CLI not found") {
		return "no_cli"
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
