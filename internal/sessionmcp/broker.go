package sessionmcp

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type controlSender interface {
	SendMsg(any)
}

type WsBroker struct {
	client  controlSender
	mu      sync.Mutex
	waiters map[string]chan protocol.ClientMessage
}

func NewWsBroker(client controlSender) *WsBroker {
	return &WsBroker{client: client, waiters: make(map[string]chan protocol.ClientMessage)}
}

func (b *WsBroker) Read(ctx context.Context, request IpcReadRequest) (protocol.SessionHistoryReadResult, error) {
	requestID := fmt.Sprintf("session-mcp-%d-%d", time.Now().UnixNano(), atomic.AddUint64(&sessionRequestCounter, 1))
	reply := make(chan protocol.ClientMessage, 1)
	b.mu.Lock()
	b.waiters[requestID] = reply
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.waiters, requestID)
		b.mu.Unlock()
	}()
	b.client.SendMsg(protocol.SessionHistoryReadRequest{
		Type: "session_history_read", RequestID: requestID,
		SourceSessionID: request.SourceSessionID, TargetSessionID: request.TargetSessionID,
		Cursor: request.Cursor,
	})
	select {
	case message := <-reply:
		if message.Type == "session_history_read_error" {
			return protocol.SessionHistoryReadResult{}, errors.New(boundedCode(message.GrantErrorCode))
		}
		if message.Type != "session_history_read_result" || !message.UntrustedContent {
			return protocol.SessionHistoryReadResult{}, errors.New("internal_error")
		}
		return protocol.SessionHistoryReadResult{
			Type:                   message.Type,
			SourceSessionID:        message.SourceSessionID,
			TargetSessionID:        message.TargetSessionID,
			Messages:               message.SessionHistoryMessages,
			HasMore:                message.HasMore,
			NextCursor:             message.NextCursor,
			LargeSession:           message.LargeSession,
			SnapshotThroughEventID: message.SnapshotThroughEventID,
			SyncedThroughAt:        message.SyncedThroughAt,
			PossiblyIncomplete:     message.PossiblyIncomplete,
			UntrustedContent:       message.UntrustedContent,
		}, nil
	case <-ctx.Done():
		return protocol.SessionHistoryReadResult{}, errors.New("timeout")
	}
}

func (b *WsBroker) Dispatch(message protocol.ClientMessage) bool {
	if message.Type != "session_history_read_result" && message.Type != "session_history_read_error" {
		return false
	}
	b.mu.Lock()
	waiter := b.waiters[message.RequestID]
	b.mu.Unlock()
	if waiter != nil {
		select {
		case waiter <- message:
		default:
		}
	}
	return true
}

var sessionRequestCounter uint64
