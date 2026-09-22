package sessionmcp

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"time"

	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
)

type IPCServer struct {
	SocketPath string
	Reader     RelayReader
	Timeout    time.Duration
	Logger     *slog.Logger
}

func (s *IPCServer) Start() (net.Listener, error) {
	return platform.NewIPCListener().Listen(s.SocketPath)
}

func (s *IPCServer) Serve(ctx context.Context, listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
			}
			if s.Logger != nil {
				s.Logger.Warn("session-mcp accept error", "error", err)
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		daemon.Go("session-mcp-conn", s.Logger, func() { s.serveOne(ctx, conn) })
	}
}

func (s *IPCServer) serveOne(parent context.Context, conn net.Conn) {
	defer conn.Close()
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	_ = conn.SetDeadline(time.Now().Add(timeout + time.Second))
	line, err := readLine(conn, maxIPCFrameBytes)
	if err != nil {
		return
	}
	var request IpcReadRequest
	if json.Unmarshal(line, &request) != nil || request.Type != "session_history_read_request" ||
		request.SourceSessionID == "" || request.TargetSessionID == "" {
		writeIPC(conn, IpcReadResponse{Error: "invalid_request"})
		return
	}
	result, err := s.Reader.Read(ctx, request)
	if err != nil {
		writeIPC(conn, IpcReadResponse{Error: boundedCode(err.Error())})
		return
	}
	writeIPC(conn, IpcReadResponse{Result: &result})
}

func writeIPC(conn net.Conn, response IpcReadResponse) {
	encoded, err := json.Marshal(response)
	if err == nil && len(encoded) <= maxIPCFrameBytes {
		_, _ = conn.Write(append(encoded, '\n'))
	}
}
