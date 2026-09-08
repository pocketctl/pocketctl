package session

import (
	"context"
	"log/slog"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func (sm *SessionManager) ObserveNativeTitle(event protocol.DaemonEvent) {
	if event.Type != "session_title_update" || event.Title == "" || event.TitleSource == "" {
		return
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if ps := sm.sessions[event.SessionID]; ps != nil {
		if ps.NativeTitle != nil && event.TitleSource == "codex" && ps.NativeTitle.TitleSource == "codex" {
			previous, _ := time.Parse(time.RFC3339Nano, ps.NativeTitle.TitleUpdatedAt)
			incoming, _ := time.Parse(time.RFC3339Nano, event.TitleUpdatedAt)
			if incoming.Before(previous) {
				return
			}
		}
		if ps.NativeTitle != nil && ps.NativeTitle.TitleSource == "claude-code-manual" && event.TitleSource != "claude-code-manual" {
			return
		}
		copy := protocol.DaemonEvent{Type: event.Type, SessionID: event.SessionID, Title: event.Title, TitleSource: event.TitleSource, TitleUpdatedAt: event.TitleUpdatedAt}
		ps.NativeTitle = &copy
		ps.TitleUser, ps.TitleAssistant = "", ""
	}
}

// The daemon-owned loop retries even when no new message arrives. Relay's
// conditional update avoids another provider call after a title is present.
func (sm *SessionManager) RunTitleMaintenance(ctx context.Context) {
	index := watcher.NewCodexTitleIndex()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for _, s := range sm.ListSessions() {
				if s.Agent != adapter.AgentCodex {
					continue
				}
				if title, ok := index.Lookup(s.SessionID); ok {
					sm.ObserveNativeTitle(protocol.DaemonEvent{Type: "session_title_update", SessionID: s.SessionID, Title: title.Name, TitleSource: "codex", TitleUpdatedAt: title.UpdatedAt.UTC().Format(time.RFC3339Nano)})
				}
			}
			for _, event := range sm.pendingTitleEvents(now) {
				select {
				case sm.outputCh <- event:
				case <-ctx.Done():
					return
				}
			}
		}
	}
}

func (sm *SessionManager) pendingTitleEvents(now time.Time) []protocol.DaemonEvent {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	var events []protocol.DaemonEvent
	for id, ps := range sm.sessions {
		if ps.NativeTitle != nil {
			events = append(events, *ps.NativeTitle)
			continue
		}
		if ps.TitleUser == "" || ps.TitleAttempts >= MaxTitleAttempts || now.Before(ps.TitleNextAttempt) {
			continue
		}
		ps.TitleAttempts++
		ps.TitleNextAttempt = now.Add(time.Minute << (ps.TitleAttempts - 1))
		events = append(events, protocol.DaemonEvent{Type: "generate_title_request", SessionID: id, UserMessage: ps.TitleUser, AssistantMessage: ps.TitleAssistant})
		slog.Info("session title generation requested", "session", id, "attempt", ps.TitleAttempts)
	}
	return events
}
