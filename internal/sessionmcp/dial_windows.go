//go:build windows

package sessionmcp

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

func dialIPC(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, path)
}
