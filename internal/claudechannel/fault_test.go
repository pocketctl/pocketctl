package claudechannel

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestFaultBootstrapDialTimeoutRespected verifies the client's dial timeout
// is respected when the daemon socket does not exist. The full read-deadline
// enforcement is covered by the launcher's 200ms budget at the shim layer
// (Task 3); here we only pin the dial path. Design §Task 11.
func TestFaultBootstrapDialTimeoutRespected(t *testing.T) {
	c := NewClient("/tmp/nonexistent-cc-fault.sock", 100*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, _, err := c.Bootstrap(ctx, 1111, MCPProtocolVersion)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("Bootstrap against missing daemon must error")
	}
	if elapsed > 400*time.Millisecond {
		t.Fatalf("dial did not respect deadline: elapsed=%v", elapsed)
	}
}

// TestFaultServerOversizedFrameDropped verifies a Channel sending an
// oversized request frame does not crash the server; the frame is rejected
// by the encoder before going on the wire. Design §Task 11.
func TestFaultServerOversizedFrameDropped(t *testing.T) {
	srv := newTestServer(t)
	fc := dialAndRegister(t, srv, 1111)
	defer fc.close()
	huge := strings.Repeat("x", MaxJSONRPCFrame+10)
	err := fc.sendRequest("ABCDE", "Bash", huge, huge)
	if err == nil {
		t.Fatal("oversized send must error at the encoder")
	}
}

// TestFaultMalformedJSONDoesNotCrashServer verifies a malformed frame on one
// connection does not crash the server or prevent new connections from
// bootstrapping and registering. The malformed connection itself is torn down
// (acceptable defensive behavior). Design §Task 11.
func TestFaultMalformedJSONDoesNotCrashServer(t *testing.T) {
	srv := newTestServer(t)
	fc1 := dialAndRegister(t, srv, 1111)
	// Send a malformed frame on fc1; the server may tear the connection down.
	_, _ = fc1.conn.Write([]byte("not-json-at-all\n"))
	fc1.close()
	// A NEW connection must still be able to bootstrap and register — the
	// server process did not crash.
	fc2 := dialAndRegister(t, srv, 2222)
	defer fc2.close()
	// InstanceCount of 1 confirms the new instance registered successfully
	// (fc1's instance was torn down with its connection).
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if srv.InstanceCount() >= 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("server stopped accepting new registrations after malformed frame: count=%d", srv.InstanceCount())
}

// Note: at-most-once verdict delivery is covered by TestServerRequestFlowEndToEnd
// and TestServerVerdictAtMostOnceOnDisconnect in server_test.go. We do not
// duplicate it here; the Responder's sync.Once guard is the wire-level
// contract those tests pin.
