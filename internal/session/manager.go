package session

import (
	"context"
	"os/exec"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/approval"
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
