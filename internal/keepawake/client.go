package keepawake

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"time"
)

// dialTimeout 是 CLI 拨号等待 daemon 的上限。
const dialTimeout = 5 * time.Second

// Ask 连接 daemon 的本地控制 socket，发送一个 Request，读取一个 Response。
// 供 CLI 子命令调用；daemon 未运行时 socket 不存在，返回可识别的错误。
func Ask(socketPath string, req Request) (Response, error) {
	conn, err := dialControlFn(socketPath)
	if err != nil {
		return Response{}, fmt.Errorf("connect daemon (is it running?): %w", err)
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(dialTimeout))
	b, err := json.Marshal(req)
	if err != nil {
		return Response{}, err
	}
	if _, err := conn.Write(append(b, '\n')); err != nil {
		return Response{}, fmt.Errorf("send request: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(dialTimeout))
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return Response{}, fmt.Errorf("read response: %w", err)
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return Response{}, fmt.Errorf("parse response: %w", err)
	}
	return resp, nil
}

// dialControlFn 由 dialer_unix.go / dialer_windows.go 在 init() 中按平台注入：
// Unix 用 net.Dial("unix", path)；Windows 用 winio.DialPipe(path)。
// 返回的 net.Conn 同时满足读、写、关闭与超时设置。
var dialControlFn func(path string) (net.Conn, error)

