//go:build !windows

package codexapp

import (
	"context"
	"net"
	"net/http"

	"github.com/gorilla/websocket"
)

func DialUnix(ctx context.Context, socketPath string) (*Client, error) {
	netDialer := &net.Dialer{}
	dialer := websocket.Dialer{
		NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return netDialer.DialContext(ctx, "unix", socketPath)
		},
	}
	conn, _, err := dialer.DialContext(ctx, "ws://localhost/rpc", http.Header{})
	if err != nil {
		return nil, err
	}
	return NewClient(conn), nil
}
