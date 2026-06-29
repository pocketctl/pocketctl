package ws

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// TestBackoffDelayProgression verifies the reconnect delay grows exponentially
// and stays within the jitter bounds [base/2, base], capped at maxBackoff —
// guarding against the old bug where backoff was effectively a constant 1s.
func TestBackoffDelayProgression(t *testing.T) {
	cases := []struct {
		attempt int
		base    time.Duration
	}{
		{0, 1 * time.Second},
		{1, 2 * time.Second},
		{2, 4 * time.Second},
		{3, 8 * time.Second},
		{4, 16 * time.Second},
		{5, maxBackoff},  // 32s clamps to 30s
		{6, maxBackoff},  // clamps
		{20, maxBackoff}, // no overflow at large attempt
	}
	for _, tc := range cases {
		// Sample several times to exercise jitter.
		for i := 0; i < 50; i++ {
			d := backoffDelay(tc.attempt)
			lo, hi := tc.base/2, tc.base
			if d < lo || d > hi {
				t.Fatalf("attempt %d: delay %v outside [%v,%v]", tc.attempt, d, lo, hi)
			}
		}
	}
}

// newTestClient builds a Client wired to relayURL with shortened liveness
// timeouts so reconnect behavior can be exercised in milliseconds.
func newTestClient(relayURL string) *Client {
	out := make(chan protocol.DaemonEvent)
	c := NewClient(relayURL, "test-token", "daemon-test", []string{"claude-code"}, nil, nil, out, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.pingInterval = 30 * time.Millisecond
	c.pongWait = 150 * time.Millisecond
	c.writeWait = 150 * time.Millisecond
	return c
}

func wsURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}

// TestReconnectsOnSilentServer is the core liveness test: a server that accepts
// the connection and reads forever but NEVER replies (no pong, no FIN/RST)
// simulates a half-open socket. The client must detect the dead link via its
// read deadline and reconnect, rather than blocking indefinitely.
func TestReconnectsOnSilentServer(t *testing.T) {
	var conns int32
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		atomic.AddInt32(&conns, 1)
		// Drain the client's messages but stay mute — never send a pong.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				conn.Close()
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newTestClient(wsURL(srv.URL))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	// pongWait=150ms, so each dead connection is detected in ~150ms. Expect at
	// least 2 connections (initial + at least one reconnect) within the window.
	waitForConns(t, &conns, 2, 3*time.Second)
}

// TestReconnectsOnServerClose verifies the clean-disconnect path still works:
// a server that closes immediately after upgrade triggers a prompt reconnect.
func TestReconnectsOnServerClose(t *testing.T) {
	var conns int32
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		atomic.AddInt32(&conns, 1)
		conn.Close() // immediate close → client ReadMessage errors → reconnect
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newTestClient(wsURL(srv.URL))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	waitForConns(t, &conns, 2, 3*time.Second)
}

func waitForConns(t *testing.T, conns *int32, want int32, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(conns) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected >= %d connections within %v, got %d", want, timeout, atomic.LoadInt32(conns))
}
