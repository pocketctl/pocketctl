package turn

import (
	"crypto/sha256"
	"encoding/base64"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// StatusEventID derives the forced-stable event id for one turn_status
// emission: turn:<hash>:status:<state>. The hash is content-free (derived
// from the logical turn id only), so replays and retries converge on the same
// id and the relay can dedup.
func StatusEventID(turnID, state string) string {
	sum := sha256.Sum256([]byte(turnID))
	return "turn:" + base64.RawURLEncoding.EncodeToString(sum[:12]) + ":status:" + state
}

// StatusEvent projects a turn record state into a turn_status DaemonEvent.
// The caller is responsible for emission ordering; the registry's
// ClaimEmission is the single dedup point for (turn_id, state).
func StatusEvent(rec TurnRecord, state, reason string) protocol.DaemonEvent {
	ev := protocol.DaemonEvent{
		Type:               protocol.EventTypeTurnStatus,
		SessionID:          rec.Actor.SessionID,
		TurnID:             rec.TurnID,
		SourceTurnID:       rec.SourceTurnID,
		TurnStatus:         state,
		TurnOrigin:         rec.Origin,
		TurnConfidence:     rec.Confidence,
		PreviousTurnID:     rec.PreviousTurnID,
		ContinuationReason: rec.ContinuationReason,
		AgentID:            rec.Actor.AgentID,
		ActorScope:         ActorScope(rec.Actor.AgentID, rec.Actor.AgentID != ""),
		FlowScope:          protocol.FlowScopeAuxiliary,
		ContentClass:       protocol.ContentClassLifecycle,
		ClassifierVersion:  protocol.ClassifierVersionV1,
		EventID:            StatusEventID(rec.TurnID, state),
	}
	if reason != "" {
		ev.TurnReason = reason
	}
	return ev
}

// Enrich stamps turn identity metadata onto a content event without touching
// its existing fields. It intentionally does not reclassify: the classifier
// owns flow/content classes, this only binds identity (plan §5 enricher).
func Enrich(ev *protocol.DaemonEvent, rec TurnRecord) {
	if ev == nil || rec.TurnID == "" {
		return
	}
	ev.TurnID = rec.TurnID
	if ev.SourceTurnID == "" {
		ev.SourceTurnID = rec.SourceTurnID
	}
	if ev.TurnOrigin == "" {
		ev.TurnOrigin = rec.Origin
	}
	if ev.TurnConfidence == "" {
		ev.TurnConfidence = rec.Confidence
	}
}
