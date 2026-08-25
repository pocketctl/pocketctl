package memorymcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/ws"
)

// RelayGrantRequester obtains a grant by sending memory_mcp_grant over the
// daemon's authenticated Relay WebSocket and awaiting the correlated reply.
type RelayGrantRequester func(ctx context.Context) (Grant, error)

// Server listens on the user-private memory-mcp socket and answers bridge
// processes with refreshed grants.
type Server struct {
	SocketPath string
	Request    RelayGrantRequester
	Timeout    time.Duration
	Logger     *slog.Logger
}

// Start binds the socket (user-private via platform.IPCListener).
func (s *Server) Start() (net.Listener, error) {
	return platform.NewIPCListener().Listen(s.SocketPath)
}

// Serve accepts connections until the context ends. One bounded request per
// connection; slow or malformed peers cannot wedge the listener.
func (s *Server) Serve(ctx context.Context, ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
			}
			if s.Logger != nil {
				s.Logger.Warn("memory-mcp accept error", "error", err)
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		daemon.Go("memory-mcp-conn", s.Logger, func() { s.serveOne(ctx, conn) })
	}
}

func (s *Server) serveOne(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_ = conn.SetDeadline(time.Now().Add(timeout + time.Second))

	line, err := readIPCLine(conn)
	if err != nil || len(line) == 0 {
		return
	}
	var request IpcGrantRequest
	if err := json.Unmarshal(line, &request); err != nil || request.Type != "memory_mcp_grant_request" {
		writeJSON(conn, IpcGrantResponse{Error: "invalid_request"})
		return
	}
	grant, err := s.Request(ctx)
	if err != nil {
		// Bounded machine code only — never the underlying error text.
		writeJSON(conn, IpcGrantResponse{Error: boundedCode(err)})
		return
	}
	writeJSON(conn, IpcGrantResponse{
		Grant:                grant.Token,
		ExpiresAt:            grant.ExpiresAt,
		ProviderPublicOrigin: grant.Origin,
		InstallationID:       grant.InstallID,
	})
}

func writeJSON(conn net.Conn, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = conn.Write(append(data, '\n'))
}

func boundedCode(err error) string {
	if err == nil {
		return "internal_error"
	}
	switch err.Error() {
	case "unauthenticated", "no_installation", "service_disabled",
		"installation_not_active", "feature_disabled":
		return err.Error()
	case context.DeadlineExceeded.Error():
		return "timeout"
	}
	return "internal_error"
}

// WsBroker correlates memory_mcp_grant requests over the daemon WebSocket.
type WsBroker struct {
	client *ws.Client

	mu      sync.Mutex
	waiters map[string]chan protocol.ClientMessage
}

// NewWsBroker wires grant requests onto the daemon's relay connection.
func NewWsBroker(client *ws.Client) *WsBroker {
	return &WsBroker{client: client, waiters: map[string]chan protocol.ClientMessage{}}
}

// Request sends one memory_mcp_grant and awaits its correlated reply.
func (b *WsBroker) Request(ctx context.Context) (Grant, error) {
	id := fmt.Sprintf("mcp-%d-%d", time.Now().UnixNano(), atomic.AddUint64(&requestCounter, 1))
	reply := make(chan protocol.ClientMessage, 1)
	b.mu.Lock()
	b.waiters[id] = reply
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.waiters, id)
		b.mu.Unlock()
	}()

	b.client.SendMsg(protocol.MemoryMcpGrantRequest{Type: "memory_mcp_grant", RequestID: id})

	select {
	case msg := <-reply:
		if msg.Type == "memory_mcp_grant_result" && msg.Grant != "" {
			expiresAt := time.Now().Add(time.Duration(msg.ExpiresIn) * time.Second)
			return Grant{
				Token:     msg.Grant,
				ExpiresAt: expiresAt,
				Origin:    msg.ProviderPublicOrigin,
				InstallID: msg.InstallationID,
			}, nil
		}
		if msg.GrantErrorCode != "" {
			return Grant{}, errCode(msg.GrantErrorCode)
		}
		return Grant{}, errCode("internal_error")
	case <-ctx.Done():
		return Grant{}, errCode("timeout")
	}
}

// Dispatch routes an inbound relay reply to its waiter. Unknown ids are
// dropped silently (late replies after timeout).
func (b *WsBroker) Dispatch(msg protocol.ClientMessage) {
	if msg.Type != "memory_mcp_grant_result" && msg.Type != "memory_mcp_grant_error" {
		return
	}
	b.mu.Lock()
	ch := b.waiters[msg.RequestID]
	b.mu.Unlock()
	if ch != nil {
		select {
		case ch <- msg:
		default:
		}
	}
}

var requestCounter uint64

type codedError struct{ code string }

func (e codedError) Error() string { return e.code }

func errCode(code string) error { return codedError{code: code} }
