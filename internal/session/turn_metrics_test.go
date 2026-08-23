package session

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// The central outgoing classifier stamps metadata without touching identity
// or content, and counts content events that stay unassigned.
func TestEnrichOutgoingEventClassifiesAndCounts(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	ev := protocol.DaemonEvent{Type: "tool_call", SessionID: "s", CallID: "c1"}
	sm.EnrichOutgoingEvent(&ev)
	if ev.FlowScope != protocol.FlowScopeAuxiliary || ev.ContentClass != protocol.ContentClassExecution {
		t.Fatalf("classification = %s/%s", ev.FlowScope, ev.ContentClass)
	}
	if ev.ActorScope != protocol.ActorScopeRoot || ev.ClassifierVersion != protocol.ClassifierVersionV1 {
		t.Fatalf("scope/version = %s/%s", ev.ActorScope, ev.ClassifierVersion)
	}
	if ev.CallID != "c1" || ev.Type != "tool_call" {
		t.Fatal("enrichment must not rewrite identity or type")
	}
	snap := sm.turnMetrics.Snapshot()
	if snap["unassigned_events"] != 1 {
		t.Errorf("unassigned_events = %d, want 1 (content without a turn anchor)", snap["unassigned_events"])
	}

	// A turn-stamped content event does not count as unassigned.
	stamped := protocol.DaemonEvent{Type: "agent_text", TurnID: "turn:v1:codex:x"}
	sm.EnrichOutgoingEvent(&stamped)
	if sm.turnMetrics.Snapshot()["unassigned_events"] != 1 {
		t.Error("stamped content must not increment the unassigned counter")
	}

	// Already-classified events are not re-stamped (producers keep ownership).
	pre := protocol.DaemonEvent{Type: "agent_text", ClassifierVersion: "v1", FlowScope: "main"}
	sm.EnrichOutgoingEvent(&pre)
	if pre.FlowScope != "main" {
		t.Fatal("existing classification must be preserved")
	}
}

func TestEnrichOutgoingEventOffModeIsNoOp(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sm.turnMode = turnEnrichmentOff
	ev := protocol.DaemonEvent{Type: "agent_text"}
	sm.EnrichOutgoingEvent(&ev)
	if ev.ClassifierVersion != "" || ev.FlowScope != "" {
		t.Fatal("off mode must not attach classification")
	}
	if sm.turnMetrics.Snapshot()["unassigned_events"] != 0 {
		t.Fatal("off mode must not count unassigned events")
	}
}
