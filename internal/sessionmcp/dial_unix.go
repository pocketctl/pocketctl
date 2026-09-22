//go:build !windows

package sessionmcp

import (
	"context"
	"net"
)

func dialIPC(ctx context.Context, path string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}
