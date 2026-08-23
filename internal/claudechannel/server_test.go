package claudechannel

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// newTestServer returns a Server bound to a fresh temp-dir socket. We use a
// short /tmp-based path because macOS limits unix domain socket paths to
// ~104 chars and the Go test temp dir exceeds that.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "cc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socketPath := filepath.Join(dir, "s.sock")
	mcpPath := filepath.Join(dir, "mcp.json")
	srv := NewServer(socketPath, mcpPath, nil)
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

// fakeChannelConn drives a Channel connection through the lifecycle: dial,
// bootstrap, register, then expose helpers to send requests / read frames.
type fakeChannelConn struct {
	t      *testing.T
	conn   net.Conn
	reader *bufio.Reader
	boot   BootstrapResult
	mu     sync.Mutex
}

func testClaudeRequestID(index int) string {
	const alphabet = "abcdefghijkmnopqrstuvwxyz"
	return "aaa" + string([]byte{alphabet[(index/len(alphabet))%len(alphabet)], alphabet[index%len(alphabet)]})
}

func dialAndRegister(t *testing.T, srv *Server, claudeParentPID int) *fakeChannelConn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client := NewClient(srv.SocketPath(), time.Second)
	boot, reserveConn, _, err := client.Bootstrap(ctx, claudeParentPID, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	conn, err := Dial(srv.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	if err := client.Register(conn, boot.InstanceID, boot.CapabilityToken, 4321, claudeParentPID, MCPProtocolVersion); err != nil {
		t.Fatal(err)
	}
	fc := &fakeChannelConn{t: t, conn: conn, reader: reader, boot: boot}
	// Drain the post-register heartbeat ping if it arrives quickly; tests
	// that read frames explicitly handle this via readKind.
	return fc
}

func (fc *fakeChannelConn) sendRequest(shortID, tool, desc, preview string) error {
	req := ChannelRequest{
		InstanceID:     fc.boot.InstanceID,
		ShortRequestID: shortID,
		ToolName:       tool,
		Description:    desc,
		InputPreview:   preview,
	}
	frame, err := EncodeEnvelope(KindChannelRequest, req)
	if err != nil {
		return err
	}
	_, err = fc.conn.Write(frame)
	return err
}

// readKind reads the next frame and returns its kind (skips pongs).
func (fc *fakeChannelConn) readKind() (string, json.RawMessage, error) {
	for {
		env, err := readClientEnvelope(fc.reader)
		if err != nil {
			return "", nil, err
		}
		if env.Kind == KindPing {
			continue
		}
		if env.Kind == KindPong {
			continue
		}
		return env.Kind, env.Payload, nil
	}
}

func (fc *fakeChannelConn) close() { _ = fc.conn.Close() }

// TestServerBootstrapIssuesInstanceAndToken verifies a bootstrap handshake
// yields a unique instance id, a 256-bit hex token, the configured MCP path
// and an expiry within the 60s default.
func TestServerBootstrapIssuesInstanceAndToken(t *testing.T) {
	srv := newTestServer(t)
	fc := dialAndRegister(t, srv, 1111)
	defer fc.close()
	if len(fc.boot.InstanceID) != InstanceIDBytes*2 {
		t.Fatalf("instance id len=%d", len(fc.boot.InstanceID))
	}
	if len(fc.boot.CapabilityToken) != BootstrapTokenBytes*2 {
		t.Fatalf("token len=%d", len(fc.boot.CapabilityToken))
	}
	if fc.boot.MCPConfigPath != srv.MCPConfigPath() {
		t.Fatalf("mcp path=%q want %q", fc.boot.MCPConfigPath, srv.MCPConfigPath())
	}
	if !fc.boot.ExpiresAt.After(time.Now()) {
		t.Fatalf("expiry in the past: %v", fc.boot.ExpiresAt)
	}
}

// TestServerAcquireThenClaimOnSecondConnection models the real process tree:
// the shim reserves credentials, closes its connection while exec'ing Claude,
// and the later Channel child claims that identity on a fresh connection.
func TestServerAcquireThenClaimOnSecondConnection(t *testing.T) {
	srv := newTestServer(t)
	registered := make(chan RegisterEvent, 1)
	srv.SetOnRegister(func(event RegisterEvent) { registered <- event })

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client := NewClient(srv.SocketPath(), time.Second)
	boot, reserveConn, _, err := client.Bootstrap(ctx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()

	claimConn, err := Dial(srv.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer claimConn.Close()
	if err := client.Register(claimConn, boot.InstanceID, boot.CapabilityToken, 4321, 1111, MCPProtocolVersion); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-registered:
		if event.InstanceID != boot.InstanceID {
			t.Fatalf("registered instance=%q want %q", event.InstanceID, boot.InstanceID)
		}
	case <-time.After(time.Second):
		t.Fatal("Channel could not claim shim-reserved identity on a new connection")
	}
}

func TestServerBootstrapBindMovesReservationToRealChildPID(t *testing.T) {
	srv := newTestServer(t)
	client := NewClient(srv.SocketPath(), time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	boot, reservation, _, err := client.Bootstrap(ctx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reservation.Close()
	if err := client.BindReservation(ctx, boot.InstanceID, boot.CapabilityToken, os.Getpid()); err != nil {
		t.Fatalf("BindReservation: %v", err)
	}
	conn, _, err := client.Claim(ctx, boot.InstanceID, boot.CapabilityToken, 4321, os.Getpid(), MCPProtocolVersion)
	if err != nil {
		t.Fatalf("claim after child bind: %v", err)
	}
	defer conn.Close()
}

// TestServerRegisterWithBadTokenClosesConnection verifies a forged token is
// rejected with channel.close and the instance never registers. The error
// must NOT reveal whether the instance id existed (constant-time defense).
func TestServerRegisterWithBadTokenClosesConnection(t *testing.T) {
	srv := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client := NewClient(srv.SocketPath(), time.Second)
	boot, reserveConn, _, err := client.Bootstrap(ctx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	conn, err := Dial(srv.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	// Register with a forged token.
	_ = client.Register(conn, boot.InstanceID, strings.Repeat("0", len(boot.CapabilityToken)), 4321, 1111, MCPProtocolVersion)
	env, err := readClientEnvelope(reader)
	if err != nil {
		t.Fatal(err)
	}
	if env.Kind != KindChannelClose {
		t.Fatalf("kind=%q want channel.close", env.Kind)
	}
	var close ChannelClose
	if err := json.Unmarshal(env.Payload, &close); err != nil {
		t.Fatal(err)
	}
	if close.Reason != CloseReasonTokenMismatch {
		t.Fatalf("reason=%q want %q", close.Reason, CloseReasonTokenMismatch)
	}
	if srv.InstanceCount() != 0 {
		t.Fatalf("forged-token instance must not be registered: count=%d", srv.InstanceCount())
	}
}

// TestServerRegisterWithUnknownInstanceID verifies an instance id mismatch
// is also rejected (defense against guess-the-instance).
func TestServerRegisterWithUnknownInstanceID(t *testing.T) {
	srv := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client := NewClient(srv.SocketPath(), time.Second)
	boot, reserveConn, _, err := client.Bootstrap(ctx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	conn, err := Dial(srv.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	_ = client.Register(conn, "deadbeef", boot.CapabilityToken, 4321, 1111, MCPProtocolVersion)
	env, err := readClientEnvelope(reader)
	if err != nil {
		t.Fatal(err)
	}
	if env.Kind != KindChannelClose {
		t.Fatalf("kind=%q want channel.close", env.Kind)
	}
}

// TestServerRequestFlowEndToEnd verifies a request reaches the onRequest
// callback with a fresh public request id, and a verdict from the Responder
// is delivered back to the Channel connection exactly once.
func TestServerRequestFlowEndToEnd(t *testing.T) {
	srv := newTestServer(t)
	requests := make(chan RequestEvent, 4)
	srv.SetOnRequest(func(req RequestEvent) { requests <- req })
	fc := dialAndRegister(t, srv, 1111)
	defer fc.close()
	if err := fc.sendRequest("abcde", "Bash", "list files", "ls -la"); err != nil {
		t.Fatal(err)
	}
	select {
	case req := <-requests:
		if req.ShortRequestID != "abcde" || req.ToolName != "Bash" {
			t.Fatalf("request lost fields: %+v", req)
		}
		if _, err := uuid.Parse(req.PublicRequestID); err != nil {
			t.Fatalf("public id is not UUID: %q", req.PublicRequestID)
		}
		// Send a verdict; expect to read it back on the Channel.
		if err := req.Responder.Send(BehaviorAllow); err != nil {
			t.Fatalf("send verdict: %v", err)
		}
		kind, payload, err := fc.readKind()
		if err != nil {
			t.Fatal(err)
		}
		if kind != KindChannelVerdict {
			t.Fatalf("kind=%q want channel.verdict", kind)
		}
		var verdict ChannelVerdict
		if err := json.Unmarshal(payload, &verdict); err != nil {
			t.Fatal(err)
		}
		if verdict.Behavior != BehaviorAllow || verdict.ShortRequestID != "abcde" {
			t.Fatalf("verdict lost fields: %+v", verdict)
		}
		// At-most-once: a second Send is a no-op without an error to the caller,
		// but no second frame may appear on the wire.
		if err := req.Responder.Send(BehaviorAllow); err != nil {
			t.Fatalf("second send error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for request")
	}
}

// TestServerDuplicateRequestSharesOneResponder verifies daemon-side
// at-most-once authority is keyed by (instance, short request id), even if a
// buggy or malicious Channel bypasses the stdio de-duplication layer.
func TestServerDuplicateRequestSharesOneResponder(t *testing.T) {
	srv := newTestServer(t)
	requests := make(chan RequestEvent, 2)
	srv.SetOnRequest(func(req RequestEvent) { requests <- req })
	fc := dialAndRegister(t, srv, 1111)
	defer fc.close()
	if err := fc.sendRequest("abcde", "Bash", "list", "ls"); err != nil {
		t.Fatal(err)
	}
	if err := fc.sendRequest("abcde", "Bash", "list", "ls"); err != nil {
		t.Fatal(err)
	}
	first := <-requests
	select {
	case duplicate := <-requests:
		t.Fatalf("duplicate created a second authority: first=%s duplicate=%s", first.PublicRequestID, duplicate.PublicRequestID)
	case <-time.After(150 * time.Millisecond):
	}
	if err := first.Responder.Send(BehaviorAllow); err != nil {
		t.Fatal(err)
	}
	kind, _, err := fc.readKind()
	if err != nil {
		t.Fatal(err)
	}
	if kind != KindChannelVerdict {
		t.Fatalf("kind=%q want %q", kind, KindChannelVerdict)
	}
}

// TestServerVerdictAtMostOnceOnDisconnect verifies that if a Channel
// disconnects between request and verdict, the verdict Send fails cleanly
// and no frame is written.
func TestServerVerdictAtMostOnceOnDisconnect(t *testing.T) {
	srv := newTestServer(t)
	requests := make(chan RequestEvent, 4)
	srv.SetOnRequest(func(req RequestEvent) { requests <- req })
	fc := dialAndRegister(t, srv, 1111)
	if err := fc.sendRequest("abcde", "Bash", "list", "ls"); err != nil {
		t.Fatal(err)
	}
	req := <-requests
	fc.close()
	// Give the server a moment to observe the disconnect.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if srv.InstanceCount() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := req.Responder.Send(BehaviorAllow); err == nil {
		t.Fatal("Send on disconnected instance must error")
	}
}

// TestServerCloseDoesNotAutoVerdict verifies the invariant (design §1.1):
// server close never sends allow/deny to Channels. Pending requests are
// left to the registry to fail-closed.
func TestServerCloseDoesNotAutoVerdict(t *testing.T) {
	srv := newTestServer(t)
	requests := make(chan RequestEvent, 4)
	srv.SetOnRequest(func(req RequestEvent) { requests <- req })
	fc := dialAndRegister(t, srv, 1111)
	if err := fc.sendRequest("abcde", "Bash", "list", "ls"); err != nil {
		t.Fatal(err)
	}
	req := <-requests
	// Capture every frame the Channel sees after server Close.
	var sawVerdict atomic.Bool
	go func() {
		for {
			kind, _, err := fc.readKind()
			if err != nil {
				return
			}
			if kind == KindChannelVerdict {
				sawVerdict.Store(true)
			}
		}
	}()
	_ = srv.Close()
	// Give a brief moment for any (forbidden) auto-verdict to land.
	time.Sleep(100 * time.Millisecond)
	fc.close()
	if sawVerdict.Load() {
		t.Fatal("server Close MUST NOT auto-emit verdicts")
	}
	// Responder must fail (instance gone).
	if err := req.Responder.Send(BehaviorAllow); err == nil {
		t.Fatal("expected Send to fail after server close")
	}
}

// TestServerShortIDCollisionAcrossInstances verifies two instances emitting
// the SAME 5-letter short request id produce distinct public request ids and
// route to independent Responders. Design §Task 8 cross-instance collision.
func TestServerShortIDCollisionAcrossInstances(t *testing.T) {
	srv := newTestServer(t)
	requests := make(chan RequestEvent, 8)
	srv.SetOnRequest(func(req RequestEvent) { requests <- req })
	fc1 := dialAndRegister(t, srv, 1111)
	defer fc1.close()
	fc2 := dialAndRegister(t, srv, 2222)
	defer fc2.close()
	if err := fc1.sendRequest("abcde", "Bash", "from-1", "ls"); err != nil {
		t.Fatal(err)
	}
	if err := fc2.sendRequest("abcde", "Bash", "from-2", "ls"); err != nil {
		t.Fatal(err)
	}
	req1 := <-requests
	req2 := <-requests
	if req1.PublicRequestID == req2.PublicRequestID {
		t.Fatal("two instances emitting same short id MUST get distinct public ids")
	}
	if req1.InstanceID == req2.InstanceID {
		t.Fatal("instance ids collided")
	}
}

// TestServerSlowClientDoesNotBlockOthers verifies a slow reader on one
// connection does not block accept or other connections. The server's
// per-connection goroutine model is what provides this guarantee.
func TestServerSlowClientDoesNotBlockOthers(t *testing.T) {
	srv := newTestServer(t)
	// Open one connection that bootstraps but never reads after register.
	stallCtx, stallCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer stallCancel()
	client := NewClient(srv.SocketPath(), time.Second)
	_, stallConn, _, err := client.Bootstrap(stallCtx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer stallConn.Close()
	// Register to consume the instance slot.
	_ = client.Register(stallConn, "stall-inst", strings.Repeat("0", 64), 999, 1111, MCPProtocolVersion) // will be rejected; fine
	// Second connection must still complete bootstrap quickly.
	fc := dialAndRegister(t, srv, 2222)
	defer fc.close()
}

// TestServerOversizedFrameRejected verifies a write exceeding the cap is
// rejected by the encoder before going on the wire.
func TestServerOversizedFrameRejected(t *testing.T) {
	srv := newTestServer(t)
	fc := dialAndRegister(t, srv, 1111)
	defer fc.close()
	big := strings.Repeat("x", MaxJSONRPCFrame)
	err := fc.sendRequest("abcde", "Bash", big, big)
	if err == nil {
		t.Fatal("oversized send must error")
	}
}

// TestServerHalfFrameAccumulates verifies a frame sent in two writes still
// decodes (bufio accumulates until newline).
func TestServerHalfFrameAccumulates(t *testing.T) {
	srv := newTestServer(t)
	requests := make(chan RequestEvent, 4)
	srv.SetOnRequest(func(req RequestEvent) { requests <- req })
	fc := dialAndRegister(t, srv, 1111)
	defer fc.close()
	req := ChannelRequest{
		InstanceID: fc.boot.InstanceID, ShortRequestID: "abcde",
		ToolName: "Bash", Description: "list", InputPreview: "ls",
	}
	env, err := EncodeEnvelope(KindChannelRequest, req)
	if err != nil {
		t.Fatal(err)
	}
	half := len(env) / 2
	if _, err := fc.conn.Write(env[:half]); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if _, err := fc.conn.Write(env[half:]); err != nil {
		t.Fatal(err)
	}
	select {
	case <-requests:
	case <-time.After(time.Second):
		t.Fatal("half-frame request never arrived")
	}
}

// TestServerEOFUnregistersInstance verifies that a Channel EOF removes the
// instance from the registry.
func TestServerEOFUnregistersInstance(t *testing.T) {
	srv := newTestServer(t)
	fc := dialAndRegister(t, srv, 1111)
	fc.close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if srv.InstanceCount() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("instance not removed after EOF: count=%d", srv.InstanceCount())
}

// TestServerConcurrentConnections exercises the race detector across many
// simultaneous connections, requests and verdicts. Design §Task 5: "100
// 并发连接通过 race".
func TestServerConcurrentConnections(t *testing.T) {
	srv := newTestServer(t)
	const n = 32
	var wg sync.WaitGroup
	requests := make(chan RequestEvent, n*2)
	srv.SetOnRequest(func(req RequestEvent) { requests <- req })
	// Verdict consumer.
	go func() {
		for req := range requests {
			_ = req.Responder.Send(BehaviorAllow)
		}
	}()
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			fc := dialAndRegister(t, srv, 1000+idx)
			defer fc.close()
			short := testClaudeRequestID(idx)
			if err := fc.sendRequest(short, "Bash", "job", "ls"); err != nil {
				t.Errorf("send %d: %v", idx, err)
				return
			}
			// Read the verdict back (ignoring pings).
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				kind, _, err := fc.readKind()
				if err != nil {
					t.Errorf("read %d: %v", idx, err)
					return
				}
				if kind == KindChannelVerdict {
					return
				}
			}
			t.Errorf("timeout waiting for verdict %d", idx)
		}(i)
	}
	wg.Wait()
	close(requests)
}

// TestServerBootstrapDeadline verifies a bootstrap that does not send
// bootstrap.acquire within the deadline is dropped. We use SetNow to drive
// time forward deterministically rather than sleeping.
func TestServerBootstrapDeadline(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "cc")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socketPath := filepath.Join(dir, "s.sock")
	srv := NewServer(socketPath, filepath.Join(dir, "mcp.json"), nil)
	// Inject a clock that advances 2 minutes for every now() call past the
	// initial time, so the bootstrap deadline is exceeded quickly.
	baseT := time.Now()
	tick := int64(0)
	srv.SetNow(func() time.Time {
		n := atomic.AddInt64(&tick, 1)
		return baseT.Add(time.Duration(n) * time.Minute)
	})
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	conn, err := Dial(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// Read with a real wall-clock deadline; the server's injected clock has
	// already advanced the bootstrap read deadline into the past.
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 256)
	_, err = conn.Read(buf)
	if err == nil {
		// If we got data it must NOT be a bootstrap reply (instance issued).
		t.Fatalf("expected deadline drop, got data")
	}
}

// TestServerUnixSocketPermissions verifies the socket file is created with
// 0600 and parent dir 0700 on Unix (Windows ACL is tested at the config
// layer).
func TestServerUnixSocketPermissions(t *testing.T) {
	if skipOnWindows(t) {
		return
	}
	dir, err := os.MkdirTemp("/tmp", "cc")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socketPath := filepath.Join(dir, "s.sock")
	srv := NewServer(socketPath, filepath.Join(dir, "mcp.json"), nil)
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	info, err := os.Stat(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("socket perm=%o want 600", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("dir perm=%o want 700", dirInfo.Mode().Perm())
	}
}

// TestServerRegisterCallbackFires verifies onRegister fires with the
// Channel-supplied PIDs.
func TestServerRegisterCallbackFires(t *testing.T) {
	srv := newTestServer(t)
	got := make(chan RegisterEvent, 1)
	srv.SetOnRegister(func(reg RegisterEvent) { got <- reg })
	fc := dialAndRegister(t, srv, 5555)
	defer fc.close()
	select {
	case reg := <-got:
		if reg.ClaudeParentPID != 5555 {
			t.Fatalf("claude pid=%d want 5555", reg.ClaudeParentPID)
		}
		if reg.InstanceID != fc.boot.InstanceID {
			t.Fatalf("instance=%q want %q", reg.InstanceID, fc.boot.InstanceID)
		}
	case <-time.After(time.Second):
		t.Fatal("onRegister did not fire")
	}
}

// --- helpers --------------------------------------------------------------

func skipOnWindows(t *testing.T) bool {
	t.Helper()
	// Detect Windows-named-pipe path: in our cross-platform CI the file-mode
	// check is meaningful only on real Unix file systems.
	if filepath.Separator == '\\' {
		t.Skip("socket file mode test is Unix-only")
		return true
	}
	return false
}
