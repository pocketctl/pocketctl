package adapter

import (
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// claudeTurnTracker derives conservative turn boundaries for Claude Code from
// stable record identity (plan stage 4):
//
//   - A real user record with a uuid starts a turn when none is active.
//   - A user record while a turn is running binds as an addendum (same turn).
//   - The "result" record (Claude's authoritative end-of-turn evidence) closes
//     the turn as completed; a "[Request interrupted" marker closes it as
//     interrupted.
//   - Records without a usable uuid anchor stay unassigned — never grouped by
//     time or nearest-user-message guessing, and never a content hash.
//
// The tracker only stamps identity metadata and emits turn_status events; it
// never filters, reorders or rewrites content events.
type claudeTurnTracker struct {
	activeLogical string
	activeSource  string
}

// ClaudeTurnStatusEvent builds the lifecycle event for a derived turn state.
func claudeTurnStatusEvent(sessionID, logicalID, sourceID, state, reason string, subagent bool) protocol.DaemonEvent {
	ev := protocol.DaemonEvent{
		Type:              protocol.EventTypeTurnStatus,
		SessionID:         sessionID,
		TurnID:            logicalID,
		SourceTurnID:      sourceID,
		TurnStatus:        state,
		TurnOrigin:        protocol.TurnOriginSourceMessage,
		TurnConfidence:    protocol.TurnConfidenceDerived,
		ActorScope:        protocol.ActorScopeRoot,
		FlowScope:         protocol.FlowScopeAuxiliary,
		ContentClass:      protocol.ContentClassLifecycle,
		ClassifierVersion: protocol.ClassifierVersionV1,
		EventID:           turn.StatusEventID(logicalID, state),
	}
	if reason != "" {
		ev.TurnReason = reason
	}
	if subagent {
		ev.ActorScope = protocol.ActorScopeSubagent
	}
	return ev
}

// begin starts a turn anchored on the user record's uuid. Returns the
// turn_status(running) event and true, or false when the anchor is missing
// (stay unassigned) or a turn is already active (addendum — same turn).
func (t *claudeTurnTracker) begin(sessionID, anchorUUID string, subagent bool) (protocol.DaemonEvent, bool) {
	if anchorUUID == "" || t.activeLogical != "" {
		return protocol.DaemonEvent{}, false
	}
	t.activeSource = anchorUUID
	t.activeLogical = turn.LogicalTurnID(AgentClaude, sessionID, actorKeyFor(subagent), "source_message", anchorUUID)
	return claudeTurnStatusEvent(sessionID, t.activeLogical, t.activeSource, protocol.TurnStateRunning, "user_record", subagent), true
}

// end closes the active turn in the given state. Returns the turn_status
// event and true, or false when nothing is active (late/duplicate terminal
// evidence).
func (t *claudeTurnTracker) end(sessionID, state, reason string, subagent bool) (protocol.DaemonEvent, bool) {
	if t.activeLogical == "" {
		return protocol.DaemonEvent{}, false
	}
	ev := claudeTurnStatusEvent(sessionID, t.activeLogical, t.activeSource, state, reason, subagent)
	t.activeLogical, t.activeSource = "", ""
	return ev, true
}

// stamp binds turn identity onto a content event from the active turn.
func (t *claudeTurnTracker) stamp(ev *protocol.DaemonEvent, subagent bool) {
	if ev == nil || t.activeLogical == "" {
		return
	}
	ev.TurnID = t.activeLogical
	ev.SourceTurnID = t.activeSource
	ev.TurnOrigin = protocol.TurnOriginSourceMessage
	ev.TurnConfidence = protocol.TurnConfidenceDerived
	if subagent {
		ev.ActorScope = protocol.ActorScopeSubagent
	}
}

func actorKeyFor(subagent bool) string {
	if subagent {
		return "sidechain"
	}
	return ""
}

// isPureInterruptMarker reports whether a user record's text is solely
// Claude's interruption marker (e.g. "[Request interrupted by user for tool
// use]"). These records are terminal evidence, not user input.
func isPureInterruptMarker(text string) bool {
	return strings.HasPrefix(strings.TrimSpace(text), "[Request interrupted")
}
