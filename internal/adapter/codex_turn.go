package adapter

import (
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// codexTurnTracker preserves the native turn anchor emitted by persisted
// Codex task_started/task_complete records. It deliberately stays unassigned
// when either the session or the native turn id is unavailable: source order
// alone is not identity evidence.
type codexTurnTracker struct {
	sessionID     string
	activeLogical string
	activeSource  string
}

func (t *codexTurnTracker) setSessionID(sessionID string) {
	if sessionID = strings.TrimSpace(sessionID); sessionID != "" {
		t.sessionID = sessionID
	}
}

func codexTurnStatusEvent(sessionID, logicalID, sourceID, state, reason string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type:              protocol.EventTypeTurnStatus,
		SessionID:         sessionID,
		TurnID:            logicalID,
		SourceTurnID:      sourceID,
		TurnStatus:        state,
		TurnReason:        reason,
		TurnOrigin:        protocol.TurnOriginNative,
		TurnConfidence:    protocol.TurnConfidenceNative,
		ActorScope:        protocol.ActorScopeRoot,
		FlowScope:         protocol.FlowScopeAuxiliary,
		ContentClass:      protocol.ContentClassLifecycle,
		ClassifierVersion: protocol.ClassifierVersionV1,
		EventID:           turn.StatusEventID(logicalID, state),
	}
}

func (t *codexTurnTracker) begin(sourceTurnID string) (protocol.DaemonEvent, bool) {
	sourceTurnID = strings.TrimSpace(sourceTurnID)
	if t.sessionID == "" || sourceTurnID == "" || t.activeLogical != "" {
		return protocol.DaemonEvent{}, false
	}
	t.activeSource = sourceTurnID
	t.activeLogical = turn.LogicalTurnID(AgentCodex, t.sessionID, "", "native", sourceTurnID)
	return codexTurnStatusEvent(
		t.sessionID, t.activeLogical, t.activeSource, protocol.TurnStateRunning, "task_started_event",
	), true
}

func (t *codexTurnTracker) end(sourceTurnID string) (protocol.DaemonEvent, bool) {
	if t.activeLogical == "" {
		return protocol.DaemonEvent{}, false
	}
	sourceTurnID = strings.TrimSpace(sourceTurnID)
	// Older Codex rollouts omit turn_id from task_complete. Because the tracker
	// permits only one active native turn, that authoritative completion can
	// safely close the active turn. A present but different id remains stale.
	if sourceTurnID != "" && sourceTurnID != t.activeSource {
		return protocol.DaemonEvent{}, false
	}
	event := codexTurnStatusEvent(
		t.sessionID, t.activeLogical, t.activeSource, protocol.TurnStateCompleted, "task_complete_event",
	)
	t.activeLogical, t.activeSource = "", ""
	return event, true
}

func (t *codexTurnTracker) stamp(events []protocol.DaemonEvent) {
	for i := range events {
		// turn_context arrives before task_started, so metadata emitted from it
		// still needs the rollout's true session ID even without an active turn.
		if events[i].SessionID == "" && events[i].Type != "session_status" {
			events[i].SessionID = t.sessionID
		}
		if t.activeLogical == "" {
			continue
		}
		// Session status remains terminal/session-level state. turn_status is
		// emitted separately and owns the canonical lifecycle identity.
		if events[i].Type == "session_status" {
			continue
		}
		events[i].TurnID = t.activeLogical
		events[i].SourceTurnID = t.activeSource
		events[i].TurnOrigin = protocol.TurnOriginNative
		events[i].TurnConfidence = protocol.TurnConfidenceNative
	}
}

// decorate converts task lifecycle evidence into turn_status events and
// attributes only intervening content to the active native turn. The legacy
// session_status values emitted by convertCodexEventMsg are kept unchanged.
func (t *codexTurnTracker) decorate(topType string, payload codexPayload, events []protocol.DaemonEvent) []protocol.DaemonEvent {
	if topType == "session_meta" {
		t.setSessionID(payload.ID)
		return events
	}
	if topType != "event_msg" {
		t.stamp(events)
		return events
	}
	switch payload.Type {
	case "task_started":
		if started, ok := t.begin(payload.TurnID); ok {
			return append([]protocol.DaemonEvent{started}, events...)
		}
	case "task_complete":
		if completed, ok := t.end(payload.TurnID); ok {
			return append([]protocol.DaemonEvent{completed}, events...)
		}
	default:
		t.stamp(events)
	}
	return events
}
