package claudechannel

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestChannelStdioRejectsMissingEnv verifies the Channel stdio process
// refuses to start without the socket-path env. Design §Task 6:
// "__claude_channel 只能从有效 instance/token 环境启动".
func TestChannelStdioRejectsMissingEnv(t *testing.T) {
	for _, tc := range []struct {
		name     string
		instance string
		token    string
		socket   string
	}{
		{name: "instance", token: "token", socket: "/socket"},
		{name: "token", instance: "instance", socket: "/socket"},
		{name: "socket", instance: "instance", token: "token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewChannelStdioServerFromEnv(ChannelStdioOptions{
				InstanceID: tc.instance, Token: tc.token, SocketPath: tc.socket,
			})
			if err == nil {
				t.Fatalf("expected error when %s is missing", tc.name)
			}
		})
	}
}

// stdioFixture wires a ChannelStdioServer against a real in-process
// claudechannel.Server. The ChannelStdioServer boots its OWN IPC connection
// (it does not reuse the fixture's); we capture the instance/token via the
// daemon's onRegister callback so we can drive verdicts. stdin is an
// io.Pipe so Claude frames can be streamed in without races or premature
// EOF.
type stdioFixture struct {
	t        *testing.T
	srv      *ChannelStdioServer
	stdinW   *io.PipeWriter
	stdoutMu *sync.Mutex
	stdout   *bytes.Buffer
	cancel   context.CancelFunc
	done     chan struct{}

	mu       sync.Mutex
	instance string
	token    string
}

func newStdioFixture(t *testing.T, onRequest func(RequestEvent), onRegister func(RegisterEvent)) *stdioFixture {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "cc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	dServer := NewServer(filepath.Join(dir, "s.sock"), filepath.Join(dir, "mcp.json"), nil)
	dServer.SetOnRegister(func(reg RegisterEvent) {
		// Capture the instance the Channel actually registered with.
		// The token is not exposed by RegisterEvent (it is a secret); but
		// for the fixture we capture it via a side-channel by intercepting
		// the client dial below.
		if onRegister != nil {
			onRegister(reg)
		}
	})
	if onRequest != nil {
		dServer.SetOnRequest(onRequest)
	}
	if err := dServer.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dServer.Close() })

	// Reserve credentials exactly as the shim does, then let the Channel claim
	// them over its own long-lived connection.
	c := NewClient(dServer.SocketPath(), DefaultClaimTimeout)
	reserveCtx, reserveCancel := context.WithTimeout(context.Background(), time.Second)
	boot, reserveConn, _, err := c.Bootstrap(reserveCtx, 1234, MCPProtocolVersion)
	reserveCancel()
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	stdinR, stdinW := io.Pipe()
	stdout := &bytes.Buffer{}
	stdoutMu := &sync.Mutex{}
	srv, err := NewChannelStdioServerFromEnv(ChannelStdioOptions{
		Stdin:      stdinR,
		Stdout:     &lockedWriter{mu: stdoutMu, w: stdout},
		Stderr:     io.Discard,
		Client:     c,
		InstanceID: boot.InstanceID,
		Token:      boot.CapabilityToken,
		SocketPath: dServer.SocketPath(),
		ClaudePID:  1234,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = srv.Run(runCtx)
		close(done)
	}()
	// Allow register to land.
	time.Sleep(150 * time.Millisecond)
	return &stdioFixture{
		t: t, srv: srv, stdinW: stdinW,
		stdoutMu: stdoutMu, stdout: stdout,
		cancel: runCancel, done: done,
	}
}

func (f *stdioFixture) writeStdin(p []byte) {
	if _, err := f.stdinW.Write(p); err != nil {
		f.t.Fatalf("write stdin: %v", err)
	}
}

func (f *stdioFixture) stdoutString() string {
	f.stdoutMu.Lock()
	defer f.stdoutMu.Unlock()
	return f.stdout.String()
}

func (f *stdioFixture) close() {
	f.cancel()
	_ = f.stdinW.Close()
	select {
	case <-f.done:
	case <-time.After(500 * time.Millisecond):
	}
}

// lockedWriter serializes writes to the captured stdout buffer.
type lockedWriter struct {
	mu *sync.Mutex
	w  *bytes.Buffer
}

type overlapDetectWriter struct {
	active  atomic.Int32
	overlap atomic.Bool
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *overlapDetectWriter) Write(p []byte) (int, error) {
	if w.active.Add(1) > 1 {
		w.overlap.Store(true)
	}
	w.once.Do(func() { close(w.started) })
	<-w.release
	w.active.Add(-1)
	return len(p), nil
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// TestChannelStdioInitializeAdvertisesOnlyChannel verifies the MCP
// initialize response on stdout advertises only the experimental Channel
// capability and nothing else.
func TestChannelStdioInitializeAdvertisesOnlyChannel(t *testing.T) {
	f := newStdioFixture(t, nil, nil)
	defer f.close()
	initReq, _ := json.Marshal(Request{
		JSONRPC: JSONRPCVersion, ID: json.RawMessage(`"1"`), Method: MethodInitialize,
		Params: json.RawMessage(`{"protocolVersion":"2025-06-18"}`),
	})
	f.writeStdin(append(initReq, '\n'))
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(f.stdoutString(), `"claude/channel"`) {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	snapshot := f.stdoutString()
	outReader := bufio.NewReader(strings.NewReader(snapshot))
	line, err := outReader.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read stdout: %v (buf=%q)", err, snapshot)
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		t.Fatal(err)
	}
	body := string(resp.Result)
	if !strings.Contains(body, `"claude/channel":{}`) {
		t.Fatalf("initialize result missing channel cap: %s", body)
	}
	for _, forbidden := range []string{`"tools"`, `"resources"`, `"prompts"`} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("initialize result advertises forbidden cap %s: %s", forbidden, body)
		}
	}
}

// TestChannelStdioForwardsPermissionRequestToDaemon verifies a Claude
// permission request notification on stdin results in a ChannelRequest to
// the daemon's onRequest callback.
func TestChannelStdioForwardsPermissionRequestToDaemon(t *testing.T) {
	requests := make(chan RequestEvent, 4)
	f := newStdioFixture(t, func(req RequestEvent) { requests <- req }, nil)
	defer f.close()
	notif, _ := json.Marshal(Request{
		JSONRPC: JSONRPCVersion, Method: "notifications/claude/channel/permission_request",
		Params: json.RawMessage(`{"request_id":"abcde","tool_name":"Bash","description":"ls","input_preview":"ls -la"}`),
	})
	f.writeStdin(append(notif, '\n'))
	select {
	case req := <-requests:
		if req.ShortRequestID != "abcde" || req.ToolName != "Bash" {
			t.Fatalf("daemon request lost fields: %+v", req)
		}
		if req.PublicRequestID == "abcde" {
			t.Fatalf("public id must NOT be the 5-letter short id")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("daemon never received the request")
	}
}

func TestChannelStdioReconnectsAfterDaemonRestartForNewRequests(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "cc-reconnect")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socketPath := filepath.Join(dir, "s.sock")
	mcpPath := filepath.Join(dir, "mcp.json")
	registered1 := make(chan struct{}, 1)
	srv1 := NewServer(socketPath, mcpPath, nil)
	srv1.SetOnRegister(func(RegisterEvent) { registered1 <- struct{}{} })
	if err := srv1.Start(); err != nil {
		t.Fatal(err)
	}
	client := NewClient(socketPath, DefaultClaimTimeout)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	boot, reservation, _, err := client.Bootstrap(ctx, os.Getpid(), MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reservation.Close()
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	channel, err := NewChannelStdioServerFromEnv(ChannelStdioOptions{
		Stdin: stdinR, Stdout: io.Discard, Stderr: io.Discard, Client: client,
		InstanceID: boot.InstanceID, Token: boot.CapabilityToken,
		SocketPath: socketPath, ClaudePID: os.Getpid(),
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = channel.Run(ctx); close(done) }()
	select {
	case <-registered1:
	case <-time.After(2 * time.Second):
		t.Fatal("initial Channel registration timed out")
	}
	if err := srv1.Close(); err != nil {
		t.Fatal(err)
	}

	registered2 := make(chan struct{}, 1)
	requests := make(chan RequestEvent, 1)
	srv2 := NewServer(socketPath, mcpPath, nil)
	srv2.SetOnRegister(func(RegisterEvent) { registered2 <- struct{}{} })
	srv2.SetOnRequest(func(req RequestEvent) { requests <- req })
	if err := srv2.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv2.Close()
	select {
	case <-registered2:
	case <-time.After(3 * time.Second):
		t.Fatal("Channel did not re-bootstrap after daemon restart")
	}
	notif, _ := json.Marshal(Request{
		JSONRPC: JSONRPCVersion, Method: MethodChannelPermissionRequest,
		Params: json.RawMessage(`{"request_id":"abcjr","tool_name":"Bash","description":"pwd","input_preview":"pwd"}`),
	})
	if _, err := stdinW.Write(append(notif, '\n')); err != nil {
		t.Fatal(err)
	}
	select {
	case req := <-requests:
		if req.ShortRequestID != "abcjr" {
			t.Fatalf("reconnected request=%+v", req)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("new permission was not relayed after daemon restart")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Channel did not stop after context cancellation")
	}
}

// TestChannelStdioDeliversVerdictOnce verifies the daemon's verdict leads
// to exactly ONE notifications/claude/channel/permission on stdout.
func TestChannelStdioDeliversVerdictOnce(t *testing.T) {
	requests := make(chan RequestEvent, 4)
	f := newStdioFixture(t, func(req RequestEvent) { requests <- req }, nil)
	defer f.close()
	notif, _ := json.Marshal(Request{
		JSONRPC: JSONRPCVersion, Method: MethodChannelPermissionRequest,
		Params: json.RawMessage(`{"request_id":"abcde","tool_name":"Bash","description":"ls","input_preview":"ls"}`),
	})
	f.writeStdin(append(notif, '\n'))
	req := <-requests
	if err := req.Responder.Send(BehaviorAllow); err != nil {
		t.Fatal(err)
	}
	if err := req.Responder.Send(BehaviorAllow); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		out := f.stdoutString()
		if strings.Count(out, BehaviorAllow) >= 1 {
			time.Sleep(150 * time.Millisecond)
			out = f.stdoutString()
			if strings.Count(out, BehaviorAllow) != 1 {
				t.Fatalf("expected exactly 1 allow on stdout, got %d", strings.Count(out, BehaviorAllow))
			}
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("expected exactly 1 verdict on stdout, got %d; buf=%q", strings.Count(f.stdoutString(), BehaviorAllow), f.stdoutString())
}

// TestChannelStdioDoesNotAutoDenyOnIPCError verifies that when SendRequest
// fails (e.g. daemon gone), no verdict is sent to Claude stdout.
func TestChannelStdioDoesNotAutoDenyOnIPCError(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "cc")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	dServer := NewServer(filepath.Join(dir, "s.sock"), filepath.Join(dir, "mcp.json"), nil)
	if err := dServer.Start(); err != nil {
		t.Fatal(err)
	}
	c := NewClient(dServer.SocketPath(), DefaultClaimTimeout)
	reserveCtx, reserveCancel := context.WithTimeout(context.Background(), time.Second)
	boot, reserveConn, _, err := c.Bootstrap(reserveCtx, 1234, MCPProtocolVersion)
	reserveCancel()
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	stdout := &bytes.Buffer{}
	stdoutMu := &sync.Mutex{}
	srv, err := NewChannelStdioServerFromEnv(ChannelStdioOptions{
		Stdin: stdinR, Stdout: &lockedWriter{mu: stdoutMu, w: stdout}, Stderr: io.Discard,
		Client: c, InstanceID: boot.InstanceID, Token: boot.CapabilityToken,
		SocketPath: dServer.SocketPath(), ClaudePID: 1234,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	defer runCancel()
	done := make(chan struct{})
	go func() { _ = srv.Run(runCtx); close(done) }()
	time.Sleep(150 * time.Millisecond)

	_ = dServer.Close()
	time.Sleep(150 * time.Millisecond)

	notif, _ := json.Marshal(Request{
		JSONRPC: JSONRPCVersion, Method: MethodChannelPermissionRequest,
		Params: json.RawMessage(`{"request_id":"abcde","tool_name":"Bash","description":"ls","input_preview":"ls"}`),
	})
	_, _ = stdinW.Write(append(notif, '\n'))
	time.Sleep(250 * time.Millisecond)

	stdoutMu.Lock()
	out := stdout.String()
	stdoutMu.Unlock()
	if strings.Contains(out, BehaviorAllow) || strings.Contains(out, BehaviorDeny) {
		t.Fatalf("stdout must not contain a verdict on IPC failure: %q", out)
	}
	runCancel()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
	}
}

// TestChannelStdioStdoutContainsOnlyJSONRPCFrames verifies no log or
// diagnostic lands on stdout, which would corrupt MCP framing.
func TestChannelStdioStdoutContainsOnlyJSONRPCFrames(t *testing.T) {
	f := newStdioFixture(t, nil, nil)
	defer f.close()
	f.writeStdin([]byte("not json at all\n"))
	time.Sleep(200 * time.Millisecond)
	snapshot := f.stdoutString()
	for _, line := range strings.Split(snapshot, "\n") {
		if line == "" {
			continue
		}
		var probe map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &probe); err != nil {
			t.Fatalf("stdout line is not JSON: %q (err=%v)", line, err)
		}
		if _, ok := probe["jsonrpc"]; !ok {
			t.Fatalf("stdout JSON line missing jsonrpc field: %q", line)
		}
	}
}

// TestChannelStdioTwoConcurrentRequestsIndependent verifies two in-flight
// requests stay independent: each gets its own verdict exactly once.
func TestChannelStdioTwoConcurrentRequestsIndependent(t *testing.T) {
	requests := make(chan RequestEvent, 8)
	f := newStdioFixture(t, func(req RequestEvent) { requests <- req }, nil)
	defer f.close()
	for _, short := range []string{"aaaaa", "bbbbb"} {
		notif, _ := json.Marshal(Request{
			JSONRPC: JSONRPCVersion, Method: MethodChannelPermissionRequest,
			Params: json.RawMessage(`{"request_id":"` + short + `","tool_name":"Bash","description":"ls","input_preview":"ls"}`),
		})
		f.writeStdin(append(notif, '\n'))
	}
	req1 := <-requests
	req2 := <-requests
	if err := req1.Responder.Send(BehaviorAllow); err != nil {
		t.Fatal(err)
	}
	if err := req2.Responder.Send(BehaviorDeny); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		out := f.stdoutString()
		if strings.Count(out, BehaviorAllow) >= 1 && strings.Count(out, BehaviorDeny) >= 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("expected 1 allow + 1 deny on stdout: %q", f.stdoutString())
}

// TestChannelStdioDuplicateShortIDUpserts verifies a duplicate request with
// the same short id is forwarded to the daemon only once.
func TestChannelStdioDuplicateShortIDUpserts(t *testing.T) {
	requests := make(chan RequestEvent, 8)
	f := newStdioFixture(t, func(req RequestEvent) { requests <- req }, nil)
	defer f.close()
	notif, _ := json.Marshal(Request{
		JSONRPC: JSONRPCVersion, Method: MethodChannelPermissionRequest,
		Params: json.RawMessage(`{"request_id":"abcde","tool_name":"Bash","description":"ls","input_preview":"ls"}`),
	})
	f.writeStdin(append(notif, '\n'))
	f.writeStdin(append(notif, '\n'))
	<-requests
	select {
	case duplicate := <-requests:
		t.Fatalf("duplicate request forwarded to daemon: %+v", duplicate)
	case <-time.After(150 * time.Millisecond):
	}
	if f.srv.PendingCount() != 1 {
		t.Fatalf("pending=%d want 1", f.srv.PendingCount())
	}
}

func TestWriteMCPFrameRejectsShortWrite(t *testing.T) {
	err := writeMCPFrame(shortWriter{}, Response{JSONRPC: JSONRPCVersion})
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("error=%v want io.ErrShortWrite", err)
	}
}

func TestChannelStdioSerializesConcurrentStdoutFrames(t *testing.T) {
	w := &overlapDetectWriter{started: make(chan struct{}), release: make(chan struct{})}
	s := &ChannelStdioServer{
		stdout:  w,
		pending: map[string]struct{}{"abcde": {}}, verdictSent: make(map[string]bool),
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		s.handleMCP(Request{JSONRPC: JSONRPCVersion, ID: json.RawMessage(`1`), Method: MethodInitialize}, io.Discard)
	}()
	<-w.started
	go func() {
		defer wg.Done()
		s.deliverVerdictToClaude("abcde", BehaviorAllow)
	}()
	time.Sleep(50 * time.Millisecond)
	close(w.release)
	wg.Wait()
	if w.overlap.Load() {
		t.Fatal("initialize and verdict writes overlapped on MCP stdout")
	}
}
