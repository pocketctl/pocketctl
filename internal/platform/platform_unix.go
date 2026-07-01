//go:build !windows

package platform

import (
	"fmt"
	"os"
	"os/exec"

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
