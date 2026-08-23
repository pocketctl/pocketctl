//go:build windows

package claudechannel

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

// Listen creates the Claude Channel IPC listener on a Windows named pipe
// with a user-level security descriptor (Design §Task 5: "Windows 使用
// 用户级 named pipe ACL").
func Listen(path string) (net.Listener, error) {
	config := winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;CO)(A;;GA;;;BA)(A;;GA;;;SY)", // current user, admins, system
		InputBufferSize:    64 << 10,
		OutputBufferSize:   64 << 10,
	}
	return winio.ListenPipe(path, &config)
}

// Dial connects to the Claude Channel IPC named pipe.
func Dial(path string) (net.Conn, error) {
	return DialContext(context.Background(), path)
}

func DialContext(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, path)
}
