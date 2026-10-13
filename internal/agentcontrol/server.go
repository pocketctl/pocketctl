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
	ready     chan struct{}
	result    AcquireResult
	err       error
	at        time.Time
	cancel    context.CancelFunc
	waiters   int
	finished  bool
	delivered bool
	abandoned bool
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
	// One request per connection. Losing the launcher must cancel its waiter,
	// including cancellation without a deadline. Duplicate acquires retain the
	// shared operation while at least one caller is still waiting.
	requestCtx, cancelRequest := context.WithCancel(s.ctx)
	defer cancelRequest()
	go func() {
		var extra [1]byte
		_, _ = conn.Read(extra[:])
		cancelRequest()
	}()
	result, dispatchErr := s.dispatch(requestCtx, req)
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
	entry := s.cache[key]
	if entry != nil && entry.abandoned {
		s.mu.Unlock()
		return AcquireResult{}, context.Canceled
	}
	if entry == nil {
		operationCtx, cancel := context.WithTimeout(s.ctx, DefaultAcquireTimeout)
		entry = &acquireCacheEntry{ready: make(chan struct{}), at: time.Now(), cancel: cancel}
		s.cache[key] = entry
		for cacheKey, cached := range s.cache {
			if cacheKey != key && cached.finished && time.Since(cached.at) > 5*time.Minute {
				delete(s.cache, cacheKey)
			}
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer cancel()
			result, err := provider.Acquire(operationCtx, req)
			s.mu.Lock()
			entry.result, entry.err, entry.finished = result, err, true
			// An abandoned operation cannot leave a live lease behind or poison a retry.
			abandoned := entry.waiters == 0 || operationCtx.Err() != nil
			entry.abandoned = abandoned
			if err != nil && !abandoned {
				if s.cache[key] == entry {
					delete(s.cache, key)
				}
			}
			if abandoned {
				entry.err = context.Canceled
			}
			close(entry.ready)
			s.mu.Unlock()
			if abandoned {
				releaseAbandonedAcquire(provider, req, result)
				s.mu.Lock()
				if s.cache[key] == entry {
					delete(s.cache, key)
				}
				s.mu.Unlock()
			}
		}()
	}
	entry.waiters++
	s.mu.Unlock()
	delivered := false
	defer func() {
		s.mu.Lock()
		entry.waiters--
		if delivered {
			entry.delivered = true
		}
		abandoned := entry.waiters == 0 && !entry.delivered
		if abandoned {
			entry.abandoned = true
			entry.cancel()
		}
		// The worker owns cleanup if it has not finished. Otherwise the final
		// canceled waiter owns it. A completed error may already have been cleaned.
		release := abandoned && entry.finished && entry.err == nil
		result := entry.result
		s.mu.Unlock()
		if release {
			releaseAbandonedAcquire(provider, req, result)
			s.mu.Lock()
			if s.cache[key] == entry {
				delete(s.cache, key)
			}
			s.mu.Unlock()
		}
	}()
	select {
	case <-entry.ready:
		if err := ctx.Err(); err != nil {
			return AcquireResult{}, err
		}
		delivered = true
		return entry.result, entry.err
	case <-ctx.Done():
		return AcquireResult{}, ctx.Err()
	}
}

func releaseAbandonedAcquire(provider RuntimeProvider, req AcquireRequest, result AcquireResult) {
	if result.LeaseID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), serverIOTimeout)
	defer cancel()
	_ = provider.Release(ctx, ReleaseRequest{Agent: req.Agent, ClientPID: req.ClientPID, Payload: ReleasePayload{LeaseID: result.LeaseID}})
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
