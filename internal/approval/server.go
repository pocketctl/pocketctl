// Package approval provides the in-process approval server that brokers
// tool-use approval requests between a Claude PTY session's PreToolUse hook
// and the web/iOS clients.
//
// Flow:
//  1. Claude runs the PreToolUse hook (a small script written by the daemon
//     into the session's cwd/.claude/settings.local.json).
//  2. The hook connects to this server's Unix domain socket and sends the
//     tool-use details as a single JSON line.
//  3. The server registers a pending request, invokes the OnRequest callback
//     (which the SessionManager uses to emit an approval_request event to
//     clients), and BLOCKS on a per-request channel.
//  4. When a client sends approval_response, the SessionManager calls
//     Resolve(requestID, approved), which unblocks the hook by sending the
//     decision down the channel. The hook then returns Claude's
//     hookSpecificOutput (permissionDecision allow/deny) on stdout.
//
// Only sessions with a non-bypass permission mode register a hook (see
// SessionManager.CreateSession), so bypassPermissions sessions are unaffected.
package approval

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/filelock"
	"github.com/pocketctl/pocketctl/internal/platform"
)

// Request is the tool-use approval request delivered to the SessionManager
// (and onward to clients) when a PreToolUse hook fires.
type Request struct {
	RequestID string          `json:"request_id"`
	SessionID string          `json:"session_id"`
	Tool      string          `json:"tool"`
	Input     json.RawMessage `json:"input,omitempty"`
	Cwd       string          `json:"cwd,omitempty"`
}

// Response is the decision written back to the hook. Allow=true means the
// tool may proceed; Allow=false denies it.
type Response struct {
	Allow bool
}

// hookRequest is the wire format the hook script sends over the socket.
type hookRequest struct {
	SessionID string          `json:"session_id"`
	Tool      string          `json:"tool"`
	Input     json.RawMessage `json:"input,omitempty"`
	Cwd       string          `json:"cwd,omitempty"`
	PermMode  string          `json:"perm_mode,omitempty"` // bypassPermissions | default | acceptEdits | plan
}

// hookResponse is the wire format written back to the hook. The hook maps
// Allow → Claude's permissionDecision ("allow"/"deny"). LockConflict is set
// when the deny is due to a file-lock conflict (so bypass mode still reports
// the conflict rather than continue).
type hookResponse struct {
	Allow        bool   `json:"allow"`
	Reason       string `json:"reason,omitempty"`
	LockConflict bool   `json:"lock_conflict,omitempty"`
}

// OnRequestFunc is invoked once per incoming hook connection, after the request
// is registered as pending. It must return quickly (it only fans the request
// out to clients); the blocking wait happens inside the server.
type OnRequestFunc func(req Request)

// OnCancelFunc is invoked when a pending request is resolved OUT-OF-BAND by the
// hook itself — i.e. a user-launched terminal session answered the prompt with
// a local [y/n] keypress (allow non-nil) or the hook process simply went away
// (allow nil). The server has already dropped the pending entry; the callback
// only tells clients to dismiss the now-stale approval card. Must not block.
type OnCancelFunc func(requestID, sessionID string, allow *bool)

// FinishReason describes why a pending Claude hook approval stopped being
// answerable. It is intentionally Claude-specific; Codex and OpenCode keep
// their own interaction authorities and never use this server.
type FinishReason string

const (
	FinishApproved         FinishReason = "approved"
	FinishDenied           FinishReason = "denied"
	FinishTimedOut         FinishReason = "timed_out"
	FinishHookDisconnected FinishReason = "hook_disconnected"
	FinishSessionDrained   FinishReason = "session_drained"
	FinishServerShutdown   FinishReason = "server_shutdown"
)

// Finished is emitted exactly once for every request that was registered as
// pending. Approved is nil when no user decision exists (disconnect, drain, or
// shutdown).
type Finished struct {
	RequestID string
	SessionID string
	Approved  *bool
	Reason    FinishReason
}

// OnFinishedFunc is the authoritative lifecycle callback for pending Claude
// hook approvals. It must return quickly and must not call back into Server
// while holding external locks.
type OnFinishedFunc func(Finished)

// defaultIPCListener is the platform IPC listener (unix domain socket on Unix,
// named pipe on Windows). PR2: replaces approval's direct net.Listen("unix").
var defaultIPCListener = platform.NewIPCListener()

// Server listens on a Unix domain socket and brokers approval requests.
type Server struct {
	socketPath string
	logger     *slog.Logger
	ipc        platform.IPCListener // PR2: 本地 IPC 监听 (unix socket/named pipe)，替代 net.Listen("unix")

	ln net.Listener

	mu       sync.Mutex
	pending  map[string]*pendingEntry // keyed by requestID
	onReq    OnRequestFunc
	onCancel OnCancelFunc
	onFinish OnFinishedFunc

	// fileLocks (Scheme C) enforces per-file mutual exclusion across sessions.
	// When non-nil, Edit/Write/MultiEdit/NotebookEdit on a file held by another
	// session is denied before the request ever reaches a client. May be nil in
	// tests that don't exercise file locking.
	fileLocks *filelock.LockManager

	closeMu sync.Mutex
	closed  bool

	wg      sync.WaitGroup
	timeout time.Duration
}

type pendingEntry struct {
	ch        chan Response
	sessionID string
}

// NewServer creates (but does not start) an approval server. Call Start to
// begin accepting hook connections.
func NewServer(socketPath string, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		socketPath: socketPath,
		logger:     logger,
		ipc:        defaultIPCListener,
		pending:    make(map[string]*pendingEntry),
		timeout:    approvalTimeout,
	}
}

// SocketPath returns the Unix socket path the server listens on (or will listen
// on once Start is called).
func (s *Server) SocketPath() string {
	return s.socketPath
}

// SetOnRequest registers the callback fired on each new approval request. Must
// be called before Start. The callback is invoked from the accept goroutine,
// so it must not block.
func (s *Server) SetOnRequest(fn OnRequestFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onReq = fn
}

// SetOnCancel registers the callback fired when a pending request is resolved
// by the hook out-of-band (local terminal keypress) or the hook disconnects.
// Must be called before Start.
func (s *Server) SetOnCancel(fn OnCancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onCancel = fn
}

// SetOnFinished registers the single authoritative lifecycle callback for
// every pending request. SetOnCancel remains for compatibility with callers
// interested only in the legacy hook-side resolution path.
func (s *Server) SetOnFinished(fn OnFinishedFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onFinish = fn
}

// SetFileLockManager wires the shared file-lock manager (Scheme C). When set,
// the server denies file-writing tools on files held by other sessions. Must
// be called before Start.
func (s *Server) SetFileLockManager(fl *filelock.LockManager) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fileLocks = fl
}

// Start binds the Unix socket and begins accepting hook connections. Removing
// any stale socket file at the path first. Returns an error if the socket
// cannot be created; safe to call once.
func (s *Server) Start() error {
	// PR2: IPC listen via platform.IPCListener (unix socket on Unix, named pipe
	// on Windows). platform.Listen handles stale-socket removal + 0600 chmod
	// internally — replaces the old direct net.Listen("unix", ...) + os.Remove
	// + os.Chmod trio.
	ln, err := s.ipc.Listen(s.socketPath)
	if err != nil {
		return err
	}

	s.ln = ln
	s.wg.Add(1)
	go s.acceptLoop()
	s.logger.Info("approval server listening", "socket", s.socketPath)
	return nil
}

// Close stops accepting connections and denies all pending requests so that
// no hook process is left blocked. The socket file is removed.
func (s *Server) Close() error {
	s.closeMu.Lock()
	s.closed = true
	s.closeMu.Unlock()

	var err error
	if s.ln != nil {
		err = s.ln.Close()
	}

	// Deny everything still pending so hooks exit promptly.
	for _, item := range s.takePendingForSession("") {
		item.entry.ch <- Response{Allow: false}
		s.notifyFinished(item.id, item.entry.sessionID, nil, FinishServerShutdown)
	}
	s.wg.Wait()

	_ = os.Remove(s.socketPath)
	return err
}

// Resolve delivers a client's decision to the blocked hook for requestID.
// Returns an error if there is no pending request with that id (already
// resolved, drained, or unknown).
func (s *Server) Resolve(requestID string, allow bool) error {
	e, ok := s.takePending(requestID)
	if !ok {
		return fmt.Errorf("no pending approval: %s", requestID)
	}
	e.ch <- Response{Allow: allow}
	approved := allow
	reason := FinishDenied
	if allow {
		reason = FinishApproved
	}
	s.notifyFinished(requestID, e.sessionID, &approved, reason)
	return nil
}

// DrainSession denies and removes all pending requests for a session. Called
// when a session is killed or exits so its hook processes don't linger.
func (s *Server) DrainSession(sessionID string) {
	for _, item := range s.takePendingForSession(sessionID) {
		item.entry.ch <- Response{Allow: false}
		s.notifyFinished(item.id, item.entry.sessionID, nil, FinishSessionDrained)
	}
}

type takenPending struct {
	id    string
	entry *pendingEntry
}

func (s *Server) takePending(requestID string) (*pendingEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.pending[requestID]
	if ok {
		delete(s.pending, requestID)
	}
	return entry, ok
}

// takePendingForSession atomically removes a session's requests. An empty
// sessionID means all requests. Callbacks and channel writes happen after the
// server lock is released.
func (s *Server) takePendingForSession(sessionID string) []takenPending {
	s.mu.Lock()
	defer s.mu.Unlock()
	var taken []takenPending
	for id, entry := range s.pending {
		if sessionID == "" || entry.sessionID == sessionID {
			taken = append(taken, takenPending{id: id, entry: entry})
			delete(s.pending, id)
		}
	}
	return taken
}

func (s *Server) notifyFinished(requestID, sessionID string, approved *bool, reason FinishReason) {
	s.mu.Lock()
	onFinish := s.onFinish
	s.mu.Unlock()
	if onFinish != nil {
		onFinish(Finished{RequestID: requestID, SessionID: sessionID, Approved: approved, Reason: reason})
	}
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			s.closeMu.Lock()
			closed := s.closed
			s.closeMu.Unlock()
			if !closed {
				s.logger.Error("approval accept", "error", err)
			}
			return // listener closed
		}
		s.wg.Add(1)
		go s.handleConn(conn)
	}
}

// handleConn services a single hook connection. It reads one JSON request,
// registers it, fires OnRequest, blocks for the decision, and writes back the
// response. A per-request timeout auto-denies if the client never answers —
// preventing Claude from blocking forever on an orphaned prompt.
func (s *Server) handleConn(conn net.Conn) {
	defer s.wg.Done()
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		s.logger.Debug("approval hook read", "error", err)
		return
	}
	var hr hookRequest
	if err := json.Unmarshal(line, &hr); err != nil {
		s.logger.Error("approval hook parse", "error", err, "line", string(line))
		return
	}

	if hr.SessionID == "" {
		s.logger.Error("approval hook missing session_id")
		return
	}

	// --- Scheme C: file-lock pre-check -------------------------------------
	// For file-writing tools, deny immediately if another session holds the
	// file. This runs for ALL permission modes (including bypass) and never
	// reaches the client — the deny reason is surfaced to the agent so it can
	// back off or retry. On success the lock is acquired/renewed here for
	// bypass mode (the tool is about to run); for non-bypass modes the lock is
	// taken only after the client approves (see the post-approval section
	// below).
	s.mu.Lock()
	fl := s.fileLocks
	s.mu.Unlock()
	if fl != nil {
		if path, ok := extractFilePath(hr.Tool, hr.Input); ok {
			absPath := normalizePath(hr.Cwd, path)
			if held, holder := fl.IsLockedByOther(hr.SessionID, absPath); held {
				reason := fmt.Sprintf("文件 %s 正被会话 %s 编辑，请等待其完成或切换会话后再试", path, holder)
				out, _ := json.Marshal(hookResponse{Allow: false, Reason: reason, LockConflict: true})
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				_, _ = conn.Write(append(out, '\n'))
				return
			}
			// Bypass mode: no client approval will follow, so take/refresh the
			// lock now and let the hook continue.
			if hr.PermMode == "bypassPermissions" {
				fl.TryLock(hr.SessionID, absPath)
			}
			// Non-bypass: defer lock acquisition to post-approval (below).
		}
	}

	// --- Scheme C bypass fast-path -----------------------------------------
	// In bypass mode with no lock conflict, tell the hook "no opinion" so it
	// writeContinue()s and Claude runs the tool under its own permission logic.
	if hr.PermMode == "bypassPermissions" {
		out, _ := json.Marshal(hookResponse{Allow: true, Reason: "no lock conflict"})
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_, _ = conn.Write(append(out, '\n'))
		return
	}

	reqID := uuid.New().String()
	req := Request{
		RequestID: reqID,
		SessionID: hr.SessionID,
		Tool:      hr.Tool,
		Input:     hr.Input,
		Cwd:       hr.Cwd,
	}

	ch := make(chan Response, 1)
	s.mu.Lock()
	s.pending[reqID] = &pendingEntry{ch: ch, sessionID: hr.SessionID}
	onReq := s.onReq
	s.mu.Unlock()

	if onReq != nil {
		onReq(req)
	}

	// Watch for the hook resolving this request out-of-band. A user-launched
	// terminal session races a local [y/n] keypress against the App; on a local
	// answer the hook sends a {"resolved":true,"allow":bool} line and closes (a
	// bare close — e.g. the hook/claude died — arrives as EOF). Either way we
	// stop waiting on the App. The initial read above set a 10s deadline on the
	// conn; clear it so this long-lived read isn't cut off after 10s.
	cancelCh := make(chan *bool, 1) // &allow on a local answer; nil on bare disconnect
	go func() {
		_ = conn.SetReadDeadline(time.Time{})
		line, err := reader.ReadBytes('\n')
		if err != nil {
			cancelCh <- nil
			return
		}
		var m struct {
			Resolved bool `json:"resolved"`
			Allow    bool `json:"allow"`
		}
		if json.Unmarshal(line, &m) == nil && m.Resolved {
			a := m.Allow
			cancelCh <- &a
		} else {
			cancelCh <- nil
		}
	}()

	// Block until the client answers, the session is drained, the server is
	// closed, the hook resolves locally, or the auto-deny deadline fires.
	timer := time.NewTimer(s.timeout)
	defer timer.Stop()
	var resp Response
	select {
	case resp = <-ch:
	case <-timer.C:
		if _, won := s.takePending(reqID); won {
			resp = Response{Allow: false}
			s.notifyFinished(reqID, hr.SessionID, nil, FinishTimedOut)
			s.logger.Warn("approval timed out (auto-deny)", "request_id", reqID, "session", hr.SessionID, "tool", hr.Tool)
		} else {
			// A concurrent Resolve/Drain/Close removed the request and is about
			// to deliver the response. Preserve that winner's decision.
			resp = <-ch
		}
	case local := <-cancelCh:
		// Hook answered locally (or went away). Drop the pending entry; the hook
		// has already returned the decision to claude (or is gone), so there is
		// nothing to write back. A local allow on a file write still takes the
		// lock so concurrent sessions can't race the same file.
		_, won := s.takePending(reqID)
		s.mu.Lock()
		onCancel := s.onCancel
		s.mu.Unlock()
		if !won {
			// A remote response, drain, or shutdown already won.
			return
		}
		if local != nil && *local && fl != nil {
			if path, ok := extractFilePath(hr.Tool, hr.Input); ok {
				fl.TryLock(hr.SessionID, normalizePath(hr.Cwd, path))
			}
		}
		if onCancel != nil {
			onCancel(reqID, hr.SessionID, local)
		}
		reason := FinishHookDisconnected
		if local != nil {
			reason = FinishDenied
			if *local {
				reason = FinishApproved
			}
		}
		s.notifyFinished(reqID, hr.SessionID, local, reason)
		return
	}

	// Scheme C: now that the client approved a file write, acquire the lock so
	// other sessions are blocked from racing the same file.
	if resp.Allow && fl != nil {
		if path, ok := extractFilePath(hr.Tool, hr.Input); ok {
			fl.TryLock(hr.SessionID, normalizePath(hr.Cwd, path))
		}
	}

	reason := "approved by user"
	if !resp.Allow {
		reason = "denied by user"
	}
	out, _ := json.Marshal(hookResponse{Allow: resp.Allow, Reason: reason})
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write(append(out, '\n')); err != nil {
		s.logger.Debug("approval hook write", "error", err)
	}
}

// approvalTimeout is how long the server will block a hook waiting for a
// client decision before auto-denying. Long enough for a human to read the
// prompt; short enough that an orphaned request (client closed the app,
// network dropped) doesn't wedge Claude forever.
const approvalTimeout = 10 * time.Minute
