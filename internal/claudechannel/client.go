package claudechannel

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// Client is the Channel-process side of the Claude Channel IPC. It performs
// the bootstrap handshake, registers, and then ferries permission requests
// from Claude stdio to the daemon and verdicts from the daemon back to
// Claude stdio.
//
// The Client does NOT own at-most-once semantics for verdict delivery to
// Claude — that contract is owned by the Channel stdio glue (Task 6). The
// Client only guarantees it forwards each verdict frame received from the
// daemon exactly once to the OnVerdict callback.
type Client struct {
	socketPath string
	timeout    time.Duration
	// Dial overrides the default dialer (tests inject fakes).
	Dial func(string) (net.Conn, error)
}

// NewClient constructs a Client. timeout caps the bootstrap connect+handshake.
func NewClient(socketPath string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = DefaultBootstrapTTL
	}
	c := &Client{socketPath: socketPath, timeout: timeout}
	c.Dial = func(path string) (net.Conn, error) {
		return Dial(path)
	}
	return c
}

// BootstrapResult is the post-handshake state. The caller must keep the
// token private and pass it to Register.
type BootstrapResult struct {
	InstanceID      string
	CapabilityToken string
	MCPConfigPath   string
	ExpiresAt       time.Time
}

// Bootstrap performs the short-lived bootstrap.acquire reservation. The
// server closes this connection after replying; it is returned only so the
// caller can close its local handle before exec. Channel uses Claim on a new
// connection.
func (c *Client) Bootstrap(ctx context.Context, claudeParentPID int, protocolVersion string) (BootstrapResult, net.Conn, *bufio.Reader, error) {
	dial := c.Dial
	if dial == nil {
		return BootstrapResult{}, nil, nil, errors.New("claudechannel: no dialer")
	}
	connectCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	conn, err := dialContext(connectCtx, c.socketPath, dial)
	if err != nil {
		return BootstrapResult{}, nil, nil, fmt.Errorf("claudechannel: dial: %w", err)
	}
	reader := bufio.NewReader(conn)
	processIdentity, _ := platform.ProcessStartIdentity(claudeParentPID)
	// Send bootstrap.acquire.
	if err := writeClientFrame(conn, KindBootstrapAcquire, BootstrapAcquire{
		ClaudeParentPID:      claudeParentPID,
		ProtocolVersion:      protocolVersion,
		ProcessStartIdentity: processIdentity,
	}); err != nil {
		_ = conn.Close()
		return BootstrapResult{}, nil, nil, err
	}
	// Read bootstrap result.
	env, err := readClientEnvelope(reader)
	if err != nil {
		_ = conn.Close()
		return BootstrapResult{}, nil, nil, err
	}
	if env.Kind != KindBootstrapAcquire {
		_ = conn.Close()
		return BootstrapResult{}, nil, nil, fmt.Errorf("claudechannel: expected bootstrap reply, got %s", env.Kind)
	}
	var result BootstrapAcquireResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		_ = conn.Close()
		return BootstrapResult{}, nil, nil, fmt.Errorf("claudechannel: bootstrap decode: %w", err)
	}
	return BootstrapResult{
		InstanceID:      result.InstanceID,
		CapabilityToken: result.CapabilityToken,
		MCPConfigPath:   result.MCPConfigPath,
		ExpiresAt:       result.ExpiresAt,
	}, conn, reader, nil
}

// BindReservation updates a bootstrap reservation to the real Claude child
// process. It is used by the Windows supervisor after cmd.Start; the token is
// the authority and never leaves local IPC.
func (c *Client) BindReservation(ctx context.Context, instanceID, token string, claudeParentPID int) error {
	if instanceID == "" || token == "" || claudeParentPID <= 0 {
		return errors.New("claudechannel: invalid bootstrap bind")
	}
	if c.Dial == nil {
		return errors.New("claudechannel: no dialer")
	}
	connectCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	conn, err := dialContext(connectCtx, c.socketPath, c.Dial)
	if err != nil {
		return fmt.Errorf("claudechannel: bind dial: %w", err)
	}
	defer conn.Close()
	identity, err := platform.ProcessStartIdentity(claudeParentPID)
	if err != nil {
		return fmt.Errorf("claudechannel: bind process identity: %w", err)
	}
	if err := writeClientFrame(conn, KindBootstrapBind, BootstrapBind{
		InstanceID: instanceID, CapabilityToken: token,
		ClaudeParentPID: claudeParentPID, ProcessStartIdentity: identity,
	}); err != nil {
		return err
	}
	env, err := readClientEnvelope(bufio.NewReader(conn))
	if err != nil {
		return err
	}
	if env.Kind != KindBootstrapBind {
		return fmt.Errorf("claudechannel: expected bootstrap bind reply, got %s", env.Kind)
	}
	return nil
}

// Register writes channel.register on a fresh claim connection. Claim is the
// normal public entry point; tests use this lower-level encoder directly.
func (c *Client) Register(conn net.Conn, instanceID, token string, channelPID, claudeParentPID int, protocolVersion string) error {
	identity, _ := platform.ProcessStartIdentity(claudeParentPID)
	reg := ChannelRegister{
		InstanceID:           instanceID,
		CapabilityToken:      token,
		ChannelPID:           channelPID,
		ClaudeParentPID:      claudeParentPID,
		ProtocolVersion:      protocolVersion,
		ProcessStartIdentity: identity,
	}
	return writeClientFrame(conn, KindChannelRegister, reg)
}

// Claim opens the Channel's long-lived connection and presents credentials
// reserved earlier by the shim. The shim reservation connection cannot be
// reused because it is closed before Claude spawns this process.
func (c *Client) Claim(ctx context.Context, instanceID, token string, channelPID, claudeParentPID int, protocolVersion string) (net.Conn, *bufio.Reader, error) {
	if instanceID == "" || token == "" {
		return nil, nil, errors.New("claudechannel: missing claim credentials")
	}
	claimCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	conn, err := dialContext(claimCtx, c.socketPath, c.Dial)
	if err != nil {
		return nil, nil, fmt.Errorf("claudechannel: claim dial: %w", err)
	}
	if err := c.Register(conn, instanceID, token, channelPID, claudeParentPID, protocolVersion); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	return conn, bufio.NewReader(conn), nil
}

// SendRequest sends a permission request to the daemon. Used by the Channel
// stdio glue when Claude emits a permission notification. Accepts an io.Writer
// so test fakes and partial-Conn wrappers can drive it without a real net.Conn.
func (c *Client) SendRequest(w io.Writer, instanceID, shortID, toolName, description, inputPreview string) error {
	req := ChannelRequest{
		InstanceID:     instanceID,
		ShortRequestID: shortID,
		ToolName:       toolName,
		Description:    SanitizePreview(description),
		InputPreview:   SanitizePreview(inputPreview),
	}
	frame, err := EncodeEnvelope(KindChannelRequest, req)
	if err != nil {
		return err
	}
	// Apply write deadline only when the writer is a real connection.
	if conn, ok := w.(net.Conn); ok {
		_ = conn.SetWriteDeadline(time.Now().Add(HeartbeatInterval * 2))
	}
	return writeFull(w, frame)
}

func (c *Client) SendPong(w io.Writer) error {
	frame, err := EncodeEnvelope(KindPong, PongPayload{At: time.Now()})
	if err != nil {
		return err
	}
	if conn, ok := w.(net.Conn); ok {
		_ = conn.SetWriteDeadline(time.Now().Add(HeartbeatInterval * 2))
	}
	return writeFull(w, frame)
}

// Pinger periodically writes ping frames so the daemon's heartbeat loop
// sees liveness. Returns when ctx is canceled or conn closes.
type Pinger struct {
	conn net.Conn
	mu   sync.Mutex
}

// NewPinger constructs a heartbeat sender for an established connection.
func NewPinger(conn net.Conn) *Pinger { return &Pinger{conn: conn} }

// Ping writes a single ping frame.
func (p *Pinger) Ping() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return writeClientFrame(p.conn, KindPing, PingPayload{At: time.Now()})
}

// Close sends a channel.close frame and closes the connection.
func (c *Client) Close(conn net.Conn, reason string) error {
	_ = writeClientFrame(conn, KindChannelClose, ChannelClose{Reason: reason})
	return conn.Close()
}

// writeClientFrame writes one envelope. Per-write deadline guards against
// stuck daemon peers.
func writeClientFrame(conn net.Conn, kind string, payload any) error {
	frame, err := EncodeEnvelope(kind, payload)
	if err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(time.Now().Add(HeartbeatInterval * 2))
	return writeFull(conn, frame)
}

// readClientEnvelope reads one newline-terminated frame.
func readClientEnvelope(r *bufio.Reader) (Envelope, error) {
	for {
		line, err := r.ReadBytes('\n')
		if errors.Is(err, io.EOF) && len(line) > 0 {
			return decodeClientLine(line)
		}
		if err != nil {
			return Envelope{}, err
		}
		return decodeClientLine(line)
	}
}

func decodeClientLine(line []byte) (Envelope, error) {
	if len(line) > MaxJSONRPCFrame {
		return Envelope{}, errOversizedFrame
	}
	trim := line
	if len(trim) > 0 && trim[len(trim)-1] == '\n' {
		trim = trim[:len(trim)-1]
	}
	var env Envelope
	if err := json.Unmarshal(trim, &env); err != nil {
		return Envelope{}, err
	}
	return env, nil
}

// dialContext wraps a plain dialer with context cancellation. net.Dial does
// not honor context, so we race a goroutine against ctx.Done.
func dialContext(ctx context.Context, path string, dial func(string) (net.Conn, error)) (net.Conn, error) {
	type result struct {
		conn net.Conn
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		conn, err := dial(path)
		ch <- result{conn, err}
	}()
	select {
	case r := <-ch:
		return r.conn, r.err
	case <-ctx.Done():
		// Best effort: the goroutine's conn (if any) leaks until it returns.
		go func() {
			r := <-ch
			if r.conn != nil {
				_ = r.conn.Close()
			}
		}()
		return nil, ctx.Err()
	}
}
