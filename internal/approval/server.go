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

// Server listens on a Unix domain socket and brokers approval requests.
type Server struct {
	socketPath string
	logger     *slog.Logger

	ln net.Listener

	mu       sync.Mutex
	pending  map[string]*pendingEntry // keyed by requestID
	onReq    OnRequestFunc
	onCancel OnCancelFunc

	// fileLocks (Scheme C) enforces per-file mutual exclusion across sessions.
	// When non-nil, Edit/Write/MultiEdit/NotebookEdit on a file held by another
	// session is denied before the request ever reaches a client. May be nil in
	// tests that don't exercise file locking.
	fileLocks *filelock.LockManager

	closeMu sync.Mutex
	closed  bool

	wg sync.WaitGroup
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
		pending:    make(map[string]*pendingEntry),
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
	// Clean up a stale socket from a previous daemon run.
	if err := os.Remove(s.socketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale approval socket: %w", err)
	}
	ln, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return fmt.Errorf("listen approval socket: %w", err)
	}
	// Restrict to the owning user — approval requests carry no secret, but the
	// socket should not be world-writable.
	_ = os.Chmod(s.socketPath, 0600)

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
	s.wg.Wait()

	// Deny everything still pending so hooks exit promptly.
	s.mu.Lock()
	for id, e := range s.pending {
		select {
		case e.ch <- Response{Allow: false}:
		default:
		}
		delete(s.pending, id)
	}
	s.mu.Unlock()

	_ = os.Remove(s.socketPath)
	return err
}

// Resolve delivers a client's decision to the blocked hook for requestID.
// Returns an error if there is no pending request with that id (already
// resolved, drained, or unknown).
func (s *Server) Resolve(requestID string, allow bool) error {
	s.mu.Lock()
	e, ok := s.pending[requestID]
	if ok {
		delete(s.pending, requestID)
	}
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("no pending approval: %s", requestID)
	}
	e.ch <- Response{Allow: allow}
	return nil
}

// DrainSession denies and removes all pending requests for a session. Called
// when a session is killed or exits so its hook processes don't linger.
func (s *Server) DrainSession(sessionID string) {
	s.mu.Lock()
	for id, e := range s.pending {
		if e.sessionID == sessionID {
			select {
			case e.ch <- Response{Allow: false}:
			default:
			}
			delete(s.pending, id)
		}
	}
	s.mu.Unlock()
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
	timer := time.NewTimer(approvalTimeout)
	defer timer.Stop()
	var resp Response
	select {
	case resp = <-ch:
	case <-timer.C:
		s.mu.Lock()
		delete(s.pending, reqID)
		s.mu.Unlock()
		resp = Response{Allow: false}
		s.logger.Warn("approval timed out (auto-deny)", "request_id", reqID, "session", hr.SessionID, "tool", hr.Tool)
	case local := <-cancelCh:
		// Hook answered locally (or went away). Drop the pending entry; the hook
		// has already returned the decision to claude (or is gone), so there is
		// nothing to write back. A local allow on a file write still takes the
		// lock so concurrent sessions can't race the same file.
		s.mu.Lock()
		delete(s.pending, reqID)
		onCancel := s.onCancel
		s.mu.Unlock()
		if local != nil && *local && fl != nil {
			if path, ok := extractFilePath(hr.Tool, hr.Input); ok {
				fl.TryLock(hr.SessionID, normalizePath(hr.Cwd, path))
			}
		}
		if onCancel != nil {
			onCancel(reqID, hr.SessionID, local)
		}
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
