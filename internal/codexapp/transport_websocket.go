package codexapp

import (
	"context"
	"net/http"

	"github.com/gorilla/websocket"
)

// DialWebSocket connects to a local app-server WebSocket endpoint. Callers own
// endpoint authentication policy; Pocketctl's Windows runtime binds only a
// random loopback port and never exposes this endpoint through relay.
func DialWebSocket(ctx context.Context, endpoint string, headers http.Header) (*Client, error) {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint, headers)
	if err != nil {
		return nil, err
	}
	return NewClient(conn), nil
}
