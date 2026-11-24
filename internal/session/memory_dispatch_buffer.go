package session

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Only events observed DURING a correlated native dispatch can wait for its
// exact ACK. Historical replay, observers and unrelated turns gain no authority.
// This is a bounded ordering buffer, never a provenance backfill store.
type memoryDispatchBuffer struct {
	expectedInput string
	events        []protocol.DaemonEvent
	bytes         int
	timer         *time.Timer
}

func (sm *SessionManager) beginMemoryCodexDispatch(in UserMessageInput) func(bool) {
	if sm == nil {
		return func(bool) {}
	}
	expected := memoryInputProvenance(in, "pending", "codex")
	if expected == nil {
		return func(bool) {}
	}
	ledger := sm.memoryLedger()
	ledger.mu.Lock()
	if ledger.pending == nil {
		ledger.pending = map[string]*memoryDispatchBuffer{}
	}
	if ledger.pending[in.SessionID] != nil || len(ledger.pending) >= 512 {
		ledger.mu.Unlock()
		return func(bool) {}
	}
	pending := &memoryDispatchBuffer{expectedInput: expected.EventID}
	ledger.pending[in.SessionID] = pending
	ledger.mu.Unlock()
	var once sync.Once
	finish := func(accepted bool) {
		once.Do(func() {
			ledger.mu.Lock()
			if ledger.pending[in.SessionID] != pending {
				ledger.mu.Unlock()
				return
			}
			delete(ledger.pending, in.SessionID)
			if pending.timer != nil {
				pending.timer.Stop()
			}
			binding := ledger.bindings[in.SessionID]
			trusted := accepted && binding != nil && binding.root.EventID == pending.expectedInput
			events := pending.events
			ledger.mu.Unlock()
			for _, event := range events {
				reason := "dispatch_unconfirmed"
				if trusted {
					reason = sm.stampNativeMemorySourceForInput(&event, pending.expectedInput)
				} else if accepted {
					reason = "accepted_input_without_output_binding"
				}
				recordUnknownMemorySource(&event, "codex", reason)
				sm.outputCh <- event
			}
		})
	}
	ledger.mu.Lock()
	if ledger.pending[in.SessionID] == pending {
		pending.timer = time.AfterFunc(2*time.Second, func() { finish(false) })
	}
	ledger.mu.Unlock()
	return finish
}
func (sm *SessionManager) bufferMemoryCodexEvent(event protocol.DaemonEvent) bool {
	if event.Resync || event.MemoryNative == nil || event.MemoryNative.Producer != "codex" || event.MemorySource != nil {
		return false
	}
	ledger := sm.memoryLedger()
	ledger.mu.Lock()
	pending := ledger.pending[event.SessionID]
	if pending == nil {
		ledger.mu.Unlock()
		return false
	}
	bytes, err := json.Marshal(event)
	if err == nil && len(pending.events) < 256 && pending.bytes+len(bytes) <= 1024*1024 {
		pending.events = append(pending.events, event)
		pending.bytes += len(bytes)
		ledger.mu.Unlock()
		return true
	}
	// Overflow preserves every event, but denies provenance for this buffered
	// prefix. Never let a late ACK retroactively upgrade already emitted events.
	delete(ledger.pending, event.SessionID)
	if pending.timer != nil {
		pending.timer.Stop()
	}
	events := append(pending.events, event)
	ledger.mu.Unlock()
	for _, queued := range events {
		recordUnknownMemorySource(&queued, "codex", "dispatch_buffer_overflow")
		sm.outputCh <- queued
	}
	return true
}
