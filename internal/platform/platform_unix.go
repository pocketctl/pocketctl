//go:build !windows

package platform

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/creack/pty"
)

// NewPTYProvider 返回 Unix PTY provider（基于 creack/pty）。
func NewPTYProvider() PTYProvider { return unixPTYProvider{} }

type unixPTYProvider struct{}

func (unixPTYProvider) Start(cmd *exec.Cmd, size *Size) (PTY, error) {
	ws := &pty.Winsize{Rows: 24, Cols: 80}
	if size != nil {
		ws.Rows = size.Rows
		ws.Cols = size.Cols
	}
	ptmx, err := pty.StartWithSize(cmd, ws)
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}
	return &unixPTY{ptmx: ptmx}, nil
}

type unixPTY struct{ ptmx *os.File }

func (p *unixPTY) Read(b []byte) (int, error)  { return p.ptmx.Read(b) }
func (p *unixPTY) Write(b []byte) (int, error) { return p.ptmx.Write(b) }
func (p *unixPTY) Close() error                { return p.ptmx.Close() }
func (p *unixPTY) SetSize(rows, cols uint16) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}

// NewIPCListener 返回 Unix domain socket IPC listener。
func NewIPCListener() IPCListener { return unixIPCListener{} }

type unixIPCListener struct{}

func (unixIPCListener) Listen(name string) (net.Listener, error) {
	// 清理上次 daemon 残留的 socket 文件。
	if err := os.Remove(name); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("remove stale ipc socket: %w", err)
	}
	ln, err := net.Listen("unix", name)
	if err != nil {
		return nil, fmt.Errorf("listen ipc socket: %w", err)
	}
	// 仅属主可读写——审批请求本身不含机密，但 socket 不应全局可写。
	_ = os.Chmod(name, 0o600)
	return ln, nil
}

func (unixIPCListener) DefaultPath(name string) string {
	return filepath.Join(os.TempDir(), "pocketctl", name+".sock")
}
