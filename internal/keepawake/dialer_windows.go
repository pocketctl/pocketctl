//go:build windows

package keepawake

import (
	"net"

	"github.com/Microsoft/go-winio"
)

// Windows:本地控制 socket 走 named pipe。config.ControlSocketPath() 在 Windows
// 返回 \\.\pipe\pocketctl-control，server 端 (keepawake.NewServer) 与 CLI 端
// (keepawake.Ask) 用的是同一个 pipe 名，直接拨号即可。
//
// 注意:若 path 不是有效 pipe 名,winio.DialPipe 会返回错误,与 Unix 上
// "socket 文件不存在"语义一致。
func init() {
	dialControlFn = func(path string) (net.Conn, error) {
		return winio.DialPipe(path, nil)
	}
}
