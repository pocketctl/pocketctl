package codexapp

import (
	"context"
	"net/http"

	"github.com/gorilla/websocket"
)

type websocketTransport struct{ *websocket.Conn }

func (t websocketTransport) readMessage() ([]byte, error) {
	for {
		kind, data, err := t.ReadMessage()
		if err != nil || kind == websocket.TextMessage {
			return data, err
		}
	}
}

func (t websocketTransport) writeMessage(_ context.Context, data []byte) error {
	return t.WriteMessage(websocket.TextMessage, data)
}

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
