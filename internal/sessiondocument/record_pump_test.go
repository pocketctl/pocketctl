package sessiondocument

import (
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestRecordPumpYieldsUntilLowPriorityGateOpensAndPreservesBatchOrder(t *testing.T) {
	var mu sync.Mutex
	ready := false
	emitted := make([]string, 0, 3)
	pump := NewRecordPump(RecordPumpOptions{
		BatchDepth: 2, RetryDelay: time.Millisecond,
		CanEmit: func() bool {
			mu.Lock()
			defer mu.Unlock()
			return ready
		},
		Emit: func(event protocol.DaemonEvent) bool {
			mu.Lock()
			defer mu.Unlock()
			emitted = append(emitted, event.Type)
			return true
		},
	})
	defer pump.Stop()
	records := []protocol.DaemonEvent{
		{Type: protocol.EventTypeSessionDocumentBegin},
		{Type: protocol.EventTypeSessionDocumentChunk},
		{Type: protocol.EventTypeSessionDocumentCommit},
	}
	if !pump.Submit(records) {
		t.Fatal("batch rejected")
	}
	time.Sleep(10 * time.Millisecond)
	mu.Lock()
	if len(emitted) != 0 {
		t.Fatalf("document emitted while higher-priority gate was closed: %v", emitted)
	}
	ready = true
	mu.Unlock()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(emitted)
		mu.Unlock()
		if count == len(records) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(emitted) != 3 || emitted[0] != protocol.EventTypeSessionDocumentBegin ||
		emitted[1] != protocol.EventTypeSessionDocumentChunk || emitted[2] != protocol.EventTypeSessionDocumentCommit {
		t.Fatalf("batch order changed: %v", emitted)
	}
}

func TestRecordPumpAdmissionIsBoundedAndAllOrNothing(t *testing.T) {
	block := make(chan struct{})
	pump := NewRecordPump(RecordPumpOptions{
		BatchDepth: 1, RetryDelay: time.Millisecond,
		CanEmit: func() bool { return false },
		Emit:    func(protocol.DaemonEvent) bool { <-block; return true },
	})
	defer func() {
		close(block)
		pump.Stop()
	}()
	batch := []protocol.DaemonEvent{{Type: protocol.EventTypeSessionDocumentBegin}, {Type: protocol.EventTypeSessionDocumentCommit}}
	if !pump.Submit(batch) {
		t.Fatal("first batch rejected")
	}
	if pump.Submit(batch) {
		t.Fatal("record pump exceeded its batch bound")
	}
	if pump.Submit(nil) {
		t.Fatal("empty batch accepted")
	}
}
