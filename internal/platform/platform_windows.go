//go:build windows

package platform

import (
	"net"
	"os/exec"
)

// NewPTYProvider 返回 Windows PTY provider（PR1 stub）。
// ConPTY 真实实现见 PR4；PR1 全部返回 ErrUnsupported，调用方降级处理。
func NewPTYProvider() PTYProvider { return windowsPTYProvider{} }

type windowsPTYProvider struct{}

func (windowsPTYProvider) Start(*exec.Cmd, *Size) (PTY, error) {
	return nil, ErrUnsupported
}

// NewIPCListener 返回 Windows named pipe IPC listener（PR1 stub）。
// PR4 用 github.com/Microsoft/go-winio 实现 named pipe。
func NewIPCListener() IPCListener { return windowsIPCListener{} }

type windowsIPCListener struct{}

func (windowsIPCListener) Listen(string) (net.Listener, error) {
	return nil, ErrUnsupported
}

func (windowsIPCListener) DefaultPath(name string) string {
	return `\\.\pipe\pocketctl-` + name
}
