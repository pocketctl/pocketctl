package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestAdoptionRequiresFirstRegistrationAckOnCurrentConnection(t *testing.T) {
	for _, tc := range []struct {
		name       string
		negotiated bool
	}{{"legacy", false}, {"negotiated", true}} {
		t.Run(tc.name, func(t *testing.T) {
			stop := make(chan struct{})
			upgrader := websocket.Upgrader{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				_, _, _ = conn.ReadMessage()
				cmd := map[string]string{"type": "session_adopt_status"}
				_ = conn.WriteJSON(cmd)
				ack := protocol.RegisterAckMessage{Type: "register_ack", Status: "ok"}
				if tc.negotiated {
					ack.Capabilities = []string{protocol.CodexSessionAdoptionCapability}
				}
				_ = conn.WriteJSON(ack)
				ack.Capabilities = []string{protocol.CodexSessionAdoptionCapability}
				_ = conn.WriteJSON(ack)
				_ = conn.WriteJSON(cmd)
				_ = conn.WriteJSON(map[string]string{"type": "barrier"})
				<-stop
			}))
			defer srv.Close()
			defer close(stop)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c := newTestClient(wsURL(srv.URL))
			go c.Run(ctx)
			n := 0
			for {
				select {
				case <-ctx.Done():
					t.Fatal("did not receive command barrier")
				case cmd := <-c.CommandCh:
					switch cmd.Type {
					case "session_adopt_status":
						n++
						if cmd.ReplyAdoption == nil {
							t.Fatal("missing origin-bound reply")
						}
					case "barrier":
						if (tc.negotiated && n != 1) || (!tc.negotiated && n != 0) {
							t.Fatalf("dispatched %d adoption commands", n)
						}
						return
					}
				}
			}
		})
	}
}
