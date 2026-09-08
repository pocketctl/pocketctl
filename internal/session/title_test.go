package session

import (
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestGenerateTitleAttemptCap(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	sm.sessions["sid"] = &ProcessState{SessionID: "sid"}
	sm.GenerateTitle("sid", "u", "a")
	if events := sm.pendingTitleEvents(time.Now()); len(events) != 0 {
		t.Fatal("native title grace period must delay fallback")
	}
	for i := 0; i < MaxTitleAttempts; i++ {
		now := sm.sessions["sid"].TitleNextAttempt
		events := sm.pendingTitleEvents(now)
		if len(events) != 1 || events[0].Type != "generate_title_request" || events[0].UserMessage != "u" || events[0].AssistantMessage != "a" {
			t.Fatalf("attempt %d: %+v", i, events)
		}
		if events := sm.pendingTitleEvents(now); len(events) != 0 {
			t.Fatal("retry must respect backoff")
		}
		if got := sm.sessions["sid"].TitleNextAttempt.Sub(now); got != time.Minute<<i {
			t.Fatalf("backoff = %v", got)
		}
	}
	sm.GenerateTitle("sid", "new user", "new answer")
	if events := sm.pendingTitleEvents(time.Now().Add(24 * time.Hour)); len(events) != 0 {
		t.Fatal("new messages must not bypass retry cap")
	}
}

func TestGenerateTitleUnknownOrMissingContent(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sm.sessions["sid"] = &ProcessState{SessionID: "sid"}
	sm.GenerateTitle("unknown", "u", "a")
	sm.GenerateTitle("sid", "u", "")
	if events := sm.pendingTitleEvents(time.Now().Add(time.Hour)); len(events) != 0 {
		t.Fatalf("invalid request emitted: %+v", events)
	}
}

func TestNativeTitleCancelsFallbackAndProtectsCustomName(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sm.sessions["sid"] = &ProcessState{SessionID: "sid"}
	sm.GenerateTitle("sid", "u", "a")
	sm.ObserveNativeTitle(protocol.DaemonEvent{Type: "session_title_update", SessionID: "sid", Title: "custom", TitleSource: "claude-code-manual", Seq: 9, EventID: "old"})
	sm.ObserveNativeTitle(protocol.DaemonEvent{Type: "session_title_update", SessionID: "sid", Title: "ai", TitleSource: "claude-code"})
	events := sm.pendingTitleEvents(time.Now().Add(time.Hour))
	if len(events) != 1 || events[0].Title != "custom" || events[0].Seq != 0 || events[0].EventID != "" || sm.sessions["sid"].TitleUser != "" {
		t.Fatalf("native priority/retry envelope: %+v", events)
	}
}

func TestCodexNativeTitleIgnoresStaleIndex(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sm.sessions["sid"] = &ProcessState{SessionID: "sid"}
	for i, stamp := range []string{"2026-09-08T10:00:00Z", "2026-09-08T09:00:00Z"} {
		sm.ObserveNativeTitle(protocol.DaemonEvent{Type: "session_title_update", SessionID: "sid", Title: []string{"new", "old"}[i], TitleSource: "codex", TitleUpdatedAt: stamp})
	}
	if got := sm.sessions["sid"].NativeTitle.Title; got != "new" {
		t.Fatalf("stale index replaced name: %s", got)
	}
}
