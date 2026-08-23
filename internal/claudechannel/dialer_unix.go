//go:build !windows

package claudechannel

import (
	"context"
	"net"
	"os"
	"path/filepath"
)

// Listen creates the Claude Channel IPC listener on a Unix domain socket.
// The parent directory is set 0700 and the socket file 0600 (enforced by
// the OS umask plus an explicit Chmod after listen). Design §Task 5:
// "父目录 0700,Unix socket 0600".
func Listen(path string) (net.Listener, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			return nil, err
		}
	}
	// Remove any stale socket file before listen.
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, err
	}
	return ln, nil
}

// Dial connects to the Claude Channel IPC socket. The caller MUST enforce
// the bootstrap deadline via context.
func Dial(path string) (net.Conn, error) {
	return DialContext(context.Background(), path)
}

func DialContext(ctx context.Context, path string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}
