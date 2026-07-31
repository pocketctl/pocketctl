package session

import (
	"context"
	"os/exec"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
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
	TurnStartedAt    time.Time // start of the current turn; zero while idle
	Cwd              string
	Agent            string
	Source           string               // "daemon" or "terminal"
	SlashCommands    []string             // slash commands the agent reported as available (init event)
	Pid              int                  // terminal session's original PID
	TTY              string               // terminal session's TTY device (e.g. /dev/ttys002)
	ExitReason       string               // reason for process exit (terminal sessions only)
	TitleAttempts    int                  // 已触发 generate_title_request 次数（上限 MaxTitleAttempts）
	Tailer           *watcher.JSONLTailer // terminal session 的 JSONL tailer（D2: sendToIdleTerminal 期间 pause）
	PTY              platform.PTY         // interactive-web-session D1: daemon session 的 PTY master（写 stdin 驱动 interactive claude）。PR2: platform.PTY interface (was *os.File)
	PTYScanner       *ptyscan.Scanner     // daemon session 的 PTY 菜单扫描器（捕获 TUI 选择提示，转成 interactive_prompt 事件）
	Permission       *protocol.PermissionConfig
	Model            string // resolved model name (for session_created, surfaced to web /model)
	CurrentAgent     string // selected OpenCode Agent profile; Agent remains the CLI type
	Effort           string // last-set thinking-effort level (low/medium/high/xhigh/max/ultracode)
	PendingRequestID string // non-empty while a tool-use approval request awaits a client decision
	// OpenCode interactions are independent, request-ID-keyed collections. The
	// legacy PendingRequestID above remains exclusively for Claude hook approval.
	PendingPermissions map[string]PendingOpenCodePermission
	PendingQuestions   map[string]PendingOpenCodeQuestion
	InitialPrompt      string              // prompt submitted when a daemon PTY session starts
	JSONLExcludeIDs    map[string]struct{} // rollout/session ids that existed before this PTY launch
	PTYOutputTail      []byte              // recent raw PTY output for startup diagnostics
	WorktreePath       string              // Scheme D: non-empty when the session runs inside a git worktree
	WorktreeBranch     string              // Scheme D: the git branch backing the worktree
	Backend            SessionBackend      // non-nil only for server-kind agents (opencode); subprocess agents drive via the fields above
	ControlMode        string              // managed | unmanaged_active | legacy_read_only
}

type PendingOpenCodePermission struct {
	RequestID       string
	Permission      string
	Patterns        []string
	Always          []string
	Metadata        []byte
	ToolMessageID   string
	ToolCallID      string
	ProtocolVersion string
}

type PendingOpenCodeQuestion struct {
	RequestID       string
	Questions       []protocol.QuestionInfo
	ToolMessageID   string
	ToolCallID      string
	ProtocolVersion string
}

func clonePermission(p *protocol.PermissionConfig) *protocol.PermissionConfig {
	if p == nil {
		return nil
	}
	c := *p
	return &c
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
	childPids           map[int]bool                           // PIDs of daemon-spawned processes
	OnNotifyTerminal    NotifyFunc                             // callback after --resume on terminal session
	OnSessionIDResolved func(realSessionID, cwd, agent string) // callback when daemon session gets real ID
	OnStateChanged      func()                                 // callback when in-memory session state should be persisted
	ptyProvider         platform.PTYProvider                   // PR2: daemon-session PTY backend (was direct creack/pty)
	proc                platform.ProcessController             // PR2: process alive/kill (was syscall; used by Task 3)
	createDeps          createSessionDependencies

	// approvals brokers PreToolUse hook approvals for non-bypass daemon sessions.
	// nil on daemons that don't surface approvals (or before wiring).
	approvals       *approval.Server
	pocketctlPath   string // path to this binary, for the hook command
	approvalEnabled bool   // set once an approval server is attached
	// Claude V2 approvals are isolated from Codex/OpenCode interaction state.
	// They are enabled only by the Claude-specific rollout flag.
	claudeApprovalV2        bool
	claudeApprovals         map[string]*claudeApprovalSession
	claudeApprovalResolved  map[claudeApprovalKey]time.Time
	claudeApprovalRecorder  func([]ClaudeApprovalReference) error
	claudeTelemetryRecorder func(metric, reason string)

	// Scheme A: cwd → active session ID set, for "directory already in use"
	// awareness. Keyed by normalized absolute path (normalizeCwd).
	cwdSessions map[string]map[string]struct{}

	// Scheme C: file-level lock manager coordinating concurrent edits across
	// sessions that share a working directory. Shared with the approval server.
	fileLocks *filelock.LockManager

	// opencode coordinates the shared `opencode serve` process and its SSE demux
	// for server-kind (opencode) sessions. Lazily created on first use.
	opencode                    *opencodeCoordinator
	codexProvider               *CodexRuntimeProvider
	leases                      *agentcontrol.LeaseRegistry
	recordOpenCodeRuntimeHealth func(bool)
}

type createSessionDependencies struct {
	resolveAgentCLI   func(protocol.SessionConfig) (string, error)
	startOpencode     func(*SessionManager, context.Context, protocol.SessionConfig) (string, error)
	startCodexManaged func(*SessionManager, context.Context, protocol.SessionConfig, string, string, string, string, string) (string, bool, error)
}

func NewSessionManager(outputCh chan protocol.DaemonEvent) *SessionManager {
	return &SessionManager{
		sessions:               make(map[string]*ProcessState),
		outputCh:               outputCh,
		childPids:              make(map[int]bool),
		cwdSessions:            make(map[string]map[string]struct{}),
		fileLocks:              filelock.New(),
		leases:                 agentcontrol.NewLeaseRegistry(),
		ptyProvider:            defaultPTYProvider,
		proc:                   defaultProc,
		claudeApprovalV2:       claudeApprovalV2Enabled(),
		claudeApprovals:        make(map[string]*claudeApprovalSession),
		claudeApprovalResolved: make(map[claudeApprovalKey]time.Time),
		createDeps: createSessionDependencies{
			resolveAgentCLI: func(config protocol.SessionConfig) (string, error) {
				return findAgentCLI(config.Agent)
			},
			startOpencode: func(sm *SessionManager, ctx context.Context, config protocol.SessionConfig) (string, error) {
				return sm.createOpencodeSession(ctx, config)
			},
			startCodexManaged: func(sm *SessionManager, ctx context.Context, config protocol.SessionConfig, cliPath, cwd, model, worktreePath, worktreeBranch string) (string, bool, error) {
				return sm.tryCreateManagedCodexSession(ctx, config, cliPath, cwd, model, worktreePath, worktreeBranch)
			},
		},
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

// SetOpenCodeRuntimeHealthRecorder installs the content-free rollout counter
// sink used by the daemon. Tests and embedded callers can leave it unset.
func (sm *SessionManager) SetOpenCodeRuntimeHealthRecorder(record func(bool)) {
	sm.mu.Lock()
	sm.recordOpenCodeRuntimeHealth = record
	sm.mu.Unlock()
}

func (sm *SessionManager) observeOpenCodeRuntimeHealth(healthy bool) {
	sm.mu.RLock()
	record := sm.recordOpenCodeRuntimeHealth
	sm.mu.RUnlock()
	if record != nil {
		record(healthy)
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
	if sm.claudeApprovalV2 {
		srv.SetOnFinished(sm.handleClaudeApprovalFinished)
	} else {
		srv.SetOnCancel(sm.handleApprovalCancel)
	}
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
			Type:         "session_discovered",
			SessionID:    sessionID,
			Cwd:          ps.Cwd,
			Status:       ps.Status,
			Source:       ps.Source,
			Agent:        ps.Agent,
			Model:        ps.Model,
			ControlMode:  ps.ControlMode,
			Capabilities: sm.sessionCapabilitiesLocked(ps),
			Resync:       true,
		}
	}
}
