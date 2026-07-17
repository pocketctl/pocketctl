//go:build !windows

package agentcontrol

import (
	"context"
	"net"
)

func dialAgentControl(ctx context.Context, path string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}
