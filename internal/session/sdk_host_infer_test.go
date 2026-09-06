package session

import (
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestInferSDKHostSession(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	const cwd = "/repo"

	register := func(id, status string, activity time.Time) {
		sm.RegisterTerminalSession(id, cwd, 0, "", status, adapter.AgentClaude)
		sm.RestoreSessionActivity(id, activity)
	}

	t.Run("no candidates returns false", func(t *testing.T) {
		if _, ok := sm.InferSDKHostSession(cwd); ok {
			t.Fatal("expected no host for empty manager")
		}
	})

	t.Run("single candidate wins", func(t *testing.T) {
		register("host-1", "busy", time.Now())
		if id, ok := sm.InferSDKHostSession(cwd); !ok || id != "host-1" {
			t.Fatalf("host = %q, %v; want host-1", id, ok)
		}
	})

	t.Run("most recently active wins among many", func(t *testing.T) {
		sm2 := NewSessionManager(make(chan protocol.DaemonEvent, 8))
		older := time.Now().Add(-10 * time.Minute)
		newer := time.Now().Add(-30 * time.Second)
		for _, tc := range []struct {
			id   string
			at   time.Time
		}{{"older", older}, {"newer", newer}} {
			sm2.RegisterTerminalSession(tc.id, cwd, 0, "", "busy", adapter.AgentClaude)
			sm2.RestoreSessionActivity(tc.id, tc.at)
		}
		if id, ok := sm2.InferSDKHostSession(cwd); !ok || id != "newer" {
			t.Fatalf("host = %q, %v; want newer", id, ok)
		}
	})

	t.Run("other cwd and exited sessions are not candidates", func(t *testing.T) {
		sm3 := NewSessionManager(make(chan protocol.DaemonEvent, 8))
		sm3.RegisterTerminalSession("elsewhere", "/other", 0, "", "busy", adapter.AgentClaude)
		sm3.RegisterTerminalSession("gone", cwd, 0, "", "exited", adapter.AgentClaude)
		if _, ok := sm3.InferSDKHostSession(cwd); ok {
			t.Fatal("expected no host: only other-cwd and exited sessions exist")
		}
	})
}
