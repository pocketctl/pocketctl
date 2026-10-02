package session

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/watcher"
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

func TestCodexDesktopNativeTitleIgnoresStaleIndex(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sm.sessions["desk"] = &ProcessState{SessionID: "desk"}
	for i, stamp := range []string{"2026-10-01T10:00:00Z", "2026-10-01T09:00:00Z"} {
		sm.ObserveNativeTitle(protocol.DaemonEvent{Type: "session_title_update", SessionID: "desk", Title: []string{"new", "old"}[i], TitleSource: "codex-desktop", TitleUpdatedAt: stamp})
	}
	if got := sm.sessions["desk"].NativeTitle.Title; got != "new" {
		t.Fatalf("stale desktop index replaced name: %s", got)
	}
}

// Desktop observers rely on the tail loop for names; the maintenance pass must
// still cover them so a paused tail converges on renames within a tick.
func TestTitleMaintenanceSyncsCodexDesktopObserver(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	if err := os.WriteFile(filepath.Join(dir, "session_index.jsonl"), []byte(
		`{"id":"desk","thread_name":"桌面标题","updated_at":"2026-10-01T10:00:00Z"}`+"\n"+
			`{"id":"cli","thread_name":"命令行标题","updated_at":"2026-10-01T10:00:00Z"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sm.sessions["cli"] = &ProcessState{SessionID: "cli", Agent: "codex"}
	sm.sessions["desk"] = &ProcessState{SessionID: "desk", Agent: "codex-desktop", Source: "observer"}
	sm.sessions["cc"] = &ProcessState{SessionID: "cc", Agent: "claude-code"}
	sm.syncNativeCodexTitles(watcher.NewCodexTitleIndex())
	if ps := sm.sessions["cc"]; ps.NativeTitle != nil {
		t.Fatalf("claude session must not consume codex names: %+v", ps.NativeTitle)
	}
	bySource := map[string]protocol.DaemonEvent{}
	for _, ev := range sm.pendingTitleEvents(time.Now()) {
		if ev.Type != "session_title_update" {
			continue
		}
		bySource[ev.TitleSource] = ev
	}
	if ev := bySource["codex"]; ev.Title != "命令行标题" || ev.SessionID != "cli" {
		t.Fatalf("codex native title missing: %+v", ev)
	}
	ev, ok := bySource["codex-desktop"]
	if !ok || ev.Title != "桌面标题" || ev.SessionID != "desk" || ev.TitleUpdatedAt != "2026-10-01T10:00:00Z" {
		t.Fatalf("desktop observer title missing: ok=%v %+v", ok, ev)
	}
}
