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
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/notify"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/update"
	"github.com/pocketctl/pocketctl/internal/watcher"
	"github.com/pocketctl/pocketctl/internal/ws"
)

var version = "0.1.1"

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
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`pocketctl - Remote AI coding agent control

Usage:
  pocketctl <command> [options]

Commands:
  login          Login via browser (OAuth 2.0 Device Flow) or email code
  daemon start   Start the daemon (connects to relay)
  daemon stop    Stop the running daemon
  daemon status  Show daemon status
  daemon logs    Show daemon logs
  daemon doctor  Diagnose connection and configuration issues
  daemon update  Update daemon to the latest version
  version        Print version
  help           Show this help

Login Options:
  --email        Use email verification code (for headless servers)
  --relay <url>  Relay WebSocket URL
  --prod         Use production relay from config

Environment:
  POCKETCTL_RELAY_URL   Relay WebSocket URL (e.g. wss://your-domain.com/ws)
  POCKETCTL_TOKEN       JWT token for authentication`)
}

func cmdDaemon(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: pocketctl daemon <start|stop|status|logs|doctor|update>")
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
		fmt.Fprintf(os.Stderr, "unknown daemon subcommand: %s\n", args[0])
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

	// Resolve relay URL: --relay > env var > --prod from config > default dev
	baseURL := *relayURL
	if baseURL == "" {
		baseURL = os.Getenv("POCKETCTL_RELAY_URL")
	}
	if baseURL == "" && *production {
		if prodURL, err := config.LoadProdRelayURL(); err == nil && prodURL != "" {
			baseURL = prodURL
		} else {
			fmt.Fprintln(os.Stderr, "error: --prod requires prod_relay_url in config. Run the install script with --prod first, or set POCKETCTL_RELAY_URL.")
			os.Exit(1)
		}
	}
	if baseURL == "" {
		baseURL = "ws://localhost/ws"
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

	fmt.Println("pocketctl login")
	fmt.Println("---------------")

	var accessToken, refreshToken string
	var err error

	// Choose login method
	if *emailMode || !canOpenBrowser() {
		// Headless mode: email verification code
		if *emailMode {
			fmt.Println("使用邮箱验证码登录 (--email)")
		} else {
			fmt.Println("检测到无浏览器环境，使用邮箱验证码登录")
		}
		accessToken, refreshToken, err = loginViaEmail(apiURL)
	} else {
		// GUI mode: OAuth 2.0 Device Authorization Grant
		fmt.Println("使用浏览器授权登录 (OAuth 2.0 Device Flow)")
		accessToken, refreshToken, err = loginViaDeviceFlow(apiURL)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "\n登录失败: %v\n", err)
		os.Exit(1)
	}

	// Save to config
	if err := config.SaveAuth(wsURL, accessToken, refreshToken); err != nil {
		fmt.Fprintf(os.Stderr, "\n保存失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("\n✅ 登录成功!")
	fmt.Printf("Token 已保存到 ~/.pocketctl/auth.json\n")
	fmt.Printf("现在可以运行 'pocketctl daemon start' 启动守护进程\n")
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
		return "", "", fmt.Errorf("生成 PKCE 验证码失败: %w", err)
	}
	codeChallenge := api.ComputeCodeChallenge(codeVerifier)

	// Get machine ID
	machineID := daemon.MachineID()

	// Request device authorization
	fmt.Print("正在请求设备授权...")
	authResp, err := api.DeviceAuthorize(apiURL, "pocketctl-cli", codeChallenge, machineID)
	if err != nil {
		return "", "", fmt.Errorf("请求授权失败: %w", err)
	}
	fmt.Println(" ✅")

	// Open browser
	fmt.Printf("\n正在打开浏览器进行授权...\n")
	fmt.Printf("如果浏览器未自动打开，请手动访问:\n")
	fmt.Printf("  %s\n\n", authResp.VerificationURIComplete)

	openBrowser(authResp.VerificationURIComplete)

	// Poll for token
	interval := authResp.Interval
	if interval < 5 {
		interval = 5
	}

	fmt.Print("等待授权")
	startTime := time.Now()
	for {
		select {
		case <-time.After(time.Duration(interval) * time.Second):
			elapsed := int(time.Since(startTime).Seconds())
			fmt.Printf("\r等待授权... (已等待 %ds)", elapsed)

			result, err := api.DeviceToken(apiURL, authResp.DeviceCode, "pocketctl-cli", codeVerifier)
			if err != nil {
				continue // network error, retry
			}

			switch result.Error {
			case "":
				if result.AccessToken != "" {
					fmt.Println("\n✅ 授权成功!")
					return result.AccessToken, result.RefreshToken, nil
				}
			case "authorization_pending":
				continue
			case "slow_down":
				interval += 5
				continue
			case "expired_token":
				return "", "", fmt.Errorf("授权超时，请重新运行 pocketctl login")
			default:
				return "", "", fmt.Errorf("授权失败: %s", result.Error)
			}

			if elapsed > authResp.ExpiresIn {
				return "", "", fmt.Errorf("授权超时，请重新运行 pocketctl login")
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
	fmt.Print("邮箱地址: ")
	var email string
	fmt.Scanln(&email)

	email = strings.TrimSpace(email)
	if !strings.Contains(email, "@") {
		return "", "", fmt.Errorf("请输入有效的邮箱地址")
	}

	fmt.Print("正在发送验证码...")
	if err := api.SendEmailCode(apiURL, email); err != nil {
		return "", "", fmt.Errorf("发送失败: %w", err)
	}
	fmt.Println(" ✅ 已发送")

	fmt.Print("验证码: ")
	var code string
	fmt.Scanln(&code)

	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return "", "", fmt.Errorf("请输入6位验证码")
	}

	fmt.Print("正在验证...")
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

	// Resolve relay URL: --relay > env var > --prod from config > default dev
	url := *relayURL
	if url == "" {
		url = os.Getenv("POCKETCTL_RELAY_URL")
	}
	if url == "" && *production {
		if prodURL, err := config.LoadProdRelayURL(); err == nil && prodURL != "" {
			url = prodURL
		} else {
			fmt.Fprintln(os.Stderr, "error: --prod requires prod_relay_url in config. Run the install script with --prod first, or set POCKETCTL_RELAY_URL.")
			os.Exit(1)
		}
	}
	if url == "" {
		url = "ws://localhost/ws"
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
		fmt.Fprintln(os.Stderr, "error: token required. Run 'pocketctl login' first, or set --token / POCKETCTL_TOKEN")
		os.Exit(1)
	}

	// Check if already running
	if pid, running := daemon.IsRunning(); running {
		fmt.Printf("daemon already running (PID %d)\n", pid)
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
	for _, a := range agents {
		agentTypes = append(agentTypes, a.Type)
		logger.Info("discovered agent", "type", a.Type, "path", a.Path)
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
	client := ws.NewClient(url, tok, id, agentTypes, outputCh, logger)

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

	fmt.Printf("pocketctl daemon started (ID: %s, PID: %d)\n", id, os.Getpid())
	fmt.Printf("Relay: %s\n", url)
	fmt.Printf("Agents: %s\n", strings.Join(agentTypes, ", "))
	fmt.Printf("Logs: %s\n", daemon.LogPath())

	// Daemonize: re-exec self in background
	if !*foreground && os.Getenv("POCKETCTL_DAEMON_CHILD") != "1" {
		childEnv := append(os.Environ(), "POCKETCTL_DAEMON_CHILD=1")
		exe, err := os.Executable()
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to get executable path: %v\n", err)
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
			fmt.Fprintf(os.Stderr, "failed to daemonize: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	// Wait for signal
	<-sigCh
	logger.Info("shutting down")
	fmt.Println("\nShutting down...")
	cancel()
	time.Sleep(500 * time.Millisecond)
}

// ---------- daemon stop ----------

func cmdDaemonStop() {
	if err := daemon.Stop(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Daemon stopped")
}

// ---------- daemon status ----------

func cmdDaemonStatus() {
	pid, running := daemon.IsRunning()
	if !running {
		fmt.Println("Daemon is not running")
		return
	}

	state, err := daemon.ReadState()
	if err != nil {
		fmt.Printf("Daemon running (PID %d), state unavailable\n", pid)
		return
	}

	fmt.Printf("Daemon: %s\n", state.DaemonID)
	fmt.Printf("PID:    %d\n", state.PID)
	fmt.Printf("Relay:  %s\n", state.RelayURL)
	fmt.Printf("Status: %s\n", map[bool]string{true: "connected", false: "disconnected"}[state.Connected])
	fmt.Printf("Started: %s\n", state.StartedAt.Format(time.RFC3339))

	if len(state.Sessions) > 0 {
		fmt.Printf("\nSessions (%d):\n", len(state.Sessions))
		for _, s := range state.Sessions {
			fmt.Printf("  %s  %-10s  %s\n", s.SessionID[:8], s.Status, s.Cwd)
		}
	}
}

// ---------- daemon logs ----------

func cmdDaemonLogs() {
	data, err := os.ReadFile(daemon.LogPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "error reading log: %v\n", err)
		os.Exit(1)
	}
	os.Stdout.Write(data)
}

// ---------- daemon doctor ----------

func cmdDoctor() {
	fmt.Println("pocketctl doctor")
	fmt.Println("════════════════════════════════════")

	pass := 0
	total := 0

	// Helper: print check result
	check := func(name string, ok bool, detail string) {
		total++
		if ok {
			pass++
			fmt.Printf("  ✅ %s: %s\n", name, detail)
		} else {
			fmt.Printf("  ❌ %s: %s\n", name, detail)
		}
	}

	// 1. Config file
	relayURL, accessToken, _, err := config.LoadAuth()
	check("配置文件", err == nil, func() string {
		if err != nil {
			return "未登录，请运行 pocketctl login"
		}
		return "~/.pocketctl/auth.json 存在"
	}())

	// 2. Token validity
	if accessToken != "" {
		exp, err := api.ParseJWTExpiry(accessToken)
		if err != nil {
			check("认证令牌", false, "Token 格式无效")
		} else if time.Now().After(exp) {
			check("认证令牌", false, "Token 已过期，请重新登录")
		} else {
			check("认证令牌", true, fmt.Sprintf("有效，过期时间 %s", exp.Format("2006-01-02 15:04")))
		}
	} else {
		check("认证令牌", false, "无 Token，请运行 pocketctl login")
	}

	// Derive base URL from relay URL
	baseURL := relayURL
	if baseURL == "" {
		// No relay URL configured — report partial results
		fmt.Println()
		fmt.Println("════════════════════════════════════")
		fmt.Printf("  结果: %d/%d 通过（未配置 relay URL，无法检查网络）\n", pass, total)
		fmt.Println("════════════════════════════════════")
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
		check("DNS 解析", err == nil, func() string {
			if err != nil {
				return fmt.Sprintf("无法解析域名: %s", hostname)
			}
			return fmt.Sprintf("%s → %s", hostname, addrs[0])
		}())
	} else {
		check("DNS 解析", false, "无法从 URL 提取域名")
	}

	// 4. HTTP health check
	start := time.Now()
	healthBody, healthErr := api.HealthCheck(baseURL)
	elapsed := time.Since(start).Milliseconds()
	check("HTTP 连通", healthErr == nil, func() string {
		if healthErr != nil {
			return fmt.Sprintf("无法连接 %s: %v", baseURL, healthErr)
		}
		return fmt.Sprintf("HTTP 200 (%dms)", elapsed)
	}())

	// 5. Relay health status
	if healthErr == nil {
		var parsed map[string]any
		if json.Unmarshal([]byte(healthBody), &parsed) == nil {
			status, _ := parsed["status"].(string)
			check("Relay 健康", status == "ok", func() string {
				if status == "ok" {
					return fmt.Sprintf("status: ok")
				}
				return fmt.Sprintf("status: %s", status)
			}())
		}
	} else {
		check("Relay 健康", false, "无法检查（HTTP 连接失败）")
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
			check("WebSocket 连接", false, wsErr.Error())
			check("认证通过", false, "WebSocket 连接失败")
			check("Daemon 限制", false, "WebSocket 连接失败")
		} else {
			check("WebSocket 连接", true, "连接成功")

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
				check("认证通过", false, fmt.Sprintf("读取响应超时: %v", readErr))
				check("Daemon 限制", false, "无法检查")
			} else {
				var result map[string]any
				json.Unmarshal(resp, &result)
				msgType, _ := result["type"].(string)
				code, _ := result["code"].(string)

				if msgType == "register_ack" {
					check("认证通过", true, "register_ack 收到")
					check("Daemon 限制", true, "未达限制")
				} else if code == "DAEMON_LIMIT_REACHED" {
					errMsg, _ := result["error"].(string)
					check("认证通过", true, "认证成功")
					check("Daemon 限制", false, errMsg)
				} else if msgType == "error" {
					errMsg, _ := result["error"].(string)
					check("认证通过", false, errMsg)
					check("Daemon 限制", false, "认证失败")
				} else {
					check("认证通过", false, fmt.Sprintf("未知响应: %s", msgType))
					check("Daemon 限制", false, "无法检查")
				}
			}
		}
	} else {
		check("WebSocket 连接", false, "缺少 relay URL 或 token")
		check("认证通过", false, "缺少配置")
		check("Daemon 限制", false, "缺少配置")
	}

	// Summary
	fmt.Println()
	fmt.Println("════════════════════════════════════")
	if pass == total {
		fmt.Printf("  结果: 全部通过 (%d/%d)\n", pass, total)
	} else {
		fmt.Printf("  结果: %d/%d 通过，%d 项需要修复\n", pass, total, total-pass)
	}
	fmt.Println("════════════════════════════════════")

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
				logger.Info("create session", "agent", cmd.Agent, "cwd", cmd.Cwd)
				stateDirty.Store(true)
				config := protocol.SessionConfig{
					Agent: cmd.Agent,
					Cwd:   cmd.Cwd,
					Prompt: cmd.Prompt,
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

				// Notify relay that session was created so it can link the originating client
				client.SendMsg(protocol.DaemonEvent{
					Type:      "session_created",
					SessionID: sessionID,
					Title:     config.Prompt,
				})

			case "abort_create":
				logger.Info("abort create session", "session", cmd.SessionID)
				if cmd.SessionID != "" {
					sm.AbortSession(cmd.SessionID)
				}

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

			default:
				logger.Debug("unknown command", "type", cmd.Type)
			}
		}
	}
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
	fmt.Println("  🔍 pocketctl 自更新")
	fmt.Println(strings.Repeat("─", 40))
	fmt.Printf("  当前版本: %s\n", version)
	fmt.Printf("  运行平台: %s/%s\n", runtime.GOOS, runtime.GOARCH)

	// 1. Check latest version
	var tag string
	var err error
	if *versionFlag != "" {
		fmt.Printf("  指定版本: %s\n", *versionFlag)
		tag, err = update.CheckVersion(*versionFlag)
	} else {
		fmt.Println("  查询最新版本...")
		tag, err = update.CheckLatest()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n  ❌ 版本查询失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("  目标版本: %s\n", tag)

	// Strip 'v' prefix for comparison
	currentVer := strings.TrimPrefix(version, "v")
	targetVer := strings.TrimPrefix(tag, "v")

	if *versionFlag == "" && currentVer == targetVer {
		fmt.Println()
		fmt.Println("  ✅ 已经是最新版本!")
		return
	}

	// 2. Resolve binary + checksum
	fmt.Println()
	fmt.Println("  📦 解析下载地址...")
	binInfo, err := update.ResolveBinary(tag)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n  ❌ 解析失败: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("  下载: %s\n", binInfo.Name)
	if binInfo.SHA != "" {
		fmt.Printf("  校验: SHA256 = %s...%s\n", binInfo.SHA[:16], binInfo.SHA[len(binInfo.SHA)-16:])
	}

	// 3. Download
	fmt.Println()
	fmt.Println("  ⬇️  下载中...")
	tmpPath, err := update.DownloadAndVerify(binInfo)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n  ❌ 下载失败: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("  ✅ 下载完成，SHA256 校验通过")

	// 4. Replace binary
	fmt.Println()
	fmt.Println("  🔧 替换二进制...")
	if err := update.ReplaceBinary(tmpPath); err != nil {
		fmt.Fprintf(os.Stderr, "\n  ❌ 替换失败: %v\n", err)
		fmt.Println()
		fmt.Println("  💡 提示: 如果权限不足，请使用 sudo 运行:")
		fmt.Printf("     sudo pocketctl daemon update")
		if *versionFlag != "" {
			fmt.Printf(" --version %s", *versionFlag)
		}
		fmt.Println()
		os.Exit(1)
	}
	fmt.Println("  ✅ 二进制已更新")

	// 5. Restart daemon (unless --no-restart)
	if !*noRestart {
		fmt.Println()
		fmt.Println("  🔄 检查 Daemon 运行状态...")
		if err := update.RestartDaemon(); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠️  重启失败: %v (请手动重启)\n", err)
		}
	}

	fmt.Println()
	fmt.Println(strings.Repeat("─", 40))
	fmt.Println("  🎉 更新完成!")
	fmt.Printf("  版本: %s → %s\n", version, tag)
	fmt.Println()
}
