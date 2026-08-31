package memorycontext

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// GrantTransport carries the relay control-plane messages over the
// authenticated daemon WebSocket. The production implementation wraps the
// existing relay connection; tests substitute fakes.
type GrantTransport interface {
	// RequestContextGrant asks for a session-bound memory.context grant.
	RequestContextGrant(ctx context.Context, requestID, sessionID string) (
		*protocol.MemoryContextGrantResult, error)
	// RegisterSession performs the two-phase managed-session handshake and
	// waits bounded for the durable ack.
	RegisterSession(ctx context.Context, requestID, sessionID string) (
		*protocol.SessionRegistrationAck, error)
}

// GrantClient is the production transport over a relay control sender.
type GrantClient struct {
	Send    func(ctx context.Context, payload []byte) error
	NextID  func() string
	Reply   func(ctx context.Context, requestID string, timeout time.Duration) (json.RawMessage, error)
	Timeout time.Duration

	mu       sync.Mutex
	waiters  map[string]chan json.RawMessage
	pending  map[string]json.RawMessage
	inflight map[string]struct{}
}

// WaitReply waits for one correlated Relay control-plane response. Dispatch
// may win the race with waiter registration, so a bounded pending map retains
// only replies for request ids already emitted by this process.
func (g *GrantClient) WaitReply(ctx context.Context, requestID string, timeout time.Duration) (json.RawMessage, error) {
	g.mu.Lock()
	if _, ok := g.inflight[requestID]; !ok {
		g.mu.Unlock()
		return nil, fmt.Errorf("reply requested for unknown correlation id")
	}
	if raw, ok := g.pending[requestID]; ok {
		delete(g.pending, requestID)
		g.mu.Unlock()
		return raw, nil
	}
	if g.waiters == nil {
		g.waiters = make(map[string]chan json.RawMessage)
	}
	ch := make(chan json.RawMessage, 1)
	g.waiters[requestID] = ch
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		delete(g.waiters, requestID)
		g.mu.Unlock()
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case raw := <-ch:
		return raw, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, context.DeadlineExceeded
	}
}

// Dispatch routes an inbound context-grant or session-registration reply to
// the request that emitted the matching correlation id. Unknown message types
// and empty ids are ignored.
func (g *GrantClient) Dispatch(msg protocol.ClientMessage) {
	switch msg.Type {
	case "memory_context_grant_result", "memory_context_grant_error",
		"session_registration_ack", "session_registration_error":
	default:
		return
	}
	if msg.RequestID == "" {
		return
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.inflight[msg.RequestID]; !ok {
		return
	}
	if ch := g.waiters[msg.RequestID]; ch != nil {
		select {
		case ch <- raw:
		default:
		}
		return
	}
	if g.pending == nil {
		g.pending = make(map[string]json.RawMessage)
	}
	// At most a handful of Phase 2 requests can be in flight. Refuse to retain
	// arbitrary unmatched ids from a malformed Relay.
	if len(g.pending) < 64 {
		g.pending[msg.RequestID] = raw
	}
}

func (g *GrantClient) roundTrip(ctx context.Context, requestID string, payload []byte, out any) error {
	timeout := g.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ctx2, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	g.mu.Lock()
	if g.inflight == nil {
		g.inflight = make(map[string]struct{})
	}
	if requestID == "" || len(g.inflight) >= 64 {
		g.mu.Unlock()
		return fmt.Errorf("invalid or excessive correlation id")
	}
	if _, exists := g.inflight[requestID]; exists {
		g.mu.Unlock()
		return fmt.Errorf("duplicate correlation id")
	}
	g.inflight[requestID] = struct{}{}
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		delete(g.inflight, requestID)
		delete(g.pending, requestID)
		delete(g.waiters, requestID)
		g.mu.Unlock()
	}()
	if err := g.Send(ctx2, payload); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	raw, err := g.Reply(ctx2, requestID, timeout)
	if err != nil {
		return fmt.Errorf("reply: %w", err)
	}
	return json.Unmarshal(raw, out)
}

func (g *GrantClient) RequestContextGrant(ctx context.Context, requestID, sessionID string) (*protocol.MemoryContextGrantResult, error) {
	payload, err := json.Marshal(protocol.MemoryContextGrantRequest{
		Type: "memory_context_grant", RequestID: requestID, SessionID: sessionID,
	})
	if err != nil {
		return nil, err
	}
	var result protocol.MemoryContextGrantResult
	if err := g.roundTrip(ctx, requestID, payload, &result); err != nil {
		return nil, err
	}
	if result.Type != "memory_context_grant_result" {
		// Bounded failure: never echo relay error details upward.
		return nil, fmt.Errorf("relay refused context grant")
	}
	if result.RequestID != "" && result.RequestID != requestID {
		return nil, fmt.Errorf("relay context grant correlation mismatch")
	}
	if result.SessionID != sessionID || result.Grant == "" || result.ProviderPublicOrigin == "" ||
		len(result.Services) != 1 || result.Services[0] != "memory.context" {
		return nil, fmt.Errorf("relay returned invalid context grant")
	}
	return &result, nil
}

func (g *GrantClient) RegisterSession(ctx context.Context, requestID, sessionID string) (*protocol.SessionRegistrationAck, error) {
	payload, err := json.Marshal(protocol.SessionRegistration{
		Type: "session_registration", RequestID: requestID, SessionID: sessionID,
	})
	if err != nil {
		return nil, err
	}
	var ack protocol.SessionRegistrationAck
	if err := g.roundTrip(ctx, requestID, payload, &ack); err != nil {
		return nil, err
	}
	if ack.Type != "session_registration_ack" || ack.Status != "ready" ||
		ack.SessionID != sessionID || (ack.RequestID != "" && ack.RequestID != requestID) {
		return nil, fmt.Errorf("registration not acked")
	}
	return &ack, nil
}
