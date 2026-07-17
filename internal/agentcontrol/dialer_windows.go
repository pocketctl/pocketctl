//go:build windows

package agentcontrol

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

func dialAgentControl(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, path)
}
