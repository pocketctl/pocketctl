package session

import (
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// TestGenerateTitleAttemptCap verifies the re-triggerable semantics: each call
// up to MaxTitleAttempts emits a generate_title_request (so a new conversation
// round can re-ask after a transient GLM failure), and anything past the cap
// is silently dropped (bounds cost/429-risk during a sustained outage).
func TestGenerateTitleAttemptCap(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(outputCh)
	sm.RegisterTerminalSession("sid", "/tmp", 1, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	// 前 MaxTitleAttempts 次每次都应发一个 generate_title_request（每轮可重触发）
	for i := 0; i < MaxTitleAttempts; i++ {
		sm.GenerateTitle("sid", "u", "a")
		select {
		case evt := <-outputCh:
			if evt.Type != "generate_title_request" {
				t.Fatalf("attempt %d: expected generate_title_request, got %q", i, evt.Type)
			}
		case <-time.After(time.Second):
			t.Fatalf("attempt %d: expected an event, none sent", i)
		}
	}

	// 计数正好到上限
	sm.mu.RLock()
	got := sm.sessions["sid"].TitleAttempts
	sm.mu.RUnlock()
	if got != MaxTitleAttempts {
		t.Fatalf("expected TitleAttempts=%d, got %d", MaxTitleAttempts, got)
	}

	// 上限之后不再发送
	sm.GenerateTitle("sid", "u", "a")
	select {
	case evt := <-outputCh:
		t.Fatalf("expected no event after cap, got %q", evt.Type)
	default:
		// good
	}
}

// TestGenerateTitleUnknownSession ensures a non-registered id emits nothing
// rather than blocking or erroring on the output channel.
func TestGenerateTitleUnknownSession(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 4)
	sm := NewSessionManager(outputCh)
	sm.GenerateTitle("unknown", "u", "a")
	select {
	case evt := <-outputCh:
		t.Fatalf("unknown session should not emit, got %q", evt.Type)
	default:
	}
}
