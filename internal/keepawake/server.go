package keepawake

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

// readTimeout 是单个请求读等待上限。CLI 端拨号后立即写，无需长等待。
const readTimeout = 5 * time.Second

// Server 在本地 socket 上监听 keep-awake 控制命令。
// 协议为 newline-JSON：每连接一行请求 → 一行响应（对齐 internal/approval 模式）。
type Server struct {
	socketPath string
	ipc        platform.IPCListener
	ln         net.Listener
	mgr        *Manager
	logger     *slog.Logger

	wg     sync.WaitGroup
	closed atomic.Bool
}

// NewServer 构造监听指定路径的 keep-awake 控制服务。mgr 不可为 nil。
func NewServer(socketPath string, mgr *Manager, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		socketPath: socketPath,
		ipc:        platform.NewIPCListener(),
		mgr:        mgr,
		logger:     logger,
	}
}

// ListenPath 返回实际监听路径（Listen 后非空），便于日志。
func (s *Server) ListenPath() string { return s.socketPath }

// Start 打开监听并启动 accept 循环。重复调用是 no-op。
func (s *Server) Start() error {
	ln, err := s.ipc.Listen(s.socketPath)
	if err != nil {
		return fmt.Errorf("listen keep-awake control socket: %w", err)
	}
	s.ln = ln
	s.wg.Add(1)
	go s.acceptLoop()
	return nil
}

// Close 停止监听并等待在途连接处理完成。幂等。
func (s *Server) Close() error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil // 已关闭
	}
	if s.ln != nil {
		_ = s.ln.Close() // 让 Accept 立即返回错误
	}
	s.wg.Wait() // 等待 acceptLoop + 在途 handler 退出
	return nil
}

// Serve 在 ctx 存活期间阻塞运行 Server；ctx 取消时关闭 Server 并返回。
// 便于 daemon 用 daemon.RunLoop 包装：失活即收尾。
func (s *Server) Serve(ctx context.Context) {
	<-ctx.Done()
	_ = s.Close()
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			// listener 关闭（Close 置 closed=true）属正常退出，无需告警。
			if s.closed.Load() {
				return
			}
			s.logger.Warn("keep-awake: accept error", "error", err)
			return
		}
		s.wg.Add(1)
		go func(c net.Conn) {
			defer s.wg.Done()
			defer c.Close()
			s.handleConn(c)
		}(conn)
	}
}

// handleConn 处理单连接：读一行 JSON 请求，写一行 JSON 响应。
func (s *Server) handleConn(conn net.Conn) {
	_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
	br := bufio.NewReader(conn)
	line, err := br.ReadBytes('\n')
	if err != nil {
		return // 客户端断开/超时：静默
	}
	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		s.writeResponse(conn, Response{OK: false, Error: "invalid request: " + err.Error()})
		return
	}
	if req.Cmd != "keep-awake" {
		s.writeResponse(conn, Response{OK: false, Error: "unknown cmd: " + req.Cmd})
		return
	}
	resp := s.dispatch(req.Action)
	s.writeResponse(conn, resp)
}

// dispatch 把 action 映射到 Manager 操作并组装响应。
func (s *Server) dispatch(action string) Response {
	switch action {
	case "on":
		onBattery, err := s.mgr.Enable()
		if err != nil {
			if IsUnsupported(err) {
				return Response{OK: false, Error: "sleep prevention not supported on this platform"}
			}
			return Response{OK: false, Error: err.Error()}
		}
		resp := Response{OK: true, Enabled: true}
		if onBattery {
			resp.OnBattery = true
			resp.Msg = "keep-awake enabled (on battery: will auto-disable shortly to protect charge)"
		} else {
			resp.Msg = "keep-awake enabled"
		}
		return resp
	case "off":
		_ = s.mgr.Disable(ReasonManual)
		active, reason := s.mgr.Status()
		return Response{OK: true, Enabled: active, Reason: reason, Msg: "keep-awake disabled"}
	case "status":
		active, reason := s.mgr.Status()
		resp := Response{OK: true, Enabled: active, Reason: reason}
		if active {
			resp.Msg = "keep-awake is ON"
		} else {
			resp.Msg = "keep-awake is OFF"
		}
		return resp
	default:
		return Response{OK: false, Error: "unknown action: " + action + " (expected on|off|status)"}
	}
}

func (s *Server) writeResponse(conn net.Conn, resp Response) {
	_ = conn.SetWriteDeadline(time.Now().Add(readTimeout))
	b, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_, _ = conn.Write(append(b, '\n'))
}
