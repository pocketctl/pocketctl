package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
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

var version = "dev"

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
  version        Print version
  help           Show this help

Environment:
  POCKETCTL_RELAY_URL   Relay WebSocket URL (e.g. wss://your-domain.com/ws)
  POCKETCTL_TOKEN       JWT token for authentication`)
}

func cmdDaemon(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: pocketctl daemon <start|stop|status|logs>")
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
	default:
		fmt.Fprintf(os.Stderr, "unknown daemon subcommand: %s\n", args[0])
		os.Exit(1)
	}
}

// ---------- daemon start ----------

// ---------- login ----------

func cmdLogin(args []string) {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	relayURL := fs.String("relay", "", "Relay base URL (default: http://localhost:8080)")
	fs.Parse(args)

	baseURL := *relayURL
	if baseURL == "" {
		baseURL = "http://localhost:8080"
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
	if url == "" {
		url = "ws://localhost:8080/ws"
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

// ---------- Event handlers ----------

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

					// Extract title from first user message
					title := watcher.ExtractTitleFromJSONL(jsonlPath)
					if title != "Terminal Session" {
						sm.UpdateSessionTitle(evt.Session.SessionID, title)
					}

					// Tail loop: send parsed events with session_id stamped
					ticker := time.NewTicker(1 * time.Second)
					defer ticker.Stop()
					for {
						select {
						case <-ctx.Done():
							return
						case <-ticker.C:
							events, _, err := tailer.TailNewLines()
							if err != nil {
								continue
							}
							for i := range events {
								if events[i].SessionID == "" {
									events[i].SessionID = evt.Session.SessionID
								}
								outputCh <- events[i]
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
