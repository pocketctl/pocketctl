package session

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
	Cwd       string
	Agent     string
	Source    string // "daemon" or "terminal"
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

	adp := adapter.NewClaudeAdapter()
	ps := &ProcessState{
		Cmd:       cmd,
		Cancel:    cancel,
		Status:    protocol.StatusRunning,
		StartedAt: time.Now(),
		Cwd:       resolvedCwd,
		Agent:     config.Agent,
		Source:    "daemon",
	}
	ps.SessionID = fmt.Sprintf("pending-%d", time.Now().UnixNano())
	sm.mu.Lock()
	sm.sessions[ps.SessionID] = ps
	if cmd.Process != nil {
		sm.childPids[cmd.Process.Pid] = true
	}
	sm.mu.Unlock()

	go sm.readOutput(ctx, cmd, stdout, adp, ps)
	time.Sleep(200 * time.Millisecond)
	return ps.SessionID, nil
}

// RegisterTerminalSession registers a session discovered from the terminal.
// Returns true if newly registered or upgraded from daemon→terminal (teller should start).
// Returns false if already a terminal session (skip).
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
			// Already a terminal session — skip
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
	sm.sessions[sessionID] = &ProcessState{
		SessionID: sessionID,
		Status:    status,
		StartedAt: time.Now(),
		Cwd:       cwd,
		Agent:     "claude-code",
		Source:    "terminal",
		Pid:       pid,
		TTY:       ttyPath,
	}

	// Emit session_discovered event to relay so it knows about this session
	sm.outputCh <- protocol.DaemonEvent{
		Type:      "session_discovered",
		SessionID: sessionID,
		Cwd:       cwd,
		Status:    status,
		Source:    "terminal",
	}

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
func (sm *SessionManager) SetSessionExited(sessionID string, exitReason string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	ps.Status = protocol.StatusExited
	ps.ExitReason = exitReason
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         protocol.StatusExited,
		ExitReason:     exitReason,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
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
	ps.Status = status
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         status,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) readOutput(ctx context.Context, cmd *exec.Cmd, stdout io.Reader, adp *adapter.ClaudeAdapter, ps *ProcessState) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

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
		for _, evt := range events {
			if evt.SessionID == "" {
				evt.SessionID = ps.SessionID
			}
			sm.outputCh <- evt
		}
	}

	exitErr := cmd.Wait()
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
	sm.mu.Unlock()
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      ps.SessionID,
		Status:         status,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
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

	adp := adapter.NewClaudeAdapter()
	sm.mu.Lock()
	ps.Cmd = cmd
	ps.Cancel = cancel
	ps.Status = protocol.StatusRunning
	ps.Source = source // Keep original source
	sm.mu.Unlock()
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

	sm.mu.Lock()
	ps.Cmd = cmd
	ps.Cancel = cancel
	ps.Status = protocol.StatusRunning
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
		sm.mu.Lock()
		// Terminal process is still alive, so go back to idle
		ps.Status = protocol.StatusIdle
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
			sm.mu.Unlock()
			return nil
		}
	}
	return nil
}

func (sm *SessionManager) ListSessions() []SessionInfo {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	var infos []SessionInfo
	for id, ps := range sm.sessions {
		infos = append(infos, SessionInfo{
			SessionID: id, Status: ps.Status, StartedAt: ps.StartedAt, Agent: ps.Agent, Cwd: ps.Cwd,
		})
	}
	return infos
}

type SessionInfo struct {
	SessionID string    `json:"session_id"`
	Status    string    `json:"status"`
	StartedAt time.Time `json:"started_at"`
	Agent     string    `json:"agent"`
	Cwd       string    `json:"cwd"`
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
