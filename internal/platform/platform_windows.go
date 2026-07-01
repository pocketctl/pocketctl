//go:build windows

package platform

import (
	"os/exec"
)

// NewPTYProvider 返回 Windows PTY provider（PR1 stub）。
// ConPTY 真实实现见 PR4；PR1 全部返回 ErrUnsupported，调用方降级处理。
func NewPTYProvider() PTYProvider { return windowsPTYProvider{} }

type windowsPTYProvider struct{}

func (windowsPTYProvider) Start(*exec.Cmd, *Size) (PTY, error) {
	return nil, ErrUnsupported
}
