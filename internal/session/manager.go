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
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/discovery"
	"github.com/pocketctl/pocketctl/internal/filelock"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/ptyscan"
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
	PTY              platform.PTY         // interactive-web-session D1: daemon session 的 PTY master（写 stdin 驱动 interactive claude）。PR2: platform.PTY interface (was *os.File)
	PTYScanner       *ptyscan.Scanner     // daemon session 的 PTY 菜单扫描器（捕获 TUI 选择提示，转成 interactive_prompt 事件）
	PermissionMode   string               // current permission mode (updated by JSONL permission-mode parser)
	Model            string               // resolved model name (for session_created, surfaced to web /model)
	Effort           string               // last-set thinking-effort level (low/medium/high/xhigh/max/ultracode)
	PendingRequestID string               // non-empty while a tool-use approval request awaits a client decision
	WorktreePath     string               // Scheme D: non-empty when the session runs inside a git worktree
	WorktreeBranch   string               // Scheme D: the git branch backing the worktree
	Backend          SessionBackend       // non-nil only for server-kind agents (opencode); subprocess agents drive via the fields above
}

// SetTailer associates a JSONL tailer with a session (so sendToIdleTerminal can pause/resume it).
func (sm *SessionManager) SetTailer(sessionID string, t *watcher.JSONLTailer) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		ps.Tailer = t
	}
}

// NotifyFunc is called after a web→terminal message completes.
type NotifyFunc func(sessionID, ttyPath string)

// Platform providers used by default for new SessionManagers. Override per-
// instance via SetProviders (e.g. tests inject mocks). Unix: real creack/pty
// + signal backend; Windows: stubs returning ErrUnsupported (PR4 fills these).
// PR2: replaces session's direct creack/pty + syscall dependency.
var (
	defaultPTYProvider = platform.NewPTYProvider()
	defaultProc        = platform.NewProcessController()
)

type SessionManager struct {
	mu                  sync.RWMutex
	sessions            map[string]*ProcessState
	outputCh            chan protocol.DaemonEvent
	childPids           map[int]bool                    // PIDs of daemon-spawned processes
	OnNotifyTerminal    NotifyFunc                      // callback after --resume on terminal session
	OnSessionIDResolved func(realSessionID, cwd string) // callback when daemon session gets real ID
	ptyProvider         platform.PTYProvider            // PR2: daemon-session PTY backend (was direct creack/pty)
	proc                platform.ProcessController      // PR2: process alive/kill (was syscall; used by Task 3)

	// approvals brokers PreToolUse hook approvals for non-bypass daemon sessions.
	// nil on daemons that don't surface approvals (or before wiring).
	approvals       *approval.Server
	pocketctlPath   string // path to this binary, for the hook command
	approvalEnabled bool   // set once an approval server is attached

	// Scheme A: cwd → active session ID set, for "directory already in use"
	// awareness. Keyed by normalized absolute path (normalizeCwd).
	cwdSessions map[string]map[string]struct{}

	// Scheme C: file-level lock manager coordinating concurrent edits across
	// sessions that share a working directory. Shared with the approval server.
	fileLocks *filelock.LockManager

	// opencode coordinates the shared `opencode serve` process and its SSE demux
	// for server-kind (opencode) sessions. Lazily created on first use.
	opencode *opencodeCoordinator
}

func NewSessionManager(outputCh chan protocol.DaemonEvent) *SessionManager {
	return &SessionManager{
		sessions:    make(map[string]*ProcessState),
		outputCh:    outputCh,
		childPids:   make(map[int]bool),
		cwdSessions: make(map[string]map[string]struct{}),
		fileLocks:   filelock.New(),
		ptyProvider: defaultPTYProvider,
		proc:        defaultProc,
	}
}

// SetProviders overrides the platform providers, for tests injecting mocks.
// Must be called before any session is created. Not needed in production
// (NewSessionManager wires the real platform defaults).
func (sm *SessionManager) SetProviders(pty platform.PTYProvider, proc platform.ProcessController) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.ptyProvider = pty
	sm.proc = proc
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
	srv.SetOnCancel(sm.handleApprovalCancel)
	// Share the file-lock manager so the approval server can deny Edit/Write on
	// files held by other sessions (Scheme C), even in bypassPermissions mode.
	srv.SetFileLockManager(sm.fileLocks)
}

func (sm *SessionManager) CreateSession(ctx context.Context, config protocol.SessionConfig) (string, error) {
	cliPath, err := findAgentCLI(config.Agent)
	if err != nil {
		return "", err
	}

	// Server-kind agents (opencode) are driven via a SessionBackend (shared
	// `opencode serve` + SSE), not the PTY spawn flow below.
	if adapter.BackendKindFor(config.Agent) == adapter.BackendServer {
		return sm.createOpencodeSession(ctx, config)
	}

	// --- Working directory resolution --------------------------------------
	// Order: resolve → (Scheme D worktree) → (auto-create) → validate →
	// (Scheme A cwd-in-use) → register. Each step may redirect resolvedCwd.
	resolvedCwd := resolveCwd(config.Cwd)

	// We need the session id early so the worktree branch/path is deterministic
	// and the cwd registry can record it before any concurrent CreateSession.
	sessionID := uuid.New().String()

	// Scheme D: isolate the session in a git worktree so concurrent sessions on
	// the same repo never touch the same files. The worktree lives at
	// <repo>/.pocketctl/wt-<short> on branch pocketctl/<short>. It is intentionally
	// NOT cleaned up on exit (decision: preserve uncommitted work).
	var worktreePath, worktreeBranch string
	if config.Worktree {
		wtPath, branch, werr := createWorktree(resolvedCwd, sessionID)
		if werr != nil {
			return "", fmt.Errorf("工作目录 worktree 创建失败: %w", werr)
		}
		worktreePath, worktreeBranch = wtPath, branch
		resolvedCwd = wtPath // all downstream logic targets the worktree
	} else if config.AutoCreateDir {
		// Auto-create a missing cwd (only in non-worktree mode; worktrees are
		// created by git). Best-effort: if the dir exists this is a no-op, and
		// permission errors still surface via validateCwd below.
		_ = os.MkdirAll(resolvedCwd, 0o755)
	}

	if err := validateCwd(resolvedCwd); err != nil {
		return "", err
	}

	// Scheme A: warn when the target cwd already has active sessions. Clients
	// opt-in to ignoring the warning by sending Force=true (informed consent).
	if !config.Force {
		if n := sm.CwdSessionCount(resolvedCwd); n > 0 {
			return "", fmt.Errorf("目录已被占用: %s (当前已有 %d 个活跃会话；如需继续请在客户端勾选\"强制创建\"后重试)", resolvedCwd, n)
		}
	}

	// Resolve model: prefer the model the client explicitly chose. For Claude,
	// fall back to the host's ~/.claude/settings.json default (opus/sonnet/haiku
	// alias resolution) so legacy clients without a model picker still surface a
	// value. Other agents (codex) don't read ~/.claude — leave model empty and
	// let the agent pick its own default.
	displayModel := config.Model
	if config.Agent == "" || config.Agent == adapter.AgentClaude {
		if config.Model == "" {
			config.Model = resolveCleanModel()
		}
		// config.Model is the alias/name passed to claude's --model (resolves via
		// ANTHROPIC_DEFAULT_*_MODEL, preserving e.g. [1M]). Derive the concrete
		// display name for /model (haiku → glm-4.7).
		displayModel = resolveModelAlias(config.Model)
	}

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

	// Build launch args via the agent-specific launcher. Claude takes a pinned
	// --session-id so the JSONL filename is known up front; codex generates its
	// own rollout filename (discovered later by globbing the sessions dir).
	launcher := adapter.NewLauncher(config.Agent)
	args := launcher.BuildInteractiveArgs(config)
	if config.Agent == "" || config.Agent == adapter.AgentClaude {
		args = append([]string{"--session-id", sessionID}, args...)
	}

	// Install the approval PreToolUse hook for Claude daemon sessions only —
	// including bypassPermissions. Rationale: even in bypass mode, a PreToolUse
	// hook in the host's ~/.claude/settings.json can return
	// permissionDecision:"ask", which OVERRIDES bypass and forces a y/n prompt.
	// Since the daemon discards PTY stdout, that prompt would be invisible and
	// deadlock the session. Our hook runs first and, when it has no opinion (the
	// common case), returns continue so Claude's own permission logic (and any
	// host hook) still applies. We only block on the approval socket when a
	// prompt would actually be shown — which the hook decides, not the mode.
	//
	// Other agents (codex) don't have a PreToolUse hook mechanism, so this is
	// skipped — they rely on their own --ask-for-approval flag instead.
	//
	// Failure to install the hook is non-fatal: the session still runs; the
	// user simply won't get approval prompts surfaced.
	var extraEnv []string
	caps := adapter.Capabilities(config.Agent)
	if caps.SupportsApprovalHook && sm.approvalEnabled && sm.approvals != nil {
		if err := approval.EnsureHooks(resolvedCwd, sm.pocketctlPath); err == nil {
			extraEnv = append(extraEnv,
				"POCKETCTL_SESSION_ID="+sessionID,
				"POCKETCTL_APPROVAL_SOCK="+sm.approvals.SocketPath(),
				"POCKETCTL_PERM_MODE="+permMode,
			)
		}
	}

	ctx, cancel := context.WithCancel(ctx)
	ptmx, cmd, err := startPTYCli(sm.ptyProvider, cliPath, args, resolvedCwd, extraEnv, config.Agent)
	if err != nil {
		cancel()
		return "", fmt.Errorf("start pty %s: %w", config.Agent, err)
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
		WorktreePath:   worktreePath,
		WorktreeBranch: worktreeBranch,
	}
	sm.mu.Lock()
	sm.sessions[sessionID] = ps
	if cmd.Process != nil {
		sm.childPids[cmd.Process.Pid] = true
		ps.Pid = cmd.Process.Pid
	}
	sm.mu.Unlock()

	// Scheme A: register the session against its cwd so later CreateSession
	// calls can warn. Worktree sessions register under their worktree path.
	sm.registerCwd(sessionID, resolvedCwd)

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
	// blocks. Structured output still comes via JSONL (D2), but we also feed
	// the bytes to a PTY menu scanner so inline selection prompts the TUI draws
	// (e.g. a host PreToolUse hook's "Do you want to proceed? ❶ Yes ❷ No") are
	// surfaced to clients as interactive_prompt cards instead of being lost.
	ps.PTYScanner = ptyscan.NewScanner(ps.SessionID)
	go sm.drainPTY(ctx, ps)

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
			// the agent's first turn, and the path resolver returns err until then.
			if jsonlPath, err := adapter.ResolveJSONLPathFor(ps.Agent, ps.SessionID, ps.Cwd); err == nil {
				if t, e := watcher.NewJSONLTailerFromStart(jsonlPath, ps.Agent); e == nil {
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

// drainPTY reads the PTY master until EOF, feeding every chunk to the session's
// menu scanner. This keeps the PTY buffer drained (so the agent's TUI doesn't
// block) AND lets the scanner surface inline selection prompts as
// interactive_prompt events. Runs once per daemon session; exits when the PTY
// master is closed (session exit / kill).
func (sm *SessionManager) drainPTY(ctx context.Context, ps *ProcessState) {
	buf := make([]byte, 4096)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		n, err := ps.PTY.Read(buf)
		if n > 0 && ps.PTYScanner != nil {
			// Forward a copy so the scanner can retain bytes across reads.
			for _, ev := range ps.PTYScanner.Feed(append([]byte(nil), buf[:n]...)) {
				select {
				case sm.outputCh <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
		if err != nil {
			// EOF / closed master: session is exiting; handlePTYExit closes the fd.
			return
		}
	}
}

// ResolveInteractivePrompt writes the user's menu choice back to the PTY so the
// agent's blocking selection prompt proceeds. The choice is the on-screen option
// index (e.g. "1"); we append a CR the same way SendMessage submits chat input.
// requestID must match the scanner's currently-active prompt or the response is
// rejected (stale/late answer for an already-resolved or superseded prompt).
func (sm *SessionManager) ResolveInteractivePrompt(sessionID, requestID, choice string) error {
	if choice == "" {
		return fmt.Errorf("empty choice")
	}

	// opencode sessions answer questions via the serve API. choice is the
	// selected option label; opencode expects answers as [[label]].
	if b := sm.opencodeBackendFor(sessionID); b != nil {
		return b.coord.server.ReplyQuestion(context.Background(), sessionID, requestID, [][]string{{choice}})
	}

	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	scanner := ps.PTYScanner
	ptyFile := ps.PTY
	// Validate and claim the pending prompt atomically: a matching requestID
	// clears the scanner's active state so a concurrent/duplicate answer can't
	// write twice.
	if ok && (scanner == nil || scanner.ActiveRequestID() != requestID) {
		active := ""
		if scanner != nil {
			active = scanner.ActiveRequestID()
		}
		sm.mu.Unlock()
		return fmt.Errorf("interactive prompt %q not pending (active=%q)", requestID, active)
	}
	if scanner != nil {
		scanner.Reset()
	}
	sm.mu.Unlock()

	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	if ptyFile == nil {
		return fmt.Errorf("session %s PTY already closed", sessionID)
	}
	if _, err := ptyFile.Write([]byte(choice + "\r")); err != nil {
		return fmt.Errorf("write choice to PTY: %w", err)
	}
	return nil
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
	wtPath := ps.WorktreePath
	wtBranch := ps.WorktreeBranch
	sm.mu.Unlock()

	// Drain any pending tool-use approval so the hook process exits promptly,
	// and remove the PreToolUse hook we injected into the project settings.
	if sm.approvals != nil {
		sm.approvals.DrainSession(sid)
	}
	if cwd != "" {
		_ = approval.RemoveHooks(cwd)
	}
	// Scheme A/C: release the cwd registry slot and all file locks held by
	// this session so other sessions on the same directory can proceed.
	sm.unregisterCwd(sid, cwd)
	if sm.fileLocks != nil {
		sm.fileLocks.ReleaseAll(sid)
	}

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sid,
		Status:         status,
		ExitReason:     reason,
		WorktreePath:   wtPath,
		WorktreeBranch: wtBranch,
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

// ReviveTerminalSessionOnActivity is called from the JSONL tail loop when fresh
// events arrive. It always refreshes LastActivityAt; additionally, if the session
// had gone dormant (exited/completed/error/killed) it flips it back to running and
// emits session_status. This is what makes an `exit` → `claude --continue` resume
// reappear as live: the original session's tailer stays alive across the exit, so
// when --continue appends to the same <id>.jsonl the renewed output revives the
// original card instead of leaving it frozen at "exited".
func (sm *SessionManager) ReviveTerminalSessionOnActivity(sessionID string) {
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	now := time.Now()
	ps.LastActivityAt = now
	dormant := ps.Status == protocol.StatusExited || ps.Status == protocol.StatusCompleted ||
		ps.Status == protocol.StatusError || ps.Status == protocol.StatusKilled
	if !dormant {
		sm.mu.Unlock()
		return
	}
	ps.Status = protocol.StatusRunning
	ps.ExitReason = ""
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         protocol.StatusRunning,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

func (sm *SessionManager) readOutput(ctx context.Context, cmd *exec.Cmd, stdout io.Reader, adp adapter.AgentAdapter, ps *ProcessState) {
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
	// Server-kind sessions (opencode) are driven via their SessionBackend over
	// HTTP; the reply is forwarded by the SSE demux (owned) or DirWatch (terminal).
	if ps.Backend != nil {
		sm.mu.Lock()
		ps.LastActivityAt = time.Now()
		src := ps.Source
		sm.mu.Unlock()
		// Echo the user's message for instant feedback only for owned sessions:
		// the SSE demux skips the user echo, so we supply it here. Terminal
		// sessions get their user_text from DirWatch (storage), so echoing here
		// would duplicate.
		if src != "terminal" {
			sm.outputCh <- protocol.DaemonEvent{Type: "user_text", SessionID: sessionID, Text: content}
		}
		return ps.Backend.Send(ctx, sessionID, content)
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

	// Below: terminal session in exited state — resume via a new one-shot process
	// (claude -p --resume / codex exec resume). (daemon sessions no longer reach
	// here — they return above.)
	agentType := ps.Agent
	if agentType == "" {
		agentType = adapter.AgentClaude
	}
	cliPath, err := findAgentCLI(agentType)
	if err != nil {
		return err
	}
	launcher := adapter.NewLauncher(agentType)
	args := launcher.BuildResumeArgs(content, sessionID, protocol.SessionConfig{PermissionMode: "acceptEdits"})
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

	adp := adapter.NewAdapter(agentType, content)
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
// Uses a one-shot resume (claude --resume / codex exec resume) without stdout capture — the JSONL
// tailer handles event forwarding.
func (sm *SessionManager) sendToIdleTerminal(ctx context.Context, ps *ProcessState, content string) error {
	agentType := ps.Agent
	if agentType == "" {
		agentType = adapter.AgentClaude
	}
	cliPath, err := findAgentCLI(agentType)
	if err != nil {
		return err
	}

	launcher := adapter.NewLauncher(agentType)
	args := launcher.BuildResumeArgs(content, ps.SessionID, protocol.SessionConfig{PermissionMode: "acceptEdits"})
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

	adp := adapter.NewAdapter(agentType, content)
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
// PR2: delegates to the platform ProcessController (was syscall.Kill), so
// session no longer imports syscall.
func isProcessAlive(pid int) bool {
	return defaultProc.IsAlive(pid)
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
			// Force kill if still running (PR2: via platform ProcessController, was syscall.SIGKILL)
			if ps.Cmd.Process != nil {
				_ = defaultProc.Kill(ps.Cmd.Process.Pid)
			}
			sm.mu.Lock()
			ps.Status = protocol.StatusKilled
			ps.LastActivityAt = time.Now()
			sm.mu.Unlock()
			if cwd != "" {
				_ = approval.RemoveHooks(cwd)
			}
			// Scheme A/C: release cwd registry + file locks on forced kill.
			sm.unregisterCwd(sessionID, cwd)
			if sm.fileLocks != nil {
				sm.fileLocks.ReleaseAll(sessionID)
			}
			return nil
		}
	}
	if cwd != "" {
		_ = approval.RemoveHooks(cwd)
	}
	// Scheme A/C: even on graceful kill, release the cwd slot and file locks.
	// (handlePTYExit may also run for daemon sessions; double release is safe.)
	sm.unregisterCwd(sessionID, cwd)
	if sm.fileLocks != nil {
		sm.fileLocks.ReleaseAll(sessionID)
	}
	return nil
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

// agentCLIName maps pocketctl agent types to the CLI binary name they install.
// Mirrors internal/discovery's knownAgents so there's a single source of truth
// per agent (discovery is the canonical registry; this is the session layer's
// lookup for spawning).
func agentCLIName(agentType string) string {
	switch agentType {
	case adapter.AgentClaude:
		return "claude"
	case adapter.AgentCodex:
		return "codex"
	default:
		// opencode / unknown → use the type as-is (its CLI usually matches).
		return agentType
	}
}

func findAgentCLI(agent string) (string, error) {
	name := agentCLIName(agent)
	path, _, found := discovery.ResolveAgent(name)
	if !found {
		return "", fmt.Errorf("agent CLI not found: %s (%s)", agent, name)
	}
	return path, nil
}
