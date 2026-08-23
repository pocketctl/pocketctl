package agentcontrol

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/platform"
)

const serverIOTimeout = 2 * time.Second

type RuntimeProvider interface {
	Acquire(context.Context, AcquireRequest) (AcquireResult, error)
	BindLease(context.Context, LeaseBindRequest) error
	Release(context.Context, ReleaseRequest) error
	Status(context.Context, RuntimeStatusRequest) (RuntimeStatusResult, error)
}

type acquireCacheEntry struct {
	ready  chan struct{}
	result AcquireResult
	err    error
	at     time.Time
}

type Server struct {
	path      string
	providers map[string]RuntimeProvider

	mu        sync.Mutex
	listener  net.Listener
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	cache     map[string]*acquireCacheEntry
	ioTimeout time.Duration
}

func NewServer(path string, providers map[string]RuntimeProvider) *Server {
	copyProviders := make(map[string]RuntimeProvider, len(providers))
	for agent, provider := range providers {
		copyProviders[agent] = provider
	}
	return &Server{path: path, providers: copyProviders, cache: make(map[string]*acquireCacheEntry), ioTimeout: serverIOTimeout}
}

func (s *Server) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener != nil {
		return nil
	}
	if s.path == "" {
		return errors.New("agent control endpoint is empty")
	}
	listener, err := platform.NewIPCListener().Listen(s.path)
	if err != nil {
		return err
	}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.listener = listener
	s.wg.Add(1)
	go s.serve(listener)
	return nil
}

func (s *Server) serve(listener net.Listener) {
	defer s.wg.Done()
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			select {
			case <-s.ctx.Done():
				return
			default:
				continue
			}
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer conn.Close()
			s.handle(conn)
		}()
	}
}

func (s *Server) handle(conn net.Conn) {
	timeout := s.ioTimeout
	if timeout <= 0 {
		timeout = serverIOTimeout
	}
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	limited := io.LimitReader(conn, MaxFrameSize+2)
	frame, err := bufio.NewReaderSize(limited, MaxFrameSize+2).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return
		}
		s.writeResponse(conn, Response{Version: ProtocolVersion, Error: protocolError(ErrInvalidRequest, "could not read request")})
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	frame = bytes.TrimSuffix(frame, []byte{'\n'})
	if len(frame) > MaxFrameSize {
		s.writeResponse(conn, Response{Version: ProtocolVersion, Error: protocolError(ErrInvalidRequest, "frame exceeds size limit")})
		return
	}
	var req Request
	if err := json.Unmarshal(frame, &req); err != nil {
		s.writeResponse(conn, Response{Version: ProtocolVersion, Error: protocolError(ErrInvalidRequest, "invalid JSON request")})
		return
	}
	resp := Response{Version: ProtocolVersion, ID: req.ID}
	if err := ValidateRequest(req); err != nil {
		resp.Error = asProtocolError(err)
		s.writeResponse(conn, resp)
		return
	}
	result, dispatchErr := s.dispatch(s.ctx, req)
	if dispatchErr != nil {
		resp.Error = asProtocolError(dispatchErr)
	} else {
		resp.Result, dispatchErr = json.Marshal(result)
		if dispatchErr != nil {
			resp.Error = protocolError(ErrRuntimeUnavailable, "could not encode runtime response")
		}
	}
	s.writeResponse(conn, resp)
}

func (s *Server) dispatch(ctx context.Context, req Request) (any, error) {
	provider := s.providers[req.Agent]
	if provider == nil {
		return nil, protocolError(ErrRuntimeUnavailable, "agent runtime provider is unavailable")
	}
	switch req.Method {
	case MethodRuntimeAcquire:
		var payload AcquirePayload
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			return nil, invalid("invalid acquire payload")
		}
		if err := ValidateAcquire(payload); err != nil {
			return nil, err
		}
		return s.acquireDeduplicated(ctx, provider, AcquireRequest{Agent: req.Agent, ClientPID: req.ClientPID, Payload: payload})
	case MethodRuntimeLeaseBind:
		var payload LeaseBindPayload
		if err := json.Unmarshal(req.Payload, &payload); err != nil || payload.LeaseID == "" || payload.PID <= 0 {
			return nil, invalid("invalid lease bind payload")
		}
		return struct{}{}, provider.BindLease(ctx, LeaseBindRequest{Agent: req.Agent, ClientPID: req.ClientPID, Payload: payload})
	case MethodRuntimeRelease:
		var payload ReleasePayload
		if err := json.Unmarshal(req.Payload, &payload); err != nil || payload.LeaseID == "" {
			return nil, invalid("invalid release payload")
		}
		return struct{}{}, provider.Release(ctx, ReleaseRequest{Agent: req.Agent, ClientPID: req.ClientPID, Payload: payload})
	case MethodRuntimeStatus:
		return provider.Status(ctx, RuntimeStatusRequest{Agent: req.Agent, ClientPID: req.ClientPID})
	default:
		return nil, invalid("unknown method %q", req.Method)
	}
}

func (s *Server) acquireDeduplicated(ctx context.Context, provider RuntimeProvider, req AcquireRequest) (AcquireResult, error) {
	key := req.Agent + "\x00" + req.Payload.OperationID
	s.mu.Lock()
	if existing := s.cache[key]; existing != nil {
		ready := existing.ready
		s.mu.Unlock()
		select {
		case <-ready:
			return existing.result, existing.err
		case <-ctx.Done():
			return AcquireResult{}, ctx.Err()
		}
	}
	entry := &acquireCacheEntry{ready: make(chan struct{}), at: time.Now()}
	s.cache[key] = entry
	for cacheKey, cached := range s.cache {
		if cacheKey != key && time.Since(cached.at) > 5*time.Minute {
			delete(s.cache, cacheKey)
		}
	}
	s.mu.Unlock()

	entry.result, entry.err = provider.Acquire(ctx, req)
	close(entry.ready)
	return entry.result, entry.err
}

func (s *Server) writeResponse(conn net.Conn, resp Response) {
	frame, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(serverIOTimeout))
	_, _ = conn.Write(append(frame, '\n'))
}

func (s *Server) Close() error {
	s.mu.Lock()
	listener, cancel := s.listener, s.cancel
	s.listener, s.cancel = nil, nil
	s.mu.Unlock()
	if listener == nil {
		return nil
	}
	if cancel != nil {
		cancel()
	}
	err := listener.Close()
	s.wg.Wait()
	cleanupAgentControlEndpoint(s.path)
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

func protocolError(code, message string) *ProtocolError {
	return &ProtocolError{Code: code, Message: message}
}

func asProtocolError(err error) *ProtocolError {
	var typed *ProtocolError
	if errors.As(err, &typed) {
		return typed
	}
	return protocolError(ErrRuntimeUnavailable, fmt.Sprintf("runtime provider failed: %v", err))
}
