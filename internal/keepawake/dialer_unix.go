//go:build !windows

package keepawake

import "net"

// Unix：本地控制 socket 走 Unix domain socket。
// 注意：不能直接复用 approval/hook.go 的 net.Dial("unix", ...)——那是 hardcode
// 在 approval 包内的；本特性在 keepawake 包内独立注入，便于 Windows 走 named pipe。
func init() {
	dialControlFn = func(path string) (net.Conn, error) {
		return net.Dial("unix", path)
	}
}
