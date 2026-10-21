package ws

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Disconnect only after an event has left outputCh and is waiting for durable
// buffer space. Reconnection must retain that event and any derived tail.
func TestReconnectRetainsDequeuedEvents(t *testing.T) {
	for _, tc := range []struct {
		name              string
		derived, buffered bool
	}{
		{name: "direct_before_admission"},
		{name: "derived_before_admission", derived: true},
		{name: "direct_after_admission", buffered: true},
		{name: "derived_after_admission", derived: true, buffered: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var connections, callbacks int32
			drop := make(chan struct{})
			var dropOnce sync.Once
			disconnect := func() { dropOnce.Do(func() { close(drop) }) }
			received := make(chan protocol.DaemonEvent, 16)
			upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				connection := atomic.AddInt32(&connections, 1)
				for {
					_, raw, err := conn.ReadMessage()
					if err != nil {
						return
					}
					var event protocol.DaemonEvent
					if json.Unmarshal(raw, &event) != nil {
						continue
					}
					switch event.Type {
					case "register":
						_ = conn.WriteJSON(protocol.RegisterAckMessage{
							Type: "register_ack", SupportsEventAck: true,
							Capabilities: []string{"flow_control"}, EventWindow: 1,
						})
					case "agent_text":
						if connection == 1 {
							<-drop
							return // keep the first event unacked
						}
						received <- event
						_ = conn.WriteJSON(protocol.EventAckMessage{Type: "event_ack", UpToSeq: event.Seq})
					}
				}
			}))
			out := make(chan protocol.DaemonEvent, 3)
			client := NewClient(wsURL(server.URL), "token", "pending-replay", nil, nil, nil, out,
				slog.New(slog.NewTextHandler(io.Discard, nil)))
			client.maxOutCount = 1
			if tc.buffered {
				client.maxOutCount = 8 // stop during transmission, after durable append
			}
			client.pongWait = 5 * time.Second
			client.reconnectJitter = func(time.Duration) time.Duration { return 0 }
			events := []protocol.DaemonEvent{
				{Type: "agent_text", EventID: "first", SessionID: "s", Text: "first"},
				{Type: "agent_text", EventID: "second", SessionID: "s", Text: "second"},
				{Type: "agent_text", EventID: "third", SessionID: "s", Text: "third"},
			}
			if tc.derived {
				client.OnEvent = func(protocol.DaemonEvent) []protocol.DaemonEvent {
					atomic.AddInt32(&callbacks, 1)
					return events
				}
				out <- protocol.DaemonEvent{Type: "agent_text", Text: "derive once"}
			} else {
				for _, event := range events {
					out <- event
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			runDone := make(chan struct{})
			go func() { defer close(runDone); client.Run(ctx) }()
			t.Cleanup(func() {
				cancel()
				disconnect()
				<-runDone
				server.Close()
			})
			waitForOutboundWaiters(t, client, 1)
			disconnect()
			for index, want := range events {
				select {
				case got := <-received:
					if got.EventID != want.EventID || got.Seq != int64(index+1) {
						t.Fatalf("record %d: got %s seq=%d, want %s seq=%d", index, got.EventID, got.Seq, want.EventID, index+1)
					}
				case <-time.After(3 * time.Second):
					t.Fatalf("missing dequeued record %s after reconnect", want.EventID)
				}
			}
			if tc.derived && atomic.LoadInt32(&callbacks) != 1 {
				t.Fatal("OnEvent ran again while retrying derived events")
			}
		})
	}
}
