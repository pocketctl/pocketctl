//go:build windows

package daemon

import (
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/pocketctl/pocketctl/internal/platform"
)

// StartControlChannel 开 named pipe 控制通道,goroutine 监听 "stop" 命令。
// 收到 stop 调 onStop(触发优雅退出)。Windows-only;Unix 用 SIGTERM(signal.Notify)。
// 失败非致命:daemon 仍跑,只是 Windows 上不能被控制通道优雅停止(可强 kill 兜底)。
func StartControlChannel(onStop func()) error {
	name := platform.ControlPipeName(os.Getpid())
	ln, err := winio.ListenPipe(name, nil)
	if err != nil {
		return fmt.Errorf("listen control pipe: %w", err)
	}
	go func() {
		defer ln.Close()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed
			}
			go handleControlConn(conn, onStop)
		}
	}()
	return nil
}

func handleControlConn(conn net.Conn, onStop func()) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 16)
	n, err := conn.Read(buf)
	if err != nil {
		return
	}
	if strings.TrimSpace(string(buf[:n])) == "stop" {
		_, _ = conn.Write([]byte("ok\n"))
		onStop()
	}
}
