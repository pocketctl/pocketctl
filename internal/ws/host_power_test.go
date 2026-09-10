package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestHostSleepBlocksDialUntilFullWake(t *testing.T) {
	var awake atomic.Bool
	connected := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		connected <- struct{}{}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	c := newTestClient("ws" + strings.TrimPrefix(server.URL, "http"))
	c.HostAwake = func() (bool, error) { return awake.Load(), nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); _ = c.Run(ctx) }()
	select {
	case <-connected:
		t.Fatal("dialed during sleep/dark wake")
	case <-time.After(100 * time.Millisecond):
	}
	awake.Store(true)
	select {
	case <-connected:
	case <-time.After(3 * time.Second):
		t.Fatal("did not resume after full wake")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown blocked")
	}
}

func TestSleepingHeartbeatDoesNotCollectMetrics(t *testing.T) {
	c := newTestClient("ws://example")
	c.HostAwake = func() (bool, error) { return false, nil }
	c.metricsFn = func() (float64, float64, float64) {
		t.Fatal("collected heartbeat metrics during dark wake")
		return 0, 0, 0
	}
	c.sendHeartbeat()
}

func TestSleepSuppressesWritesAndReplaysBufferedEventAfterWake(t *testing.T) {
	var awake atomic.Bool
	var connections atomic.Int32
	events := make(chan int64, 4)
	closed := make(chan struct{}, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connections.Add(1)
		defer func() { conn.Close(); closed <- struct{}{} }()
		for {
			var msg map[string]any
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			switch msg["type"] {
			case "register":
				_ = conn.WriteJSON(map[string]any{"type": "register_ack", "supports_event_ack": true})
			case "ping":
				_ = conn.WriteJSON(map[string]any{"type": "pong"})
			default:
				if seq, ok := msg["seq"].(float64); ok {
					events <- int64(seq)
					_ = conn.WriteJSON(map[string]any{"type": "event_ack", "seq": seq})
				}
			}
		}
	}))
	defer server.Close()
	c := newTestClient(wsURL(server.URL))
	c.HostAwake = func() (bool, error) { return awake.Load(), nil }
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	c.conn = conn
	c.ackKnown, c.ackSupported = true, true
	c.sendEvent(protocol.DaemonEvent{Type: "agent_text", SessionID: "sleep-session"})
	if err := c.SendControlPayload([]byte(`{"type":"ping"}`)); err == nil {
		t.Fatal("control write accepted while asleep")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("sleep did not close transport")
	}
	select {
	case <-events:
		t.Fatal("event sent during sleep")
	default:
	}
	if len(c.outBuf) != 1 {
		t.Fatalf("buffered events=%d", len(c.outBuf))
	}
	awake.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); _ = c.Run(ctx) }()
	select {
	case seq := <-events:
		if seq != 1 {
			t.Fatalf("replayed seq=%d", seq)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("event not replayed after wake")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown blocked")
	}
}

func TestSleepingHostDoesNotReplyToProtocolPing(t *testing.T) {
	sendPing := make(chan struct{})
	pong := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetPongHandler(func(string) error { pong <- struct{}{}; return nil })
		<-sendPing
		_ = conn.WriteControl(websocket.PingMessage, []byte("probe"), time.Now().Add(time.Second))
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	c := newTestClient(wsURL(server.URL))
	c.HostAwake = func() (bool, error) { return false, nil }
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	c.conn = conn
	done := make(chan struct{})
	readErr := make(chan error, 1)
	go c.readPump(context.Background(), done, readErr)
	close(sendPing)
	select {
	case <-pong:
		t.Fatal("sent protocol pong during DarkWake")
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("read pump did not stop")
	}
	select {
	case <-pong:
		t.Fatal("sent protocol pong during DarkWake")
	default:
	}
}
