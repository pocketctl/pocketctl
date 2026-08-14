package claudechannel

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"sync"
	"time"
)

// EnvInstanceID / EnvCapabilityToken are the environment variables the
// ClaudeLauncher sets when exec'ing real Claude. The Channel stdio process
// (a child of Claude) inherits them and uses them to register with the
// daemon. Design §1.2: "token 只存在于 Claude/Channel 子进程环境和 daemon
// 内存,禁止写 Relay、事件历史或日志".
const (
	EnvInstanceID      = "POCKETCTL_CLAUDE_CHANNEL_INSTANCE"
	EnvCapabilityToken = "POCKETCTL_CLAUDE_CHANNEL_TOKEN"
	EnvSocketPath      = "POCKETCTL_CLAUDE_CHANNEL_SOCKET"
	EnvClaudeParentPID = "POCKETCTL_CLAUDE_CHANNEL_CLAUDE_PID"
)

// ChannelStdioServer bridges Claude's MCP stdio surface (stdin/stdout) with
// the daemon's Claude Channel IPC. It is the process that real Claude
// spawns from the Pocketctl-owned MCP config.
//
// Responsibilities:
//   - initialize handshake advertising ONLY the channel/channel-permission
//     experimental capabilities.
//   - read permission request notifications from Claude stdin, sanitize and
//     forward them to the daemon via IPC.
//   - deliver at most ONE verdict notification per request to Claude stdout
//     when the daemon replies.
//   - on IPC disconnect / EOF / write failure: clear pending, never auto
//     deny, never replay. The native terminal approval stays operable.
//
// stdout MUST carry only JSON-RPC frames. All diagnostics go to stderr.
type ChannelStdioServer struct {
	stdin      io.Reader
	stdout     io.Writer
	stderr     io.Writer
	logger     *slog.Logger
	client     *Client
	instanceID string
	token      string
	socketPath string
	claudePID  int

	mu          sync.Mutex
	stdoutMu    sync.Mutex
	ipcWriteMu  sync.Mutex
	pending     map[string]struct{} // short request ids awaiting a verdict
	closed      bool
	verdictSent map[string]bool // short id -> already wrote a verdict
}

// ChannelStdioOptions configures a ChannelStdioServer. Defaults are pulled
// from the environment when the fields are zero.
type ChannelStdioOptions struct {
	Stdin      io.Reader
	Stdout     io.Writer
	Stderr     io.Writer
	Logger     *slog.Logger
	Client     *Client
	InstanceID string
	Token      string
	SocketPath string
	ClaudePID  int
}

// NewChannelStdioServerFromEnv builds a ChannelStdioServer from the env vars
// the launcher sets. It is the entry point for `pocketctl __claude_channel`.
func NewChannelStdioServerFromEnv(opts ChannelStdioOptions) (*ChannelStdioServer, error) {
	if opts.Stdin == nil {
		opts.Stdin = os.Stdin
	}
	if opts.Stdout == nil {
		opts.Stdout = os.Stdout
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if opts.InstanceID == "" {
		opts.InstanceID = os.Getenv(EnvInstanceID)
	}
	if opts.Token == "" {
		opts.Token = os.Getenv(EnvCapabilityToken)
	}
	if opts.SocketPath == "" {
		opts.SocketPath = os.Getenv(EnvSocketPath)
	}
	if opts.ClaudePID == 0 {
		opts.ClaudePID = os.Getppid()
	}
	if opts.SocketPath == "" {
		return nil, errors.New("claudechannel: missing socket path environment")
	}
	if opts.InstanceID == "" || opts.Token == "" {
		return nil, errors.New("claudechannel: missing claim credentials environment")
	}
	if opts.Client == nil {
		opts.Client = NewClient(opts.SocketPath, DefaultClaimTimeout)
	}
	return &ChannelStdioServer{
		stdin:       opts.Stdin,
		stdout:      opts.Stdout,
		stderr:      opts.Stderr,
		logger:      opts.Logger,
		client:      opts.Client,
		instanceID:  opts.InstanceID,
		token:       opts.Token,
		socketPath:  opts.SocketPath,
		claudePID:   opts.ClaudePID,
		pending:     make(map[string]struct{}),
		verdictSent: make(map[string]bool),
	}, nil
}

// Run continuously services Claude stdio. A daemon disconnect clears every
// in-flight request without a verdict, then re-bootstraps a fresh local
// identity for future requests. Claude stdin is read by exactly one goroutine
// for the lifetime of the process, so reconnect never races or replays input.
func (s *ChannelStdioServer) Run(ctx context.Context) error {
	mcpFrames := make(chan Request)
	go s.readClaudeFrames(ctx, mcpFrames)

	var conn net.Conn
	var daemonFrames <-chan daemonFrame
	firstClaim := true
	reconnect := time.NewTimer(0)
	defer reconnect.Stop()

	closeConnection := func(reason string) {
		if conn != nil {
			_ = s.client.Close(conn, reason)
			conn = nil
		}
		daemonFrames = nil
		s.mu.Lock()
		s.pending = make(map[string]struct{})
		s.mu.Unlock()
	}
	defer func() {
		closeConnection(CloseReasonChannelExit)
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case req, ok := <-mcpFrames:
			if !ok {
				return nil
			}
			if conn == nil {
				s.handleMCPNoIPC(req)
			} else {
				s.handleMCP(req, conn)
			}
		case frame := <-daemonFrames:
			if frame.err != nil || !s.handleDaemonFrame(frame.env, conn) {
				closeConnection("channel_disconnected")
				reconnect.Reset(ReconnectInterval)
			}
		case <-reconnect.C:
			newConn, reader, err := s.connect(ctx, firstClaim)
			firstClaim = false
			if err != nil {
				reconnect.Reset(ReconnectInterval)
				continue
			}
			conn = newConn
			frames := make(chan daemonFrame, 1)
			daemonFrames = frames
			go readDaemonFrameLoop(reader, frames)
		}
	}
}

type daemonFrame struct {
	env Envelope
	err error
}

func (s *ChannelStdioServer) readClaudeFrames(ctx context.Context, out chan<- Request) {
	defer close(out)
	reader := bufio.NewReader(s.stdin)
	for {
		req, err := readMCPFrame(reader)
		if err != nil {
			return
		}
		select {
		case out <- req:
		case <-ctx.Done():
			return
		}
	}
}

func readDaemonFrameLoop(reader *bufio.Reader, out chan<- daemonFrame) {
	defer close(out)
	for {
		env, err := readClientEnvelope(reader)
		out <- daemonFrame{env: env, err: err}
		if err != nil {
			return
		}
	}
}

func (s *ChannelStdioServer) connect(ctx context.Context, initial bool) (net.Conn, *bufio.Reader, error) {
	claimCtx, cancel := context.WithTimeout(ctx, DefaultClaimTimeout)
	defer cancel()
	if !initial {
		boot, reservation, _, err := s.client.Bootstrap(claimCtx, s.claudePID, MCPProtocolVersion)
		if err != nil {
			return nil, nil, err
		}
		_ = reservation.Close()
		s.instanceID = boot.InstanceID
		s.token = boot.CapabilityToken
	}
	return s.client.Claim(claimCtx, s.instanceID, s.token, os.Getpid(), s.claudePID, MCPProtocolVersion)
}

func (s *ChannelStdioServer) handleDaemonFrame(env Envelope, conn io.Writer) bool {
	switch env.Kind {
	case KindChannelVerdict:
		var verdict ChannelVerdict
		if json.Unmarshal(env.Payload, &verdict) == nil && ValidBehavior(verdict.Behavior) {
			s.deliverVerdictToClaude(verdict.ShortRequestID, verdict.Behavior)
		}
	case KindChannelClose:
		return false
	case KindPing:
		s.ipcWriteMu.Lock()
		_ = s.client.SendPong(conn)
		s.ipcWriteMu.Unlock()
	case KindPong:
	}
	return true
}

// runMCPOnly handles the MCP stdin/stdout handshake when the IPC is
// unavailable. initialize is still answered so Claude does not error out;
// permission requests are answered with the standard "no verdict" behavior
// (we do NOT send allow/deny — Claude keeps waiting and the native TUI
// remains operable).
func (s *ChannelStdioServer) runMCPOnly(ctx context.Context) error {
	reader := bufio.NewReader(s.stdin)
	for {
		req, err := readMCPFrame(reader)
		if err != nil {
			return nil
		}
		s.handleMCPNoIPC(req)
		if ctx.Err() != nil {
			return nil
		}
	}
}

// readClaudeStdin reads MCP JSON-RPC frames from Claude and:
//   - answers initialize/initialized/ping inline.
//   - forwards permission requests to the daemon via the IPC connection.
func (s *ChannelStdioServer) readClaudeStdin(conn io.Writer) {
	reader := bufio.NewReader(s.stdin)
	for {
		req, err := readMCPFrame(reader)
		if err != nil {
			return
		}
		s.handleMCP(req, conn)
	}
}

// handleMCP dispatches a single MCP request from Claude. conn is the IPC
// connection used to forward permission requests to the daemon.
func (s *ChannelStdioServer) handleMCP(req Request, conn io.Writer) {
	switch req.Method {
	case MethodInitialize:
		result := NewInitializeResult()
		body, _ := json.Marshal(result)
		resp := Response{JSONRPC: JSONRPCVersion, ID: req.ID, Result: body}
		_ = s.writeMCPFrame(resp)
	case MethodInitialized:
		// notification: no response
	case MethodPing:
		if len(req.ID) > 0 {
			resp := Response{JSONRPC: JSONRPCVersion, ID: req.ID, Result: json.RawMessage(`{}`)}
			_ = s.writeMCPFrame(resp)
		}
	case MethodChannelPermissionRequest:
		s.handlePermissionRequest(req, conn)
	default:
		// Unknown method: ignore. Do NOT log params.
		s.logger.Debug("claudechannel: unknown mcp method ignored", "method", req.Method)
	}
}

// handleMCPNoIPC is the degraded handler used when IPC bootstrap failed.
func (s *ChannelStdioServer) handleMCPNoIPC(req Request) {
	switch req.Method {
	case MethodInitialize:
		result := NewInitializeResult()
		body, _ := json.Marshal(result)
		resp := Response{JSONRPC: JSONRPCVersion, ID: req.ID, Result: body}
		_ = s.writeMCPFrame(resp)
	case MethodInitialized:
	case MethodPing:
		if len(req.ID) > 0 {
			resp := Response{JSONRPC: JSONRPCVersion, ID: req.ID, Result: json.RawMessage(`{}`)}
			_ = s.writeMCPFrame(resp)
		}
	case MethodChannelPermissionRequest:
		// No IPC: do nothing. Claude's native TUI keeps the prompt open.
	}
}

// handlePermissionRequest validates the payload, tracks it as pending, and
// forwards a sanitized ChannelRequest to the daemon.
func (s *ChannelStdioServer) handlePermissionRequest(req Request, conn io.Writer) {
	params, err := ValidatePermissionRequest(req.Params)
	if err != nil {
		s.logger.Debug("claudechannel: invalid permission request", "error", err)
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if _, exists := s.pending[params.RequestID]; exists {
		s.mu.Unlock()
		return
	}
	s.pending[params.RequestID] = struct{}{}
	s.mu.Unlock()
	s.ipcWriteMu.Lock()
	err = s.client.SendRequest(conn, s.instanceID, params.RequestID, params.ToolName, params.Description, params.InputPreview)
	s.ipcWriteMu.Unlock()
	if err != nil {
		// IPC write failed: drop pending. Do NOT auto-deny.
		s.mu.Lock()
		delete(s.pending, params.RequestID)
		s.mu.Unlock()
		s.logger.Debug("claudechannel: forward request failed", "error", err)
	}
}

// readDaemonFrames reads ChannelVerdict / ChannelClose frames from the IPC
// connection and forwards verdicts to Claude stdout. At-most-once: each
// short request id gets exactly one verdict notification.
func (s *ChannelStdioServer) readDaemonFrames(r *bufio.Reader, conn io.Writer) {
	for {
		env, err := readClientEnvelope(r)
		if err != nil {
			return
		}
		switch env.Kind {
		case KindChannelVerdict:
			var verdict ChannelVerdict
			if err := json.Unmarshal(env.Payload, &verdict); err != nil {
				continue
			}
			if !ValidBehavior(verdict.Behavior) {
				continue
			}
			s.deliverVerdictToClaude(verdict.ShortRequestID, verdict.Behavior)
		case KindChannelClose:
			s.logger.Debug("claudechannel: daemon closed channel", "reason", "peer_close")
			// IPC gone: clear all pending so they never get auto-denied or
			// replayed. The native TUI continues.
			s.mu.Lock()
			s.pending = make(map[string]struct{})
			s.mu.Unlock()
			return
		case KindPing:
			s.ipcWriteMu.Lock()
			_ = s.client.SendPong(conn)
			s.ipcWriteMu.Unlock()
		case KindPong:
			// Response to our own ping; ignore.
		}
	}
}

// deliverVerdictToClaude writes ONE notifications/claude/channel/permission
// frame with the behavior set. At-most-once: a second call for the same
// short id is a no-op.
func (s *ChannelStdioServer) deliverVerdictToClaude(shortID, behavior string) {
	s.mu.Lock()
	if _, sent := s.verdictSent[shortID]; sent {
		s.mu.Unlock()
		return
	}
	if _, ok := s.pending[shortID]; !ok {
		// Not currently tracked (may have been cleared by IPC disconnect).
		// Record so a late duplicate won't double-write.
		s.verdictSent[shortID] = true
		s.mu.Unlock()
		return
	}
	s.verdictSent[shortID] = true
	delete(s.pending, shortID)
	s.mu.Unlock()
	notification, err := BuildVerdictNotification(PermissionVerdictParams{
		RequestID: shortID, Behavior: behavior,
	})
	if err != nil {
		return
	}
	_ = s.writeMCPFrame(notification)
}

// --- helpers --------------------------------------------------------------

// readMCPFrame reads a single JSON-RPC frame from r (newline-terminated,
// capped at MaxJSONRPCFrame).
func readMCPFrame(r *bufio.Reader) (Request, error) {
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return Request{}, err
		}
		if len(line) > MaxJSONRPCFrame {
			continue
		}
		trim := line
		if len(trim) > 0 && trim[len(trim)-1] == '\n' {
			trim = trim[:len(trim)-1]
		}
		if len(trim) == 0 {
			continue
		}
		var req Request
		if err := json.Unmarshal(trim, &req); err != nil {
			continue
		}
		return req, nil
	}
}

// writeMCPFrame writes a single JSON-RPC frame to w. stdout is locked
// per-write so concurrent verdict and initialize writers cannot interleave.
func writeMCPFrame(w io.Writer, v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(body) > MaxJSONRPCFrame {
		return errOversizedFrame
	}
	return writeFull(w, append(body, '\n'))
}

func (s *ChannelStdioServer) writeMCPFrame(v any) error {
	s.stdoutMu.Lock()
	defer s.stdoutMu.Unlock()
	return writeMCPFrame(s.stdout, v)
}

// RunChannelStdio is the entry point invoked by main.go for the hidden
// `__claude_channel` subcommand. It MUST be identified before the regular
// CLI switch so Pocketctl help never pollutes stdio.
func RunChannelStdio(ctx context.Context) error {
	srv, err := NewChannelStdioServerFromEnv(ChannelStdioOptions{})
	if err != nil {
		// The Channel process must exit 0 so Claude does not observe a
		// non-zero status that could be misinterpreted as a verdict.
		fmt.Fprintln(os.Stderr, "claudechannel:", err)
		return nil
	}
	return srv.Run(ctx)
}

// PendingCount returns the number of in-flight permission requests awaiting
// a daemon verdict. Test-only.
func (s *ChannelStdioServer) PendingCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

// VerdictSentCount returns the number of verdicts already written to Claude
// stdout. Test-only.
func (s *ChannelStdioServer) VerdictSentCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.verdictSent)
}
