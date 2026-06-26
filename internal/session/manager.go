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

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

type ProcessState struct {
	SessionID        string
	Cmd              *exec.Cmd
	Cancel           context.CancelFunc
	Status           string
	StartedAt        time.Time
	LastActivityAt   time.Time // last activity timestamp (status change, message, etc.)
	Cwd              string
	Agent            string
	Source           string               // "daemon" or "terminal"
	SlashCommands    []string             // slash commands the agent reported as available (init event)
	Pid              int                  // terminal session's original PID
	TTY              string               // terminal session's TTY device (e.g. /dev/ttys002)
	ExitReason       string               // reason for process exit (terminal sessions only)
	TitleGenerated   bool                 // true once generate_title_request has been sent
	Tailer           *watcher.JSONLTailer // terminal session 的 JSONL tailer（D2: sendToIdleTerminal 期间 pause）
	PTY              *os.File             // interactive-web-session D1: daemon session 的 PTY master（写 stdin 驱动 interactive claude）
	PermissionMode   string               // current permission mode (updated by JSONL permission-mode parser)
	Model            string               // resolved model name (for session_created, surfaced to web /model)
	Effort           string               // last-set thinking-effort level (low/medium/high/xhigh/max/ultracode)
	PendingRequestID string               // non-empty while a tool-use approval request awaits a client decision
}

// SetTailer associates a JSONL tailer with a session (so sendToIdleTerminal can pause/resume it).
func (sm *SessionManager) SetTailer(sessionID string, t *watcher.JSONLTailer) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.Tailer = t
	}
}

// SetPermissionMode cycles the Claude TUI's permission mode via Shift+Tab.
// Only works for daemon (PTY) sessions. The cycle order is default→acceptEdits→plan;
// we calculate how many Shift+Tab presses are needed based on the current mode.
func (sm *SessionManager) SetPermissionMode(ctx context.Context, sessionID, targetMode string) error {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found")
	}
	if ps.Source != "daemon" || ps.PTY == nil {
		return fmt.Errorf("only daemon (interactive) sessions support runtime mode switch")
	}

	cycle := []string{"default", "acceptEdits", "plan"}
	currentIdx := indexOfString(cycle, ps.PermissionMode)
	if currentIdx == -1 {
		currentIdx = 1 // unknown → assume acceptEdits (the daemon default)
	}
	targetIdx := indexOfString(cycle, targetMode)
	if targetIdx == -1 {
		return fmt.Errorf("unsupported permission mode: %s (use default/acceptEdits/plan)", targetMode)
	}

	presses := (targetIdx - currentIdx + len(cycle)) % len(cycle)
	for i := 0; i < presses; i++ {
		if _, err := ps.PTY.Write([]byte("\x1b[Z")); err != nil { // Shift+Tab (CSI Z)
			return fmt.Errorf("pty write shift+tab: %w", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(150 * time.Millisecond): // let TUI process each press
		}
	}
	return nil
}

// ValidEffortLevels are the thinking-effort levels exposed by Claude Code's TUI
// via the /effort command. Kept in the order shown by the TUI picker.
var ValidEffortLevels = []string{"low", "medium", "high", "xhigh", "max", "ultracode"}

// isValidEffort reports whether level is one of the TUI's accepted effort values.
func isValidEffort(level string) bool {
	for _, v := range ValidEffortLevels {
		if v == level {
			return true
		}
	}
	return false
}

// SetEffort switches the Claude TUI's thinking-effort level for a daemon (PTY)
// session by injecting `/effort <level>` followed by Enter, mirroring how a
// user would type it in the terminal. Only daemon sessions support runtime
// effort switching. The chosen level is recorded on ProcessState so a later
// get_session_meta can surface it to the web/iOS client. Terminal sessions and
// unknown sessions return an error.
//
// Note: claude's effort level is a pure runtime TUI state — it is NOT persisted
// to JSONL or ~/.claude/settings.json, so this recorded value reflects only what
// was set via pocketctl, not what a user may type directly in the terminal.
func (sm *SessionManager) SetEffort(sessionID, level string) error {
	if !isValidEffort(level) {
		return fmt.Errorf("unsupported effort level: %s (use one of %v)", level, ValidEffortLevels)
	}
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found")
	}
	if ps.Source != "daemon" || ps.PTY == nil {
		return fmt.Errorf("only daemon (interactive) sessions support runtime effort switch")
	}

	if _, err := ps.PTY.Write([]byte("/effort " + level + "\r")); err != nil {
		return fmt.Errorf("pty write /effort: %w", err)
	}

	sm.mu.Lock()
	ps.Effort = level
	sm.mu.Unlock()
	return nil
}

// GetSessionEffort returns the last-set thinking-effort level for a session, or
// "" if none has been set / the session is unknown. Used by get_session_meta.
func (sm *SessionManager) GetSessionEffort(sessionID string) string {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		return ""
	}
	return ps.Effort
}

// InterruptSession stops the agent's current generation without killing the
// session. For daemon (PTY) sessions it writes Ctrl+C (\x03) to the PTY,
// which Claude's TUI interprets as "interrupt current turn". For terminal
// sessions it cancels the --resume subprocess. The session stays alive and
// returns to idle state (driven by the JSONL tailer or the resume goroutine).
func (sm *SessionManager) InterruptSession(sessionID string) error {
	sm.mu.RLock()
	ps, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found")
	}

	if ps.Source == "daemon" && ps.PTY != nil {
		// Ctrl+C (ETX) — Claude TUI stops the current generation and returns
		// to the input prompt. The JSONL tailer will push an idle status.
		if _, err := ps.PTY.Write([]byte{0x03}); err != nil {
			return fmt.Errorf("pty write ctrl+c: %w", err)
		}
		return nil
	}

	// Terminal session: cancel the --resume subprocess.
	if ps.Cancel != nil {
		ps.Cancel()
	}
	return nil
}

// UpdatePermissionMode records the current permission mode (called when a
// permission_mode_changed event is received from the JSONL tailer).
func (sm *SessionManager) UpdatePermissionMode(sessionID, mode string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.PermissionMode = mode
	}
}

// GetPermissionMode returns the current permission mode for a session.
func (sm *SessionManager) GetPermissionMode(sessionID string) string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		return ps.PermissionMode
	}
	return ""
}

func indexOfString(slice []string, val string) int {
	for i, v := range slice {
		if v == val {
			return i
		}
	}
	return -1
}

// NotifyFunc is called after a web→terminal message completes.
type NotifyFunc func(sessionID, ttyPath string)

type SessionManager struct {
	mu                  sync.RWMutex
	sessions            map[string]*ProcessState
	outputCh            chan protocol.DaemonEvent
	childPids           map[int]bool                    // PIDs of daemon-spawned processes
	OnNotifyTerminal    NotifyFunc                      // callback after --resume on terminal session
	OnSessionIDResolved func(realSessionID, cwd string) // callback when daemon session gets real ID

	// approvals brokers PreToolUse hook approvals for non-bypass daemon sessions.
	// nil on daemons that don't surface approvals (or before wiring).
	approvals       *approval.Server
	pocketctlPath   string // path to this binary, for the hook command
	approvalEnabled bool   // set once an approval server is attached
}

func NewSessionManager(outputCh chan protocol.DaemonEvent) *SessionManager {
	return &SessionManager{
		sessions:  make(map[string]*ProcessState),
		outputCh:  outputCh,
		childPids: make(map[int]bool),
	}
}

// SetApprovalServer wires the in-process approval broker. The server's
// OnRequest callback is set to forward each tool-use request to clients as an
// approval_request event. Must be called before any non-bypass session is
// created. pocketctlPath is the daemon binary path the PreToolUse hook invokes.
func (sm *SessionManager) SetApprovalServer(srv *approval.Server, pocketctlPath string) {
	sm.approvals = srv
	sm.pocketctlPath = pocketctlPath
	sm.approvalEnabled = true
	srv.SetOnRequest(sm.handleApprovalRequest)
}

// handleApprovalRequest is the approval server's OnRequest callback. It flips
// the session to waiting_approval and emits an approval_request event so the
// web/iOS client renders an inline Yes/No card. Invoked from the server's
// accept goroutine — must not block (it only emits events).
func (sm *SessionManager) handleApprovalRequest(req approval.Request) {
	sm.mu.Lock()
	ps, ok := sm.sessions[req.SessionID]
	if ok {
		ps.Status = protocol.StatusWaitingApproval
		ps.PendingRequestID = req.RequestID
	}
	sm.mu.Unlock()

	if !ok {
		// Session gone before the request was forwarded — deny immediately so
		// the hook doesn't hang.
		_ = sm.approvals.Resolve(req.RequestID, false)
		return
	}

	sm.outputCh <- protocol.DaemonEvent{
		Type:      "approval_request",
		SessionID: req.SessionID,
		RequestID: req.RequestID,
		Tool:      req.Tool,
		Input:     req.Input,
	}
	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      req.SessionID,
		Status:         protocol.StatusWaitingApproval,
		LastActivityAt: time.Now().UTC().Format(time.RFC3339),
	}
}

// ResolveApproval delivers a client's approval decision to the blocked
// PreToolUse hook and returns the session to running. Called from the
// approval_response command handler.
func (sm *SessionManager) ResolveApproval(sessionID, requestID string, approved bool) error {
	if sm.approvals == nil {
		return fmt.Errorf("approval not configured on this daemon")
	}
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if ok && ps.PendingRequestID == requestID {
		ps.PendingRequestID = ""
		ps.Status = protocol.StatusRunning
		ps.LastActivityAt = time.Now()
	}
	sm.mu.Unlock()

	if err := sm.approvals.Resolve(requestID, approved); err != nil {
		return err
	}

	if ok {
		// Hook resolved → Claude proceeds; reflect running state to clients.
		sm.outputCh <- protocol.DaemonEvent{
			Type:           "session_status",
			SessionID:      sessionID,
			Status:         protocol.StatusRunning,
			LastActivityAt: time.Now().UTC().Format(time.RFC3339),
		}
	}
	return nil
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

// ListAvailableModels reads ~/.claude/settings.json and returns the opus/sonnet/haiku
// alias→concrete-model mapping so the web client can populate its model picker with
// the host's actual available models (not hardcoded aliases). Returns nil if
// settings.json is missing/unparseable.
func ListAvailableModels() []protocol.ModelOption {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return nil
	}
	var cfg struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	type slot struct{ alias, nameKey, modelKey string }
	slots := []slot{
		{"opus", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", "ANTHROPIC_DEFAULT_OPUS_MODEL"},
		{"sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", "ANTHROPIC_DEFAULT_SONNET_MODEL"},
		{"haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", "ANTHROPIC_DEFAULT_HAIKU_MODEL"},
	}
	var out []protocol.ModelOption
	for _, s := range slots {
		name := strings.TrimSpace(cfg.Env[s.nameKey])
		if name == "" {
			name = stripModelSuffix(cfg.Env[s.modelKey]) // fall back to raw key, strip any [...] suffix
		}
		if name == "" {
			continue
		}
		out = append(out, protocol.ModelOption{Alias: s.alias, Name: name})
	}
	return out
}

// resolveModelAlias maps a claude alias (opus/sonnet/haiku) to its concrete model name
// from ~/.claude/settings.json (e.g. haiku → glm-4.7). Used so /model shows the real
// model, while the alias is still passed to claude's --model (which resolves via
// ANTHROPIC_DEFAULT_*_MODEL, preserving e.g. [1M] context). Non-alias input is returned as-is.
func resolveModelAlias(alias string) string {
	for _, m := range ListAvailableModels() {
		if m.Alias == alias {
			return m.Name
		}
	}
	return alias
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

	// Resolve model: prefer the model the client explicitly chose (opus/sonnet/haiku
	// alias or concrete name from session_create); fall back to the host's
	// ~/.claude/settings.json default so legacy clients without a model picker
	// still surface a value for the /model command.
	if config.Model == "" {
		config.Model = resolveCleanModel()
	}
	// config.Model is the alias/name passed to claude's --model (resolves via
	// ANTHROPIC_DEFAULT_*_MODEL, preserving e.g. [1M]). Derive the concrete display
	// name for /model (haiku → glm-4.7).
	displayModel := resolveModelAlias(config.Model)

	// interactive-web-session D1: launch interactive claude under a PTY (not -p),
	// with an explicit --session-id so the JSONL file path is known up front.
	// Spike-verified: sanitized env + --session-id writes <uuid>.jsonl, and env
	// sanitization is mandatory or claude runs ephemeral (no JSONL).
	sessionID := uuid.New().String()

	// Resolve the effective permission mode BEFORE launching. Web/iOS daemon
	// sessions are unattended, so default to bypassing permission checks —
	// otherwise Bash/Write tools stall forever on a y/n prompt the UI can't
	// surface (and Ctrl+C doesn't dismiss). Callers who want stricter modes can
	// set PermissionMode explicitly.
	permMode := config.PermissionMode
	if permMode == "" {
		permMode = "bypassPermissions"
	}
	config.PermissionMode = permMode

	args := append([]string{"--session-id", sessionID}, adapter.BuildInteractiveArgs(config)...)

	// Install the approval PreToolUse hook for EVERY daemon session — including
	// bypassPermissions. Rationale: even in bypass mode, a PreToolUse hook in
	// the host's ~/.claude/settings.json can return permissionDecision:"ask",
	// which OVERRIDES bypass and forces a y/n prompt. Since the daemon discards
	// PTY stdout, that prompt would be invisible and deadlock the session. Our
	// hook runs first and, when it has no opinion (the common case), returns
	// continue so Claude's own permission logic (and any host hook) still
	// applies. We only block on the approval socket when a prompt would
	// actually be shown — which the hook decides, not the mode.
	//
	// Failure to install the hook is non-fatal: the session still runs; the
	// user simply won't get approval prompts surfaced.
	var extraEnv []string
	if sm.approvalEnabled && sm.approvals != nil {
		if err := approval.EnsureHooks(resolvedCwd, sm.pocketctlPath); err == nil {
			extraEnv = append(extraEnv,
				"POCKETCTL_SESSION_ID="+sessionID,
				"POCKETCTL_APPROVAL_SOCK="+sm.approvals.SocketPath(),
				"POCKETCTL_PERM_MODE="+permMode,
			)
		}
	}

	ctx, cancel := context.WithCancel(ctx)
	ptmx, cmd, err := startPTYCli(cliPath, args, resolvedCwd, extraEnv)
	if err != nil {
		cancel()
		return "", fmt.Errorf("start pty claude: %w", err)
	}

	now := time.Now()
	ps := &ProcessState{
		SessionID:      sessionID, // real id (not pending-): --session-id pins it
		Cmd:            cmd,
		Cancel:         cancel,
		Status:         protocol.StatusIdle, // PTY up, awaiting first input
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            resolvedCwd,
		Agent:          config.Agent,
		Source:         "daemon",
		PTY:            ptmx,
		PermissionMode: permMode,
		Model:          displayModel,
	}
	sm.mu.Lock()
	sm.sessions[sessionID] = ps
	if cmd.Process != nil {
		sm.childPids[cmd.Process.Pid] = true
		ps.Pid = cmd.Process.Pid
	}
	sm.mu.Unlock()

	// Emit the initial prompt as user_text for immediate Web/iOS UI feedback.
	// (PTY claude also writes the user record to JSONL; emitting early gives
	// instant UI render while the PTY settles.)
	if config.Prompt != "" {
		sm.outputCh <- protocol.DaemonEvent{
			Type:      "user_text",
			SessionID: sessionID,
			Text:      config.Prompt,
		}
	}

	// Background lifecycle: wait for JSONL → tailer (output) → initial prompt →
	// crash monitor.
	go sm.servePTYSession(ctx, ps, config.Prompt)
	return sessionID, nil
}

// servePTYSession runs the background lifecycle for a daemon PTY session:
// waits for the JSONL history file to appear, starts the JSONL tailer (the
// structured output channel — interactive-web-session D2), writes the initial
// prompt once the PTY has settled (D4), and monitors the process for exit (D7).
func (sm *SessionManager) servePTYSession(ctx context.Context, ps *ProcessState, initialPrompt string) {
	// Drain PTY stdout continuously. claude's TUI writes constantly (banner,
	// spinner, …); if nobody reads the PTY master, its buffer fills and claude
	// blocks. We discard the TUI bytes; structured output comes via JSONL (D2).
	go func() {
		_, _ = io.Copy(io.Discard, ps.PTY)
	}()

	// Submit the initial prompt after the TUI settles (~10s to render banner +
	// plugins). IMPORTANT: do NOT wait for the JSONL file here — claude only
	// writes JSONL after the first turn is processed, so gating the prompt on
	// JSONL existence deadlocks (no message → no turn → no JSONL → no prompt).
	if initialPrompt != "" {
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
		if ps.PTY != nil {
			_, _ = ps.PTY.Write([]byte(initialPrompt + "\r"))
		}
	}

	// Start the JSONL tailer once the file appears (after the first turn). Runs
	// concurrently so it's ready whenever claude writes.
	go func() {
		var tailer *watcher.JSONLTailer
		for i := 0; i < 120; i++ { // up to ~60s after the prompt
			select {
			case <-ctx.Done():
				return
			default:
			}
			// Re-resolve each iteration — the JSONL file only appears after
			// claude's first turn, and ResolveJSONLPath returns err until then.
			if jsonlPath, err := watcher.ResolveJSONLPath(ps.SessionID, ps.Cwd); err == nil {
				if t, e := watcher.NewJSONLTailerFromStart(jsonlPath); e == nil {
					tailer = t
					break
				}
			}
			time.Sleep(500 * time.Millisecond)
		}
		if tailer == nil {
			// JSONL file never appeared within 60s — claude may be running
			// ephemeral (env contamination) or crashed during startup. Notify
			// clients instead of leaving the UI stuck on "no response".
			sm.outputCh <- protocol.DaemonEvent{
				Type:      "error",
				SessionID: ps.SessionID,
				Error:     "会话未生成输出（JSONL 文件未创建）。可能原因：claude 以临时模式运行或启动失败。请检查 claude 是否正确安装且环境变量无冲突。",
			}
			// Also mark the session as errored so the UI doesn't stay in
			// "creating" / "running" limbo.
			sm.mu.Lock()
			if s, ok := sm.sessions[ps.SessionID]; ok {
				s.Status = protocol.StatusError
			}
			sm.mu.Unlock()
			sm.outputCh <- protocol.DaemonEvent{
				Type:      "session_status",
				SessionID: ps.SessionID,
				Status:    protocol.StatusError,
			}
			return
		}
		sm.SetTailer(ps.SessionID, tailer)
		// If the initial prompt is a slash command, record it so the first
		// command_receipt (if any) carries the correct command name.
		if initialPrompt != "" {
			tailer.SetPendingCmd(initialPrompt)
		}
		go tailer.Run(ctx, sm.outputCh, nil)
		if sm.OnSessionIDResolved != nil {
			sm.OnSessionIDResolved(ps.SessionID, ps.Cwd)
		}
	}()

	// Monitor process exit (crash detection, D7).
	done := make(chan struct{})
	go func() {
		_ = ps.Cmd.Wait()
		close(done)
	}()

	// Watchdog: if a busy session has no JSONL activity for >5 minutes, the
	// agent is likely stuck (e.g. a long-running tool call blocked the PTY,
	// or a daemon restart caused the tailer to miss the idle event). Recover
	// by forcing the status back to idle so the UI is not stuck on "executing".
	go sm.watchdogBusy(ctx, ps.SessionID)

	select {
	case <-ctx.Done():
		return
	case <-done:
		sm.handlePTYExit(ps)
	}
}

// watchdogBusy monitors a session for stuck "busy" state. If the session
// remains busy with no JSONL file activity for longer than busyTimeout, it
// forces the status back to idle and notifies clients — preventing the UI
// from being permanently stuck on "executing" when the agent's idle event
// was missed (daemon restart, long tool calls, PTY I/O blockage).
//
// "No activity" is determined by the JSONL file's last modification time,
// NOT LastActivityAt (which is only updated on SendMessage for PTY sessions).
// This correctly distinguishes "agent is thinking (JSONL growing)" from
// "agent is truly stuck (JSONL not changing)".
func (sm *SessionManager) watchdogBusy(ctx context.Context, sessionID string) {
	const busyTimeout = 5 * time.Minute
	const checkInterval = 30 * time.Second

	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sm.mu.Lock()
			ps, ok := sm.sessions[sessionID]
			if !ok {
				sm.mu.Unlock()
				return
			}
			if ps.Status != protocol.StatusRunning {
				sm.mu.Unlock()
				continue // not busy — nothing to fix
			}
			cwd := ps.Cwd
			sm.mu.Unlock()

			// Check JSONL file modification time — the authoritative signal
			// for whether the agent is still producing output.
			jsonlPath, err := watcher.ResolveJSONLPath(sessionID, cwd)
			if err != nil {
				continue // can't determine — don't force
			}
			info, err := os.Stat(jsonlPath)
			if err != nil {
				continue // file gone — don't force (process exit handler covers this)
			}
			elapsed := time.Since(info.ModTime())
			if elapsed < busyTimeout {
				continue // JSONL still being written — agent is working normally
			}

			// Stuck: no JSONL activity for >5min while busy → force back to idle.
			sm.mu.Lock()
			ps, ok = sm.sessions[sessionID]
			if !ok || ps.Status != protocol.StatusRunning {
				sm.mu.Unlock()
				continue
			}
			ps.Status = protocol.StatusIdle
			ps.LastActivityAt = time.Now()
			sm.mu.Unlock()

			// Notify clients so the UI un-sticks from "executing".
			sm.outputCh <- protocol.DaemonEvent{
				Type:      "session_status",
				SessionID: sessionID,
				Status:    protocol.StatusIdle,
			}
		}
	}
}

// handlePTYExit records the exit status of a daemon PTY session and notifies
// clients. interactive-web-session D7.
func (sm *SessionManager) handlePTYExit(ps *ProcessState) {
	sm.mu.Lock()
	exitCode := -1
	if ps.Cmd.ProcessState != nil {
		exitCode = ps.Cmd.ProcessState.ExitCode()
	}
	if exitCode == 0 {
		ps.Status = protocol.StatusExited
		ps.ExitReason = protocol.ExitReasonNormalExit
	} else {
		ps.Status = protocol.StatusError
		ps.ExitReason = protocol.ExitReasonProcessCrash
	}
	if ps.PTY != nil {
		_ = ps.PTY.Close()
		ps.PTY = nil
	}
	status := ps.Status
	reason := ps.ExitReason
	sid := ps.SessionID
	cwd := ps.Cwd
	sm.mu.Unlock()

	// Drain any pending tool-use approval so the hook process exits promptly,
	// and remove the PreToolUse hook we injected into the project settings.
	if sm.approvals != nil {
		sm.approvals.DrainSession(sid)
	}
	if cwd != "" {
		_ = approval.RemoveHooks(cwd)
	}

	sm.outputCh <- protocol.DaemonEvent{
		Type:       "session_status",
		SessionID:  sid,
		Status:     status,
		ExitReason: reason,
	}
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
	sm.mu.RUnlock()
	if !ok {
		// Not in memory. A daemon restart loses the in-memory map, but a session
		// still shown in the web UI (persisted in the relay DB) usually has its
		// JSONL history on disk. Resume it via `claude --resume` so the user can
		// keep talking instead of hitting "session not found". Registered as
		// source=terminal/status=exited, so the --resume path below drives it.
		// Falls back to "session not found" only if no JSONL exists either.
		if !sm.tryResumeHistorical(sessionID) {
			return fmt.Errorf("session not found: %s", sessionID)
		}
		sm.mu.RLock()
		ps, ok = sm.sessions[sessionID]
		sm.mu.RUnlock()
		if !ok {
			return fmt.Errorf("session not found: %s", sessionID)
		}
	}
	// ps is non-nil here — safe to read fields.
	sm.mu.RLock()
	cwd := ps.Cwd
	isRunning := ps.Status == protocol.StatusRunning || ps.Status == "busy"
	isExited := ps.Status == protocol.StatusExited
	source := ps.Source
	pid := ps.Pid
	sm.mu.RUnlock()
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

	// interactive-web-session D1/D4: daemon (web-created) session writes the
	// message to the persistent PTY claude's stdin (CR-terminated). No respawn —
	// the same interactive process handles all messages, preserving context.
	if source == "daemon" {
		sm.mu.RLock()
		ptyFile := ps.PTY
		sm.mu.RUnlock()
		if ptyFile == nil || !isProcessAlive(pid) {
			return fmt.Errorf("daemon session interactive pty unavailable (process exited)")
		}
		// Emit user_text for UI (the tailer also forwards claude's own records).
		sm.outputCh <- protocol.DaemonEvent{
			Type:      "user_text",
			SessionID: ps.SessionID,
			Text:      content,
		}
		sm.mu.Lock()
		ps.Status = protocol.StatusRunning
		ps.LastActivityAt = time.Now()
		sm.mu.Unlock()
		// B (web-post-send-feedback): notify web the turn is running. PTY interactive
		// mode previously omitted this, so the UI had no "working" feedback until
		// the adapter emitted Completed at turn end.
		sm.outputCh <- protocol.DaemonEvent{
			Type:           "session_status",
			SessionID:      ps.SessionID,
			Status:         protocol.StatusRunning,
			LastActivityAt: time.Now().UTC().Format(time.RFC3339),
		}
		if _, err := ptyFile.Write([]byte(content + "\r")); err != nil {
			// B: stdin write failed — roll back so web doesn't sit on "running" forever.
			sm.mu.Lock()
			ps.Status = protocol.StatusError
			sm.mu.Unlock()
			sm.outputCh <- protocol.DaemonEvent{
				Type:      "session_status",
				SessionID: ps.SessionID,
				Status:    protocol.StatusError,
			}
			return fmt.Errorf("pty stdin write: %w", err)
		}
		// Record the slash command (if any) so the tailer's JSONLStreamParser
		// can attach it to the next command_receipt (e.g. /compact, /clear).
		if ps.Tailer != nil {
			ps.Tailer.SetPendingCmd(content)
		}
		return nil
	}

	// Below: terminal session in exited state — resume via a new claude --resume
	// process. (daemon sessions no longer reach here — they return above.)
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

// tryResumeHistorical re-registers a session that exists on disk (JSONL
// history) but isn't in the in-memory map — typically a session from before
// the current daemon process started, still listed in the web UI from the
// relay DB. It locates the JSONL, extracts the cwd, and registers the session
// as terminal/exited so SendMessage's existing --resume path drives it.
// Returns false only if no JSONL exists (genuinely unknown session).
func (sm *SessionManager) tryResumeHistorical(sessionID string) bool {
	jsonlPath, err := watcher.ResolveJSONLPath(sessionID, "")
	if err != nil {
		return false
	}
	cwd := extractCwdFromJSONL(jsonlPath)
	if cwd == "" {
		// Fallback: decode cwd from the projects dir name (-Users-foo-bar →
		// /Users/foo/bar). Less reliable (collapses internal hyphens) but
		// better than an empty cwd.
		cwd = cwdFromProjectsDir(jsonlPath)
	}
	now := time.Now()
	sm.mu.Lock()
	defer sm.mu.Unlock()
	// Re-check under lock: another goroutine may have registered it concurrently.
	if _, exists := sm.sessions[sessionID]; exists {
		return true
	}
	sm.sessions[sessionID] = &ProcessState{
		SessionID:      sessionID,
		Status:         protocol.StatusExited,
		Source:         "terminal",
		StartedAt:      now,
		LastActivityAt: now,
		Cwd:            cwd,
		Agent:          "claude-code",
	}
	return true
}

// extractCwdFromJSONL reads the first records of a session's JSONL and returns
// the cwd field. Each line is a JSON object; cwd is present on most records.
func extractCwdFromJSONL(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for i := 0; i < 200 && scanner.Scan(); i++ {
		var rec struct {
			Cwd string `json:"cwd"`
		}
		if json.Unmarshal(scanner.Bytes(), &rec) == nil && rec.Cwd != "" {
			return rec.Cwd
		}
	}
	return ""
}

// cwdFromProjectsDir decodes a cwd from a JSONL path's projects dir name
// (~/.claude/projects/-Users-foo-bar/x.jsonl → /Users/foo/bar).
func cwdFromProjectsDir(jsonlPath string) string {
	dir := filepath.Base(filepath.Dir(jsonlPath))
	if !strings.HasPrefix(dir, "-") {
		return ""
	}
	return "/" + strings.ReplaceAll(dir[1:], "-", "/")
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
	// D1: capture stdout stream-json + adapter (unified command feedback path, like daemon sessions).
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start --resume: %w", err)
	}

	adp := adapter.NewClaudeAdapter(content)
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

	// D2: pause the JSONL tailer while this --resume runs to avoid double-forwarding
	// (stdout adapter covers all events; tailer would re-read the same JSONL lines).
	if ps.Tailer != nil {
		ps.Tailer.Pause()
	}

	// Wait for --resume to finish in background; forward stdout events via adapter.
	go func() {
		defer func() {
			if ps.Tailer != nil {
				ps.Tailer.Resume()
			}
		}()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		for scanner.Scan() {
			events, perr := adp.ParseStreamLine(scanner.Text())
			if perr != nil {
				continue
			}
			for _, evt := range events {
				if evt.SessionID == "" {
					evt.SessionID = ps.SessionID
				}
				sm.outputCh <- evt
			}
		}
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
	cwd := ""
	if ok {
		cwd = ps.Cwd
	}
	sm.mu.Unlock()
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	if ps.Cancel != nil {
		ps.Cancel()
	}
	// Drain any pending tool-use approval so the hook process exits promptly.
	if sm.approvals != nil {
		sm.approvals.DrainSession(sessionID)
	}
	// interactive-web-session D7/6.2: for PTY daemon sessions, try a graceful
	// /exit, then ensure the PTY master is closed on return.
	sm.mu.RLock()
	ptyFile := ps.PTY
	sm.mu.RUnlock()
	if ptyFile != nil {
		_, _ = ptyFile.Write([]byte("/exit\r"))
		defer ptyFile.Close()
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
			if cwd != "" {
				_ = approval.RemoveHooks(cwd)
			}
			return nil
		}
	}
	if cwd != "" {
		_ = approval.RemoveHooks(cwd)
	}
	return nil
}

func (sm *SessionManager) ListSessions() []SessionInfo {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	var active, exited []SessionInfo
	for id, ps := range sm.sessions {
		info := SessionInfo{
			SessionID:      id,
			Status:         ps.Status,
			StartedAt:      ps.StartedAt,
			LastActivityAt: ps.LastActivityAt,
			Agent:          ps.Agent,
			Cwd:            ps.Cwd,
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

// GetSessionModel returns the resolved model name for a session (the same value
// passed to claude via --model at launch). Surfaced to the web client via the
// session_created event so /model can show the active model. The bool indicates
// whether the session exists.
func (sm *SessionManager) GetSessionModel(sessionID string) (string, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return "", false
	}
	return ps.Model, true
}

// SetSessionModel caches the resolved model for a session — e.g. a model extracted
// from a terminal session's JSONL on first get_session_meta, so subsequent reads are free.
func (sm *SessionManager) SetSessionModel(sessionID, model string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.Model = model
	}
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
	SessionID      string    `json:"session_id"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"started_at"`
	LastActivityAt time.Time `json:"last_activity_at"`
	Agent          string    `json:"agent"`
	Cwd            string    `json:"cwd"`
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
