package session

import (
	"bytes"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type interruptPTY struct {
	bytes.Buffer
}

func (p *interruptPTY) Close() error                    { return nil }
func (p *interruptPTY) SetSize(rows, cols uint16) error { return nil }

func TestInterruptDaemonPTYPublishesIdleStatus(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 1)
	sm := NewSessionManager(outputCh)
	pty := &interruptPTY{}
	sm.sessions["session-1"] = &ProcessState{
		SessionID: "session-1",
		Source:    "daemon",
		Status:    protocol.StatusRunning,
		PTY:       pty,
	}

	if err := sm.InterruptSession("session-1"); err != nil {
		t.Fatalf("InterruptSession() error = %v", err)
	}
	if got := pty.Bytes(); !bytes.Equal(got, []byte{0x03}) {
		t.Fatalf("PTY bytes = %v, want Ctrl+C", got)
	}

	select {
	case event := <-outputCh:
		if event.Type != "session_status" || event.SessionID != "session-1" || event.Status != protocol.StatusIdle {
			t.Fatalf("event = %+v, want idle session_status", event)
		}
		if event.LastActivityAt == "" {
			t.Fatal("idle session_status missing last_activity_at")
		}
	case <-time.After(time.Second):
		t.Fatal("InterruptSession() did not publish idle session_status")
	}

	sm.mu.RLock()
	status := sm.sessions["session-1"].Status
	sm.mu.RUnlock()
	if status != protocol.StatusIdle {
		t.Fatalf("stored status = %q, want %q", status, protocol.StatusIdle)
	}
}
