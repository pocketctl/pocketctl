package adapter

import (
	"encoding/json"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

type codexUsageReceipt struct {
	ThreadID    string           `json:"thread_id"`
	TurnID      string           `json:"turn_id"`
	ResponseID  string           `json:"response_id"`
	Usage       *codexTokenUsage `json:"usage"`
	ThreadUsage *codexTokenUsage `json:"thread_token_usage"`
	matchedMeta protocol.UsageMetadata
}

// codexTurnTracker preserves the native turn anchor emitted by persisted
// Codex task_started/task_complete records. It deliberately stays unassigned
// when either the session or the native turn id is unavailable: source order
// alone is not identity evidence.
type codexTurnTracker struct {
	receipt       *codexUsageReceipt
	sessionID     string
	activeLogical string
	activeSource  string
}

func (t *codexTurnTracker) setSessionID(sessionID string) {
	if sessionID = strings.TrimSpace(sessionID); sessionID != "" {
		if t.sessionID != sessionID {
			t.receipt = nil
		}
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

func (t *codexTurnTracker) end(sourceTurnID, state, reason string) (protocol.DaemonEvent, bool) {
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
		t.sessionID, t.activeLogical, t.activeSource, state, reason,
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
func (t *codexTurnTracker) decorate(raw codexLine, payload codexPayload, events []protocol.DaemonEvent) []protocol.DaemonEvent {
	if raw.Type == "token_usage_record" {
		t.receipt = nil
		var receipt codexUsageReceipt
		if json.Unmarshal(raw.Payload, &receipt) == nil && t.sessionID != "" && receipt.ThreadID == t.sessionID &&
			t.activeSource != "" && receipt.TurnID == t.activeSource && strings.TrimSpace(receipt.ResponseID) != "" &&
			len(receipt.ResponseID) <= 200 && receipt.Usage != nil && receipt.Usage.CacheWriteInputTokens == 0 &&
			receipt.ThreadUsage != nil && receipt.ThreadUsage.TotalTokens > 0 {
			t.receipt = &receipt
		}
		return events
	}
	if raw.Type == "session_meta" {
		t.receipt = nil
		t.setSessionID(payload.ID)
		return events
	}
	if raw.Type != "event_msg" {
		if raw.Type == "turn_context" && payload.TurnID != "" && t.receipt != nil && payload.TurnID != t.receipt.TurnID {
			t.receipt = nil
		}
		t.stamp(events)
		return events
	}
	switch payload.Type {
	case "token_count":
		r := t.receipt
		if r != nil && (payload.TurnID == "" || payload.TurnID == r.TurnID) &&
			payload.Info.LastTokenUsage != nil && payload.Info.TotalTokenUsage != nil &&
			(payload.LastTokenUsage == nil || *payload.LastTokenUsage == *r.Usage) &&
			*payload.Info.LastTokenUsage == *r.Usage && *payload.Info.TotalTokenUsage == *r.ThreadUsage {
			for i := range events {
				if meta := events[i].UsageMeta; meta != nil {
					// Rate-limit refreshes can repeat both snapshots with a later
					// timestamp. They still describe the same upstream response.
					if r.matchedMeta.SourceUsageID == "" {
						r.matchedMeta = *meta
						r.matchedMeta.SourceUsageID = r.ResponseID
					}
					*meta = r.matchedMeta
				}
			}
		} else {
			t.receipt = nil
		}
		t.stamp(events)
	case "task_started":
		t.receipt = nil
		if started, ok := t.begin(payload.TurnID); ok {
			return append([]protocol.DaemonEvent{started}, events...)
		}
	case "task_complete":
		t.receipt = nil
		// Stamp the terminal diagnostic before end clears the active identity.
		t.stamp(events)
		state, reason := protocol.TurnStateCompleted, "task_complete_event"
		if ProjectCodexError(payload.Error).Present {
			state, reason = protocol.TurnStateFailed, "task_complete_error"
		}
		if completed, ok := t.end(payload.TurnID, state, reason); ok {
			for i := range events {
				if events[i].Type == "error" && events[i].EventID == "" {
					events[i].EventID = CodexErrorEventID(completed.TurnID, events[i].Code, events[i].Error)
				}
			}
			return append([]protocol.DaemonEvent{completed}, events...)
		}
	default:
		t.stamp(events)
	}
	return events
}
