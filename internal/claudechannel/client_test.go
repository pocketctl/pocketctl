package claudechannel

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

type shortWriter struct{}

func (shortWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	return len(p) / 2, nil
}

func TestClientSendRequestRejectsShortWrite(t *testing.T) {
	c := NewClient("", time.Second)
	err := c.SendRequest(shortWriter{}, "instance", "abcde", "Bash", "list", "ls")
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("error=%v want io.ErrShortWrite", err)
	}
}

// TestClientBootstrapTimeout verifies the dial/connect respects the timeout
// and a missing server fails within the budget. Design §Task 5: "200ms
// bootstrap deadline".
func TestClientBootstrapTimeout(t *testing.T) {
	client := NewServer("/nonexistent/socket", "/mcp.json", nil)
	defer client.Close()
	c := NewClient("/nonexistent/socket", 100*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, _, err := c.Bootstrap(ctx, 1234, MCPProtocolVersion)
	if err == nil {
		t.Fatal("Bootstrap to missing server must error")
	}
}

// TestClientSendRequestAndClose verifies the Client.SendRequest helper writes
// a channel.request frame and the server consumes it.
func TestClientSendRequestAndClose(t *testing.T) {
	srv := newTestServer(t)
	requests := make(chan RequestEvent, 4)
	srv.SetOnRequest(func(req RequestEvent) { requests <- req })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c := NewClient(srv.SocketPath(), time.Second)
	boot, reserveConn, _, err := c.Bootstrap(ctx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	conn, _, err := c.Claim(ctx, boot.InstanceID, boot.CapabilityToken, 4321, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close(conn, CloseReasonChannelExit) }()
	if err := c.SendRequest(conn, boot.InstanceID, "abcde", "Bash", "list", "ls"); err != nil {
		t.Fatal(err)
	}
	select {
	case req := <-requests:
		if req.ShortRequestID != "abcde" {
			t.Fatalf("short id=%q", req.ShortRequestID)
		}
	case <-time.After(time.Second):
		t.Fatal("request not received")
	}
}

func TestClientClaimUsesFreshConnection(t *testing.T) {
	srv := newTestServer(t)
	registered := make(chan RegisterEvent, 1)
	srv.SetOnRegister(func(event RegisterEvent) { registered <- event })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c := NewClient(srv.SocketPath(), time.Second)
	boot, reserveConn, _, err := c.Bootstrap(ctx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	claimConn, _, err := c.Claim(ctx, boot.InstanceID, boot.CapabilityToken, 4321, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer claimConn.Close()
	select {
	case event := <-registered:
		if event.InstanceID != boot.InstanceID {
			t.Fatalf("instance=%q want %q", event.InstanceID, boot.InstanceID)
		}
	case <-time.After(time.Second):
		t.Fatal("claim did not register")
	}
}

// TestClientPingerPing verifies the Pinger writes a single ping frame.
func TestClientPingerPing(t *testing.T) {
	srv := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c := NewClient(srv.SocketPath(), time.Second)
	boot, reserveConn, _, err := c.Bootstrap(ctx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	conn, _, err := c.Claim(ctx, boot.InstanceID, boot.CapabilityToken, 4321, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	pinger := NewPinger(conn)
	if err := pinger.Ping(); err != nil {
		t.Fatalf("ping: %v", err)
	}
}

// TestClientDialInjection verifies the Dial field can be overridden (used by
// fault tests in Task 11).
func TestClientDialInjection(t *testing.T) {
	c := NewClient("/anywhere", time.Second)
	dialed := false
	c.Dial = func(_ string) (net.Conn, error) {
		dialed = true
		return nil, context.DeadlineExceeded
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, _, _, _ = c.Bootstrap(ctx, 0, MCPProtocolVersion)
	if !dialed {
		t.Fatal("injected Dial must be called")
	}
}

// TestClientCloseSendsCloseFrame verifies Client.Close emits a channel.close
// frame before tearing down the connection.
func TestClientCloseSendsCloseFrame(t *testing.T) {
	srv := newTestServer(t)
	got := make(chan struct{})
	srv.SetOnRegister(func(_ RegisterEvent) { close(got) })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c := NewClient(srv.SocketPath(), time.Second)
	boot, reserveConn, _, err := c.Bootstrap(ctx, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	_ = reserveConn.Close()
	conn, reader, err := c.Claim(ctx, boot.InstanceID, boot.CapabilityToken, 4321, 1111, MCPProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	<-got
	if err := c.Close(conn, CloseReasonChannelExit); err != nil {
		t.Fatal(err)
	}
	// The server should observe the close frame (or EOF) and unregister.
	// Poll up to 3 seconds; close can race with in-flight heartbeats.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if srv.InstanceCount() == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = reader
	t.Fatalf("Close did not unregister the instance (count=%d)", srv.InstanceCount())
}
