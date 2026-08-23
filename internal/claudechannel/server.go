package claudechannel

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"
)

// Server is the daemon-side Claude Channel IPC broker. It accepts shim
// bootstrap connections, issues per-launch instance ids + capability tokens,
// and bridges permission request/verdict traffic between Channel processes
// and the approval registry. The Server is the ONLY writer of verdicts to a
// Channel connection (at-most-once contract, design §1.2).
//
// The Server does NOT touch the legacy approval.Server pending set, the
// OpenCode pending maps, or the Codex broker. Those routes stay isolated.
type Server struct {
	socketPath string
	mcpConfig  string
	logger     *slog.Logger
	now        func() time.Time

	mu        sync.Mutex
	instances map[string]*instanceState // instance id -> state
	reserved  map[string]reservationState
	closed    bool
	closedCh  chan struct{}
	ln        net.Listener

	// onRegister is invoked after a Channel successfully registers. The
	// callback receives the registration record; nil callback is allowed.
	onRegister func(reg RegisterEvent)
	// onRequest is invoked when a Channel sends a permission request. The
	// callback receives the public request id assigned by the Server (NOT
	// Claude's short id), the request payload, and a Responder the registry
	// uses to deliver the verdict (or fail-closed) back through the Channel.
	onRequest    func(req RequestEvent)
	onDisconnect func(instanceID, reason string)
}

type reservationState struct {
	token           string
	claudePID       int
	processIdentity string
	protocolVersion string
	expiresAt       time.Time
}

// instanceState tracks a single Channel registration and its live
// connection (so the server can deliver verdicts and fail-closed).
type instanceState struct {
	token       string
	publicID    string // not used here, but reserved for binding lookup
	registered  bool
	channelPID  int
	claudePID   int
	conn        net.Conn
	connMu      sync.Mutex
	requestMu   sync.Mutex
	requests    map[string]*Responder
	writeBudget time.Duration
	closeOnce   sync.Once
	closed      chan struct{}
}

// RegisterEvent is the post-registration snapshot handed to onRegister.
type RegisterEvent struct {
	InstanceID           string
	ChannelPID           int
	ClaudeParentPID      int
	ProtocolVersion      string
	ProcessStartIdentity string
}

// RequestEvent is the pre-binding request snapshot handed to onRequest.
type RequestEvent struct {
	PublicRequestID string
	InstanceID      string
	ShortRequestID  string
	ToolName        string
	Description     string
	InputPreview    string
	// Responder delivers a verdict to the originating Channel. At-most-once
	// is enforced: a second call is a no-op. Calling with empty behavior
	// fails the request closed without sending a verdict to Claude.
	Responder VerdictResponder
}

type VerdictResponder interface {
	Send(behavior string) error
	FailClosed()
}

// Responder delivers a verdict (or fail-closed) to the Channel that issued
// the request. At-most-once is enforced via sync.Once.
type Responder struct {
	server     *Server
	instanceID string
	shortID    string
	publicID   string
	done       sync.Once
}

// Send writes a verdict notification to the originating Channel. Returns
// nil on success, an error if the Channel is gone or the write fails. A
// second call is a no-op and returns nil (at-most-once).
func (r *Responder) Send(behavior string) error {
	if !ValidBehavior(behavior) {
		return fmt.Errorf("claudechannel: invalid behavior %q", behavior)
	}
	var writeErr error
	r.done.Do(func() {
		writeErr = r.server.writeVerdict(r.instanceID, r.publicID, r.shortID, behavior)
	})
	return writeErr
}

// FailClosed closes the originating Channel's pending request WITHOUT
// sending a verdict. Used when the daemon restarts, the Channel
// disconnects, or the request expires. At-most-once via sync.Once.
func (r *Responder) FailClosed() {
	r.done.Do(func() {
		// No-op: the Channel connection close path clears pending state on
		// the registry side via onRequest's callback bookkeeping.
	})
}

// NewServer constructs a Server. socketPath is the IPC endpoint;
// mcpConfigPath is the Pocketctl-owned MCP config returned to the shim.
// logger may be nil (a discard logger is installed).
func NewServer(socketPath, mcpConfigPath string, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Server{
		socketPath: socketPath,
		mcpConfig:  mcpConfigPath,
		logger:     logger,
		now:        time.Now,
		instances:  make(map[string]*instanceState),
		reserved:   make(map[string]reservationState),
		closedCh:   make(chan struct{}),
	}
}

// SetOnRegister installs the post-registration callback.
func (s *Server) SetOnRegister(fn func(reg RegisterEvent)) {
	s.mu.Lock()
	s.onRegister = fn
	s.mu.Unlock()
}

// SetOnRequest installs the per-request callback.
func (s *Server) SetOnRequest(fn func(req RequestEvent)) {
	s.mu.Lock()
	s.onRequest = fn
	s.mu.Unlock()
}

func (s *Server) SetOnDisconnect(fn func(instanceID, reason string)) {
	s.mu.Lock()
	s.onDisconnect = fn
	s.mu.Unlock()
}

// Start binds the listener and spawns the accept loop. It returns on bind
// failure; otherwise the accept loop runs until Close.
func (s *Server) Start() error {
	ln, err := Listen(s.socketPath)
	if err != nil {
		return fmt.Errorf("claudechannel: listen: %w", err)
	}
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()
	go s.acceptLoop(ln)
	return nil
}

// Close stops accepting and tears down all Channel connections. Pending
// requests on those connections are left to the registry to fail-closed;
// the Server does NOT emit verdicts on shutdown (design §1.2 / §2.1).
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	close(s.closedCh)
	ln := s.ln
	instances := s.instances
	s.instances = make(map[string]*instanceState)
	s.reserved = make(map[string]reservationState)
	s.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
	for _, st := range instances {
		st.closeOnce.Do(func() {
			_ = st.conn.Close()
		})
	}
	return nil
}

func (s *Server) acceptLoop(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go s.handleConn(conn)
	}
}

// handleConn accepts either a short-lived shim reservation or a Channel
// claim. They intentionally use different connections because the shim execs
// Claude before Claude can spawn the Channel child.
func (s *Server) handleConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	reader := bufio.NewReader(conn)
	if err := conn.SetReadDeadline(s.now().Add(DefaultBootstrapTTL)); err != nil {
		s.logger.Debug("claudechannel: set bootstrap deadline failed", "error", err)
		return
	}
	env, err := readEnvelope(reader)
	if err != nil {
		s.logger.Debug("claudechannel: first frame read failed", "error", err)
		return
	}
	switch env.Kind {
	case KindBootstrapAcquire:
		s.handleAcquire(conn, env)
	case KindBootstrapBind:
		s.handleBind(conn, env)
	case KindChannelRegister:
		s.handleClaim(conn, reader, env)
	default:
		s.logger.Debug("claudechannel: unexpected first frame", "kind", env.Kind)
	}
}

func (s *Server) handleAcquire(conn net.Conn, env Envelope) {
	var acquire BootstrapAcquire
	if err := DecodePayload(env, &acquire); err != nil || acquire.ClaudeParentPID <= 0 ||
		acquire.ProtocolVersion != MCPProtocolVersion {
		s.logger.Debug("claudechannel: invalid bootstrap acquire")
		return
	}
	instanceID := NewInstanceID()
	token := NewCapabilityToken()
	expiresAt := s.now().Add(DefaultBootstrapTTL)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.reserved[instanceID] = reservationState{
		token: token, claudePID: acquire.ClaudeParentPID,
		processIdentity: acquire.ProcessStartIdentity,
		protocolVersion: acquire.ProtocolVersion, expiresAt: expiresAt,
	}
	s.mu.Unlock()
	result := BootstrapAcquireResult{
		InstanceID:      instanceID,
		CapabilityToken: token,
		MCPConfigPath:   s.mcpConfig,
		ExpiresAt:       expiresAt,
	}
	if err := s.writeFrame(conn, KindBootstrapAcquire, result); err != nil {
		s.mu.Lock()
		delete(s.reserved, instanceID)
		s.mu.Unlock()
		s.logger.Debug("claudechannel: bootstrap write failed", "error", err)
	}
}

func (s *Server) handleBind(conn net.Conn, env Envelope) {
	var bind BootstrapBind
	if err := DecodePayload(env, &bind); err != nil || bind.InstanceID == "" ||
		bind.ClaudeParentPID <= 0 || bind.ProcessStartIdentity == "" {
		return
	}
	s.mu.Lock()
	reservation, ok := s.reserved[bind.InstanceID]
	valid := ok && s.now().Before(reservation.expiresAt) &&
		ConstantTimeTokenEqual(bind.CapabilityToken, reservation.token)
	if valid {
		reservation.claudePID = bind.ClaudeParentPID
		reservation.processIdentity = bind.ProcessStartIdentity
		s.reserved[bind.InstanceID] = reservation
	}
	s.mu.Unlock()
	if !valid {
		_ = s.writeFrame(conn, KindChannelClose, ChannelClose{Reason: CloseReasonTokenMismatch})
		return
	}
	_ = s.writeFrame(conn, KindBootstrapBind, struct{}{})
}

func (s *Server) handleClaim(conn net.Conn, reader *bufio.Reader, env Envelope) {
	var reg ChannelRegister
	if err := DecodePayload(env, &reg); err != nil {
		s.logger.Debug("claudechannel: register decode failed", "error", err)
		return
	}
	s.mu.Lock()
	reservation, exists := s.reserved[reg.InstanceID]
	compareToken := reservation.token
	if !exists {
		compareToken = strings.Repeat("0", BootstrapTokenBytes*2)
	}
	tokenOK := ConstantTimeTokenEqual(reg.CapabilityToken, compareToken)
	valid := exists && s.now().Before(reservation.expiresAt) && tokenOK &&
		reg.ClaudeParentPID == reservation.claudePID &&
		(reservation.processIdentity == "" || reg.ProcessStartIdentity == reservation.processIdentity) &&
		reg.ProtocolVersion == reservation.protocolVersion && reg.ChannelPID > 0
	if valid {
		delete(s.reserved, reg.InstanceID)
	}
	s.mu.Unlock()
	if !valid {
		_ = s.writeFrame(conn, KindChannelClose, ChannelClose{Reason: CloseReasonTokenMismatch})
		return
	}
	instanceID := reg.InstanceID
	st := &instanceState{
		token:      reservation.token,
		registered: true,
		channelPID: reg.ChannelPID,
		claudePID:  reg.ClaudeParentPID,
		conn:       conn,
		requests:   make(map[string]*Responder),
		closed:     make(chan struct{}),
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if _, exists := s.instances[instanceID]; exists {
		s.mu.Unlock()
		_ = s.writeFrame(conn, KindChannelClose, ChannelClose{Reason: CloseReasonDuplicateRegister})
		return
	}
	s.instances[instanceID] = st
	onRegister := s.onRegister
	onRequest := s.onRequest
	s.mu.Unlock()
	// Cleanup ALWAYS runs when this goroutine exits: EOF, explicit close,
	// or server shutdown. We NEVER replay a verdict here.
	defer func() {
		s.mu.Lock()
		// Only delete if it's still us; a concurrent CloseInstance may have
		// already removed us.
		if cur, ok := s.instances[instanceID]; ok && cur == st {
			delete(s.instances, instanceID)
		}
		onDisconnect := s.onDisconnect
		reason := "channel_disconnected"
		if s.closed {
			reason = CloseReasonDaemonShutdown
		}
		s.mu.Unlock()
		st.closeOnce.Do(func() { close(st.closed) })
		if onDisconnect != nil {
			onDisconnect(instanceID, reason)
		}
	}()
	if onRegister != nil {
		onRegister(RegisterEvent{
			InstanceID:           instanceID,
			ChannelPID:           reg.ChannelPID,
			ClaudeParentPID:      reg.ClaudeParentPID,
			ProtocolVersion:      reg.ProtocolVersion,
			ProcessStartIdentity: reg.ProcessStartIdentity,
		})
	}

	// Clear the claim deadline after registration.
	_ = conn.SetReadDeadline(time.Time{})
	go s.heartbeatLoop(st)

	for {
		env, err := readEnvelope(reader)
		if err != nil {
			s.logger.Debug("claudechannel: request loop ended", "instance", instanceID, "error", err)
			return
		}
		switch env.Kind {
		case KindChannelRequest:
			var req ChannelRequest
			if err := DecodePayload(env, &req); err != nil {
				s.logger.Debug("claudechannel: request decode failed", "error", err)
				continue
			}
			if req.InstanceID != instanceID {
				s.logger.Debug("claudechannel: request instance mismatch")
				continue
			}
			if !validClaudeRequestID(req.ShortRequestID) || req.ToolName == "" ||
				req.Description == "" || req.InputPreview == "" {
				s.logger.Debug("claudechannel: invalid request fields")
				continue
			}
			st.requestMu.Lock()
			if _, exists := st.requests[req.ShortRequestID]; exists {
				st.requestMu.Unlock()
				continue
			}
			publicID := NewPublicRequestID()
			responder := &Responder{
				server: s, instanceID: instanceID, shortID: req.ShortRequestID, publicID: publicID,
			}
			st.requests[req.ShortRequestID] = responder
			st.requestMu.Unlock()
			if onRequest != nil {
				onRequest(RequestEvent{
					PublicRequestID: publicID,
					InstanceID:      instanceID,
					ShortRequestID:  req.ShortRequestID,
					ToolName:        req.ToolName,
					Description:     SanitizePreview(req.Description),
					InputPreview:    SanitizePreview(req.InputPreview),
					Responder:       responder,
				})
			}
		case KindPing:
			_ = s.writeFrameConn(st, KindPong, PongPayload{At: s.now()})
		case KindPong:
			// Heartbeat acknowledgement; the live read proves the peer is healthy.
		case KindChannelClose:
			s.logger.Debug("claudechannel: channel closed", "instance", instanceID, "reason", "peer_close")
			return
		default:
			s.logger.Debug("claudechannel: unknown kind ignored", "kind", env.Kind)
		}
	}
}

// heartbeatLoop sends periodic pings to keep the connection alive. The
// Channel responds with pong (handled in the request loop). On write
// failure the connection is torn down; pending requests fail closed.
func (s *Server) heartbeatLoop(st *instanceState) {
	ticker := time.NewTicker(HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-st.closed:
			return
		case <-s.closedCh:
			return
		case <-ticker.C:
			if err := s.writeFrameConn(st, KindPing, PingPayload{At: s.now()}); err != nil {
				_ = st.conn.Close()
				return
			}
		}
	}
}

// writeVerdict is the SINGLE verdict writer for a Channel connection. It is
// called by Responder.Send. At-most-once is enforced by the Responder's
// sync.Once; this function only guarantees one frame per call.
func (s *Server) writeVerdict(instanceID, publicID, shortID, behavior string) error {
	s.mu.Lock()
	st, ok := s.instances[instanceID]
	s.mu.Unlock()
	if !ok {
		return errors.New("claudechannel: instance not registered")
	}
	verdict := ChannelVerdict{
		PublicRequestID: publicID,
		ShortRequestID:  shortID,
		Behavior:        behavior,
	}
	return s.writeFrameConn(st, KindChannelVerdict, verdict)
}

// writeFrameConn serializes writes per connection so concurrent verdict +
// heartbeat writers cannot interleave frames.
func (s *Server) writeFrameConn(st *instanceState, kind string, payload any) error {
	st.connMu.Lock()
	defer st.connMu.Unlock()
	return s.writeFrame(st.conn, kind, payload)
}

// writeFrame writes one envelope to conn. A per-write deadline guards
// against slow/stuck peers.
func (s *Server) writeFrame(conn net.Conn, kind string, payload any) error {
	frame, err := EncodeEnvelope(kind, payload)
	if err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(s.now().Add(HeartbeatInterval * 2))
	return writeFull(conn, frame)
}

// readEnvelope reads one newline-terminated frame from r. It handles the
// "need more data" case by looping, and enforces the frame cap.
func readEnvelope(r *bufio.Reader) (Envelope, error) {
	for {
		line, err := r.ReadBytes('\n')
		if errors.Is(err, io.EOF) && len(line) > 0 {
			// trailing frame without newline; attempt decode
			env, decErr := decodeLine(line)
			if decErr != nil {
				return Envelope{}, io.EOF
			}
			return env, nil
		}
		if err != nil {
			return Envelope{}, err
		}
		return decodeLine(line)
	}
}

func decodeLine(line []byte) (Envelope, error) {
	if len(line) > MaxJSONRPCFrame {
		return Envelope{}, errOversizedFrame
	}
	var env Envelope
	if err := json.Unmarshal(line[:len(line)-1], &env); err != nil {
		// line may or may not include trailing newline; tolerate both.
		if err2 := json.Unmarshal(line, &env); err2 != nil {
			return Envelope{}, err
		}
	}
	return env, nil
}

// ErrClosed is returned when the server (or a connection) is closed.
var ErrClosed = errors.New("claudechannel: server closed")

// SocketPath returns the IPC path the server is bound to.
func (s *Server) SocketPath() string { return s.socketPath }

// MCPConfigPath returns the Pocketctl-owned MCP config path handed to shims.
func (s *Server) MCPConfigPath() string { return s.mcpConfig }

// Now returns the server's clock (injectable for tests).
func (s *Server) Now() time.Time { return s.now() }

// SetNow installs a clock override (tests only).
func (s *Server) SetNow(now func() time.Time) {
	s.mu.Lock()
	s.now = now
	s.mu.Unlock()
}

// InstanceCount returns the number of registered Channel instances (for
// diagnostics/telemetry; not used for routing).
func (s *Server) InstanceCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.instances)
}

// CloseInstance disconnects a specific Channel instance without affecting
// others. Used when the binding layer observes the Claude session exit.
func (s *Server) CloseInstance(instanceID, reason string) {
	s.mu.Lock()
	st, ok := s.instances[instanceID]
	delete(s.instances, instanceID)
	s.mu.Unlock()
	if !ok {
		return
	}
	_ = s.writeFrameConn(st, KindChannelClose, ChannelClose{Reason: reason})
	st.closeOnce.Do(func() {
		_ = st.conn.Close()
		close(st.closed)
	})
}

// AssertNoVerdictReplay is a test-only assertion hook that the Responder's
// at-most-once guard is in place. Reserved for the fault-injection task.
var AssertNoVerdictReplay = func(_ *Responder) {}
