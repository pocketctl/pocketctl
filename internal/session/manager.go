package session

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type ProcessState struct {
	SessionID string
	Cmd       *exec.Cmd
	Cancel    context.CancelFunc
	Status    string
	StartedAt time.Time
	LastActivityAt time.Time // last activity timestamp (status change, message, etc.)
	Cwd       string
	Agent     string
	Source    string // "daemon" or "terminal"
	SlashCommands []string // slash commands the agent reported as available (init event)
	Pid       int    // terminal session's original PID
	TTY       string // terminal session's TTY device (e.g. /dev/ttys002)
	ExitReason string // reason for process exit (terminal sessions only)
	TitleGenerated bool // true once generate_title_request has been sent
}

// NotifyFunc is called after a web→terminal message completes.
type NotifyFunc func(sessionID, ttyPath string)

type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*ProcessState
	outputCh chan protocol.DaemonEvent
	childPids map[int]bool // PIDs of daemon-spawned processes
	OnNotifyTerminal NotifyFunc // callback after --resume on terminal session
	OnSessionIDResolved func(realSessionID, cwd string) // callback when daemon session gets real ID
}

func NewSessionManager(outputCh chan protocol.DaemonEvent) *SessionManager {
	return &SessionManager{
		sessions:  make(map[string]*ProcessState),
		outputCh:  outputCh,
		childPids: make(map[int]bool),
	}
}

// resolveCwd resolves the working directory path:
// - "" or "~" → os.UserHomeDir()
// - "~/xxx" → join(home, "xxx")
// - other → as-is
func resolveCwd(cwd string) string {
	if cwd == "" || cwd == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return cwd
		}
		return home
	}
	if strings.HasPrefix(cwd, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return cwd
		}
		return filepath.Join(home, cwd[2:])
	}
	return cwd
}

// stripModelSuffix removes any trailing "[...]" suffix that some config tools
// (e.g. cc switch) append to model names (like "GLM-5.2[1M]"). Such suffixes
// are not valid model identifiers and cause provider API errors.
func stripModelSuffix(s string) string {
	if idx := strings.Index(s, "["); idx > 0 {
		return strings.TrimSpace(s[:idx])
	}
	return s
}

// resolveCleanModel reads ~/.claude/settings.json, resolves the active model
// alias (opus/sonnet/haiku) to its concrete model name via the
// ANTHROPIC_DEFAULT_*_MODEL env mapping, and strips any invalid [...] suffix.
// Returns "" if settings.json is missing or unparseable (claude falls back to
// its own defaults).
func resolveCleanModel() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Model string            `json:"model"`
		Env   map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return ""
	}

	switch strings.ToLower(strings.TrimSpace(cfg.Model)) {
	case "opus":
		return stripModelSuffix(cfg.Env["ANTHROPIC_DEFAULT_OPUS_MODEL"])
	case "sonnet":
		return stripModelSuffix(cfg.Env["ANTHROPIC_DEFAULT_SONNET_MODEL"])
	case "haiku":
		return stripModelSuffix(cfg.Env["ANTHROPIC_DEFAULT_HAIKU_MODEL"])
	default:
		if cfg.Model == "" {
			return ""
		}
		return stripModelSuffix(cfg.Model)
	}
}

// validateCwd checks that the directory exists, is a directory, and is accessible.
func validateCwd(cwd string) error {
	info, err := os.Stat(cwd)
	if os.IsNotExist(err) {
		return fmt.Errorf("工作目录不存在: %s", cwd)
	}
	if err != nil {
		return fmt.Errorf("工作目录无法访问: %s (%w)", cwd, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("工作目录不是目录: %s", cwd)
	}
	// Test read access by opening the directory
	f, err := os.Open(cwd)
	if err != nil {
		return fmt.Errorf("工作目录无权限: %s", cwd)
	}
	f.Close()
	return nil
}

func (sm *SessionManager) CreateSession(ctx context.Context, config protocol.SessionConfig) (string, error) {
	cliPath, err := findAgentCLI(config.Agent)
	if err != nil {
		return "", err
	}

	// Resolve and validate working directory
	resolvedCwd := resolveCwd(config.Cwd)
	if err := validateCwd(resolvedCwd); err != nil {
		return "", err
	}

	// Resolve clean model name (strip invalid [...] suffix from cc switch configs)
	config.Model = resolveCleanModel()

	args := adapter.BuildClaudeArgs(config.Prompt, "", config)
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, cliPath, args...)
	cmd.Dir = resolvedCwd

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return "", fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return "", fmt.Errorf("start process: %w", err)
	}

	adp := adapter.NewClaudeAdapter(config.Prompt)
	now := time.Now()
	ps := &ProcessState{
		Cmd:            cmd,
		Cancel:         cancel,
		Status:         protocol.StatusRunning,
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            resolvedCwd,
		Agent:          config.Agent,
		Source:         "daemon",
	}
	ps.SessionID = fmt.Sprintf("pending-%d", time.Now().UnixNano())
	sm.mu.Lock()
	sm.sessions[ps.SessionID] = ps
	if cmd.Process != nil {
		sm.childPids[cmd.Process.Pid] = true
	}
	sm.mu.Unlock()

	// claude -p (stream-json) does not echo the user's prompt, so emit it
	// ourselves so the Web/iOS client can render the user message.
	if config.Prompt != "" {
		sm.outputCh <- protocol.DaemonEvent{
			Type:      "user_text",
			SessionID: ps.SessionID,
			Text:      config.Prompt,
		}
	}

	go sm.readOutput(ctx, cmd, stdout, adp, ps)
	time.Sleep(200 * time.Millisecond)
	return ps.SessionID, nil
}

// RegisterTerminalSession registers a session discovered from the terminal.
// Returns true if a tailer should be started (new session or daemon→terminal upgrade).
// Returns false for: daemon-spawned processes (skip entirely) or existing terminal
// sessions (--continue — PID/status updated in-place, but no new tailer needed since
// the old one still tails the same JSONL file).
func (sm *SessionManager) RegisterTerminalSession(sessionID, cwd string, pid int, ttyPath string, status string) bool {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Don't register if this is a daemon-spawned process
	if sm.childPids[pid] {
		return false
	}

	// Check if session already exists
	if ps, ok := sm.sessions[sessionID]; ok {
		if ps.Source == "terminal" {
			// Re-discovered (e.g. --continue): update PID, status, cwd.
			// Old tailer still works on same JSONL — no new tailer needed.
			ps.Pid = pid
			ps.Status = status
			ps.ExitReason = ""
			if cwd != "" {
				ps.Cwd = cwd
			}
			if ttyPath != "" {
				ps.TTY = ttyPath
			}
			return false
		}
		// Daemon-created session appeared in watcher — user resumed it in terminal.
		// Upgrade source and start tailer.
		ps.Source = "terminal"
		ps.Pid = pid
		if cwd != "" {
			ps.Cwd = cwd
		}
		ps.Status = status
		if ttyPath != "" {
			ps.TTY = ttyPath
		}
		return true
	}

	// New session — register it
	now := time.Now()
	sm.sessions[sessionID] = &ProcessState{
		SessionID:      sessionID,
		Status:         status,
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            cwd,
		Agent:          "claude-code",
		Source:         "terminal",
		Pid:            pid,
		TTY:            ttyPath,
	}

	// session_discovered is emitted later, after the JSONL tailer confirms the file exists.
	// See handleWatcherEvents in cmd/pocketctl/main.go.

	return true
}

// UpdateSessionTitle updates the title for a session and emits an event.
func (sm *SessionManager) UpdateSessionTitle(sessionID, title string) {
	sm.mu.RLock()
	_, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.RUnlock()
		return
	}
	sm.mu.RUnlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:      "session_title_update",
		SessionID: sessionID,
		Title:     title,
	}
}

// GenerateTitle sends a generate_title_request event to the relay for LLM-based
// title generation. Sends at most once per session (guarded by TitleGenerated flag).
func (sm *SessionManager) GenerateTitle(sessionID, userMessage, assistantMessage string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	if ps.TitleGenerated {
		sm.mu.Unlock()
		return
	}
	ps.TitleGenerated = true
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:             "generate_title_request",
		SessionID:        sessionID,
		UserMessage:      userMessage,
		AssistantMessage: assistantMessage,
	}
}

// SetSessionExited marks a terminal session as exited (process died).
// AbortSession cancels and cleans up a pending session, killing the claude subprocess.
// Returns true if the session existed and was aborted, false if not found.
// If the session has already resolved to a real ID (not pending-*), returns false
// without killing (the session is already established and should not be aborted).
func (sm *SessionManager) AbortSession(sessionID string) bool {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return false
	}
	// Don't abort sessions that have resolved to a real ID (not pending-*)
	if !strings.HasPrefix(sessionID, "pending-") {
		sm.mu.Unlock()
		return false
	}
	delete(sm.sessions, sessionID)
	if ps.Cancel != nil {
		ps.Cancel()
	}
	if ps.Cmd != nil && ps.Cmd.Process != nil {
		ps.Cmd.Process.Kill()
	}
	if ps.Cmd != nil && ps.Cmd.Process != nil {
		delete(sm.childPids, ps.Cmd.Process.Pid)
	}
	sm.mu.Unlock()
	return true
}

func (sm *SessionManager) SetSessionExited(sessionID string, exitReason string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	now := time.Now()
	ps.Status = protocol.StatusExited
	ps.ExitReason = exitReason
	ps.LastActivityAt = now
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         protocol.StatusExited,
		ExitReason:     exitReason,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

// SetSessionStatus updates a terminal session's status from watcher events.
func (sm *SessionManager) SetSessionStatus(sessionID, status string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	now := time.Now()
	ps.Status = status
	ps.LastActivityAt = now
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         status,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) readOutput(ctx context.Context, cmd *exec.Cmd, stdout io.Reader, adp *adapter.ClaudeAdapter, ps *ProcessState) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	initSeen := false
	for scanner.Scan() {
		line := scanner.Text()
		events, err := adp.ParseStreamLine(line)
		if err != nil {
			sm.outputCh <- protocol.DaemonEvent{
				Type: "error", SessionID: ps.SessionID, Error: fmt.Sprintf("parse error: %v", err),
			}
			continue
		}
		if sid := adp.SessionID(); sid != "" {
			sm.mu.Lock()
			if ps.SessionID != sid {
				oldID := ps.SessionID
				delete(sm.sessions, ps.SessionID)
				ps.SessionID = sid
				sm.sessions[sid] = ps
				cwd := ps.Cwd
				sm.mu.Unlock()
				sm.outputCh <- protocol.DaemonEvent{
					Type: "session_id_changed", SessionID: sid, OldSessionID: oldID,
				}
				// Trigger title extraction from JSONL for daemon-created sessions
				if sm.OnSessionIDResolved != nil {
					sm.OnSessionIDResolved(sid, cwd)
				}
			} else {
				sm.mu.Unlock()
			}
		}
		// Cache slash commands reported by the agent's init event (emitted once,
		// alongside sessionID) — the authoritative list of commands available in
		// the current (-p) environment.
		if !initSeen && len(adp.SlashCommands()) > 0 {
			initSeen = true
			sm.mu.Lock()
			ps.SlashCommands = adp.SlashCommands()
			sm.mu.Unlock()
		}
		// Update last activity on each received event
		if len(events) > 0 {
			sm.mu.Lock()
			ps.LastActivityAt = time.Now()
			sm.mu.Unlock()
		}
		for _, evt := range events {
			if evt.SessionID == "" {
				evt.SessionID = ps.SessionID
			}
			sm.outputCh <- evt
		}
	}

	exitErr := cmd.Wait()
	now := time.Now()
	status := protocol.StatusCompleted
	if exitErr != nil {
		if ctx.Err() == context.Canceled {
			status = protocol.StatusKilled
		} else {
			status = protocol.StatusError
		}
	}
	sm.mu.Lock()
	ps.Status = status
	ps.LastActivityAt = now
	sm.mu.Unlock()
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      ps.SessionID,
		Status:         status,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) SendMessage(ctx context.Context, sessionID string, content string) error {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	cwd := ps.Cwd
	isRunning := ps.Status == protocol.StatusRunning || ps.Status == "busy"
	isExited := ps.Status == protocol.StatusExited
	cancelFn := ps.Cancel
	source := ps.Source
	pid := ps.Pid
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	// Update last activity — user sent a message
	sm.mu.Lock()
	ps.LastActivityAt = time.Now()
	sm.mu.Unlock()

	// Terminal session: check if process is still alive
	if source == "terminal" && pid > 0 {
		if isProcessAlive(pid) {
			if isRunning {
				// Terminal Claude is actively working — cannot send
				return fmt.Errorf("session busy in terminal")
			}
			// Terminal Claude is idle (waiting for input) — send via --resume
			return sm.sendToIdleTerminal(ctx, ps, content)
		}
		// Process is dead — resume from exited state or fall through
		if !isExited {
			// Mark as exited first if not already
			sm.SetSessionExited(sessionID, protocol.ExitReasonNormalExit)
		}
		// Fall through to spawn new --resume with stdout capture
	}

	// Terminal session in exited state (process already dead) — resume via new process
	if source == "terminal" && isExited {
		// Will spawn claude --resume below
	}

	// Daemon session or dead terminal: cancel old process if still running
	if source == "daemon" && isRunning && cancelFn != nil {
		cancelFn()
		time.Sleep(100 * time.Millisecond)
	}

	cliPath, err := findAgentCLI("claude-code")
	if err != nil {
		return err
	}
	args := adapter.BuildClaudeArgs(content, sessionID, protocol.SessionConfig{PermissionMode: "acceptEdits"})
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, cliPath, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start process: %w", err)
	}

	adp := adapter.NewClaudeAdapter(content)
	sm.mu.Lock()
	ps.Cmd = cmd
	ps.Cancel = cancel
	ps.Status = protocol.StatusRunning
	ps.Source = source // Keep original source
	sm.mu.Unlock()

	// claude -p (stream-json) does not echo the user's message, so emit it ourselves.
	sm.outputCh <- protocol.DaemonEvent{
		Type:      "user_text",
		SessionID: ps.SessionID,
		Text:      content,
	}
	go sm.readOutput(ctx, cmd, stdout, adp, ps)
	return nil
}

// sendToIdleTerminal sends a message to a terminal session that's idle (alive but waiting for input).
// Uses claude --resume without stdout capture — the JSONL tailer handles event forwarding.
func (sm *SessionManager) sendToIdleTerminal(ctx context.Context, ps *ProcessState, content string) error {
	cliPath, err := findAgentCLI("claude-code")
	if err != nil {
		return err
	}

	args := adapter.BuildClaudeArgs(content, ps.SessionID, protocol.SessionConfig{PermissionMode: "acceptEdits"})
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, cliPath, args...)
	cmd.Dir = ps.Cwd
	// Discard stdout — the JSONL tailer picks up events instead, avoiding duplicates
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start --resume: %w", err)
	}

	now := time.Now()
	sm.mu.Lock()
	ps.Cmd = cmd
	ps.Cancel = cancel
	ps.Status = protocol.StatusRunning
	ps.LastActivityAt = now
	sm.mu.Unlock()

	// Notify web that session is now running
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      ps.SessionID,
		Status:         protocol.StatusRunning,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}

	// Wait for --resume to finish in background
	go func() {
		cmd.Wait()
		resumeNow := time.Now()
		sm.mu.Lock()
		// Terminal process is still alive, so go back to idle
		ps.Status = protocol.StatusIdle
		ps.LastActivityAt = resumeNow
		sm.mu.Unlock()

		sm.outputCh <- protocol.DaemonEvent{
			Type:           "session_status",
			SessionID:      ps.SessionID,
			Status:         protocol.StatusIdle,
			LastActivityAt: time.Now().UTC().Format(time.RFC3339),
		}

		// Trigger notification callback
		if sm.OnNotifyTerminal != nil {
			sm.OnNotifyTerminal(ps.SessionID, ps.TTY)
		}
	}()

	return nil
}

// isProcessAlive checks if a process with the given PID is running.
func isProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil
}

func (sm *SessionManager) KillSession(sessionID string) error {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.Unlock()
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	if ps.Cancel != nil {
		ps.Cancel()
	}
	// Wait for the process to exit (readOutput goroutine calls Wait),
	// but with a timeout so we don't block forever.
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		sm.mu.RLock()
		status := ps.Status
		sm.mu.RUnlock()
		if status == protocol.StatusKilled || status == protocol.StatusCompleted || status == protocol.StatusError {
			break
		}
		select {
		case <-ticker.C:
			// keep polling
		case <-deadline:
			// Force kill if still running
			if ps.Cmd.Process != nil {
				ps.Cmd.Process.Signal(syscall.SIGKILL)
			}
			sm.mu.Lock()
			ps.Status = protocol.StatusKilled
			ps.LastActivityAt = time.Now()
			sm.mu.Unlock()
			return nil
		}
	}
	return nil
}

func (sm *SessionManager) ListSessions() []SessionInfo {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	var active, exited []SessionInfo
	for id, ps := range sm.sessions {
		info := SessionInfo{
			SessionID: id,
			Status:    ps.Status,
			StartedAt: ps.StartedAt,
			LastActivityAt: ps.LastActivityAt,
			Agent:     ps.Agent,
			Cwd:       ps.Cwd,
		}
		if ps.Status == protocol.StatusExited || ps.Status == protocol.StatusCompleted ||
			ps.Status == protocol.StatusError || ps.Status == protocol.StatusKilled {
			exited = append(exited, info)
		} else {
			active = append(active, info)
		}
	}

	// Active sessions first (most recently active first), then exited (most recently exited first)
	sort.Slice(active, func(i, j int) bool {
		return active[i].LastActivityAt.After(active[j].LastActivityAt)
	})
	sort.Slice(exited, func(i, j int) bool {
		return exited[i].LastActivityAt.After(exited[j].LastActivityAt)
	})

	return append(active, exited...)
}

// UpdateLastActivity updates the LastActivityAt timestamp for a session.
// Used by terminal session JSONL tailer to track when events are received.
func (sm *SessionManager) UpdateLastActivity(sessionID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.LastActivityAt = time.Now()
	}
}

// GetSessionCwd returns the working directory for a session and whether the
// session exists. Used to resolve which command sources to scan for a session.
func (sm *SessionManager) GetSessionCwd(sessionID string) (string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return "", false
	}
	return ps.Cwd, true
}

// GetSessionSlashCommands returns the slash commands the agent reported as
// available in its init event for this session. Empty for terminal sessions
// or sessions whose agent hasn't emitted init yet. The bool indicates whether
// the session exists.
func (sm *SessionManager) GetSessionSlashCommands(sessionID string) ([]string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return nil, false
	}
	return ps.SlashCommands, true
}

type SessionInfo struct {
	SessionID string    `json:"session_id"`
	Status    string    `json:"status"`
	StartedAt time.Time `json:"started_at"`
	LastActivityAt time.Time `json:"last_activity_at"`
	Agent     string    `json:"agent"`
	Cwd       string    `json:"cwd"`
}

// ResyncSessions re-emits session_discovered for all tracked sessions.
// Called after the daemon reconnects to the relay to rebuild sessionToDaemon mappings.
func (sm *SessionManager) ResyncSessions() {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	for sessionID, ps := range sm.sessions {
		sm.outputCh <- protocol.DaemonEvent{
			Type:      "session_discovered",
			SessionID: sessionID,
			Cwd:       ps.Cwd,
			Status:    ps.Status,
			Source:    ps.Source,
		}
	}
}

func findAgentCLI(agent string) (string, error) {
	cliNames := map[string]string{"claude-code": "claude", "opencode": "opencode"}
	name, ok := cliNames[agent]
	if !ok {
		name = agent
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("agent CLI not found: %s (%s)", agent, name)
	}
	return path, nil
}
