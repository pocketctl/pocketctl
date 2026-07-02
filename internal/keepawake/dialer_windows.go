//go:build windows

package keepawake

import (
	"net"

	"github.com/Microsoft/go-winio"
)

// Windows:本地控制 socket 走 named pipe（与 approval/控制通道一致）。
// path 由 config.ControlSocketPath() 返回 ~\.pocketctl\control.sock 形式的
// 路径,但 Windows named pipe 通常用 \\.\pipe\ 前缀。为保持 daemon/server
// 端与 CLI 端路径一致,server 端 platform.NewIPCListener().DefaultPath 已处理
// pipe 命名转换;此处直接用传入的 path 拨号。
//
// 注意:若 path 不是有效 pipe 名,winio.DialPipe 会返回错误,与 Unix 上
// "socket 文件不存在"语义一致。
func init() {
	dialControlFn = func(path string) (net.Conn, error) {
		return winio.DialPipe(path, nil)
	}
}
