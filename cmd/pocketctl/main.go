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
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/api"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/notify"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
	"github.com/pocketctl/pocketctl/internal/ws"
)

var version = "0.1.0"

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
  login          Login via phone number (SMS verification)
  daemon start   Start the daemon (connects to relay)
  daemon stop    Stop the running daemon
  daemon status  Show daemon status
  daemon logs    Show daemon logs
  daemon doctor  Diagnose connection and configuration issues
  version        Print version
  help           Show this help

Environment:
  POCKETCTL_RELAY_URL   Relay WebSocket URL (e.g. wss://your-domain.com/ws)
  POCKETCTL_TOKEN       JWT token for authentication`)
}

func cmdDaemon(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: pocketctl daemon <start|stop|status|logs|doctor>")
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
	default:
		fmt.Fprintf(os.Stderr, "unknown daemon subcommand: %s\n", args[0])
		os.Exit(1)
	}
}

// ---------- daemon start ----------

// ---------- login ----------

func cmdLogin(args []string) {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	relayURL := fs.String("relay", "", "Relay WebSocket URL (default: ws://localhost:8080/ws)")
	production := fs.Bool("prod", false, "Use production relay (wss://pocketctl.muwb.com/ws) instead of local dev")
	fs.Parse(args)

	baseURL := *relayURL
	if baseURL == "" {
		if *production {
			baseURL = "wss://pocketctl.muwb.com/ws"
		} else {
			baseURL = "ws://localhost:8080/ws"
		}
	}

	fmt.Println("pocketctl login")
	fmt.Println("---------------")

	// Prompt for phone number
	fmt.Print("手机号: ")
	var phone string
	fmt.Scanln(&phone)

	phone = strings.TrimSpace(phone)
	if len(phone) != 11 || phone[0] != '1' {
		fmt.Fprintln(os.Stderr, "错误: 请输入有效的11位手机号")
		os.Exit(1)
	}

	// Send verification code
	fmt.Print("正在发送验证码...")
	if err := api.SendSMS(baseURL, phone); err != nil {
		fmt.Fprintf(os.Stderr, "\n发送失败: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(" 已发送")

	// Prompt for verification code
	fmt.Print("验证码: ")
	var code string
	fmt.Scanln(&code)

	code = strings.TrimSpace(code)
	if len(code) != 6 {
		fmt.Fprintln(os.Stderr, "错误: 请输入6位验证码")
		os.Exit(1)
	}

	// Verify
	fmt.Print("正在验证...")
	accessToken, refreshToken, err := api.VerifySMS(baseURL, phone, code)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n验证失败: %v\n", err)
		os.Exit(1)
	}

	// Convert relay base URL to WebSocket URL for storage
	wsURL := strings.Replace(baseURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)
	if !strings.HasSuffix(wsURL, "/ws") {
		wsURL += "/ws"
	}

	// Save to config
	if err := config.SaveAuth(wsURL, accessToken, refreshToken); err != nil {
		fmt.Fprintf(os.Stderr, "\n保存失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(" 登录成功!")
	fmt.Printf("Token 已保存到 ~/.pocketctl/auth.json\n")
	fmt.Printf("现在可以运行 'pocketctl daemon start' 启动守护进程\n")
}

// ---------- daemon start (continued) ----------

func cmdDaemonStart(args []string) {
	fs := flag.NewFlagSet("daemon start", flag.ExitOnError)
	relayURL := fs.String("relay", "", "Relay WebSocket URL (or POCKETCTL_RELAY_URL env)")
	production := fs.Bool("prod", false, "Use production relay (wss://pocketctl.muwb.com/ws)")
	token := fs.String("token", "", "JWT token (or POCKETCTL_TOKEN env)")
	daemonID := fs.String("id", "", "Daemon ID (auto-generated if empty)")
	fs.Parse(args)

	// Resolve relay URL
	url := *relayURL
	if url == "" {
		url = os.Getenv("POCKETCTL_RELAY_URL")
	}
	if url == "" {
		// Try stored config
		if storedURL, _, _, err := config.LoadAuth(); err == nil && storedURL != "" {
			url = storedURL
		}
	}
	if url == "" && *production {
		url = "wss://pocketctl.muwb.com/ws"
	}
	if url == "" {
		url = "wss://pocketctl.me/ws"
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
		fmt.Fprintf(os.Stderr, "daemon already running (PID %d)\n", pid)
		os.Exit(1)
	}

	// Generate daemon ID — reuse persisted ID if available
	id := *daemonID
	if id == "" {
		if existing, err := daemon.ReadState(); err == nil && existing.DaemonID != "" {
			id = existing.DaemonID
		}
		if id == "" {
			id = "daemon-" + uuid.New().String()[:8]
		}
	}

	// Setup logging to file
	logFile, err := os.OpenFile(daemon.LogPath(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
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
						SessionID: s.SessionID,
						Agent:     s.Agent,
						Cwd:       s.Cwd,
						Status:    s.Status,
						StartedAt: s.StartedAt,
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
		baseURL = "https://pocketctl.me"
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
					break
				}
				// Start JSONL tailer from beginning to replay history and tail new events
				go func() {
					jsonlPath, err := watcher.ResolveJSONLPath(evt.Session.SessionID, evt.Session.Cwd)
					if err != nil {
						return
					}
					tailer, err := watcher.NewJSONLTailerFromStart(jsonlPath)
					if err != nil {
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
					client.SendMsg(protocol.DaemonEvent{
						Type: "error", Error: err.Error(),
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
