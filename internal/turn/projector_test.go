package turn

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestStatusEventShape(t *testing.T) {
	rec := TurnRecord{
		Actor:              ActorKey{SessionID: "sess-1", AgentID: "agent-1"},
		TurnID:             "turn:v1:codex:t1",
		SourceTurnID:       "native-1",
		State:              protocol.TurnStateRunning,
		Origin:             protocol.TurnOriginNative,
		Confidence:         protocol.TurnConfidenceNative,
		PreviousTurnID:     "turn:v1:codex:t0",
		ContinuationReason: protocol.ContinuationReasonAfterInterrupt,
	}
	ev := StatusEvent(rec, protocol.TurnStateInterruptRequested, "user_requested")

	if ev.Type != protocol.EventTypeTurnStatus {
		t.Errorf("type = %s", ev.Type)
	}
	if ev.SessionID != "sess-1" || ev.AgentID != "agent-1" {
		t.Errorf("session/actor = %s/%s", ev.SessionID, ev.AgentID)
	}
	if ev.TurnID != rec.TurnID || ev.SourceTurnID != "native-1" {
		t.Errorf("identity = %s/%s", ev.TurnID, ev.SourceTurnID)
	}
	if ev.TurnStatus != protocol.TurnStateInterruptRequested || ev.TurnReason != "user_requested" {
		t.Errorf("status/reason = %s/%s", ev.TurnStatus, ev.TurnReason)
	}
	if ev.TurnOrigin != protocol.TurnOriginNative || ev.TurnConfidence != protocol.TurnConfidenceNative {
		t.Errorf("origin/confidence = %s/%s", ev.TurnOrigin, ev.TurnConfidence)
	}
	if ev.PreviousTurnID != "turn:v1:codex:t0" || ev.ContinuationReason != protocol.ContinuationReasonAfterInterrupt {
		t.Errorf("continuation = %s/%s", ev.PreviousTurnID, ev.ContinuationReason)
	}
	if ev.ActorScope != protocol.ActorScopeSubagent {
		t.Errorf("actor scope = %s", ev.ActorScope)
	}
	if ev.FlowScope != protocol.FlowScopeAuxiliary || ev.ContentClass != protocol.ContentClassLifecycle {
		t.Errorf("flow/class = %s/%s", ev.FlowScope, ev.ContentClass)
	}
	if ev.ClassifierVersion != protocol.ClassifierVersionV1 {
		t.Errorf("classifier version = %s", ev.ClassifierVersion)
	}
}

func TestStatusEventRootActorAndNoReason(t *testing.T) {
	rec := TurnRecord{Actor: ActorKey{SessionID: "s"}, TurnID: "t", Origin: protocol.TurnOriginRequest, Confidence: protocol.TurnConfidenceDerived}
	ev := StatusEvent(rec, protocol.TurnStateRunning, "")
	if ev.AgentID != "" {
		t.Errorf("root actor has no agent id, got %q", ev.AgentID)
	}
	if ev.ActorScope != protocol.ActorScopeRoot {
		t.Errorf("actor scope = %s", ev.ActorScope)
	}
	if ev.TurnReason != "" {
		t.Errorf("empty reason must stay empty, got %q", ev.TurnReason)
	}
}

func TestStatusEventIDStableAndStateSuffixed(t *testing.T) {
	a := StatusEventID("turn:v1:codex:t1", protocol.TurnStateCompleted)
	b := StatusEventID("turn:v1:codex:t1", protocol.TurnStateCompleted)
	if a != b || a == "" {
		t.Fatalf("event id must be stable: %q vs %q", a, b)
	}
	if got := StatusEventID("turn:v1:codex:t1", protocol.TurnStateRunning); got == a {
		t.Error("different states must derive different ids")
	}
	for _, state := range []string{protocol.TurnStateRunning, protocol.TurnStateCompleted, protocol.TurnStateInterrupted} {
		id := StatusEventID("t", state)
		if id[:5] != "turn:" {
			t.Errorf("id %q must start with turn:", id)
		}
		if id[len(id)-len(":status:"+state):] != ":status:"+state {
			t.Errorf("id %q must end with :status:%s", id, state)
		}
	}
}

func TestEnrichBindsIdentityOnly(t *testing.T) {
	rec := TurnRecord{
		Actor:        ActorKey{SessionID: "s"},
		TurnID:       "turn:v1:codex:t1",
		SourceTurnID: "native-1",
		Origin:       protocol.TurnOriginNative,
		Confidence:   protocol.TurnConfidenceNative,
	}
	ev := &protocol.DaemonEvent{Type: "agent_text", Text: "body", EventID: "jsonl:x:1:0"}
	Enrich(ev, rec)
	if ev.TurnID != rec.TurnID || ev.SourceTurnID != "native-1" || ev.TurnOrigin != protocol.TurnOriginNative {
		t.Errorf("identity not bound: %+v", ev)
	}
	if ev.EventID != "jsonl:x:1:0" || ev.Text != "body" || ev.Type != "agent_text" {
		t.Error("enrich must not touch existing identity or content fields")
	}

	// Existing enrichment is never overwritten.
	ev2 := &protocol.DaemonEvent{SourceTurnID: "native-keep", TurnOrigin: protocol.TurnOriginSourceMessage}
	Enrich(ev2, rec)
	if ev2.SourceTurnID != "native-keep" || ev2.TurnOrigin != protocol.TurnOriginSourceMessage {
		t.Error("enrich must respect pre-bound source identity")
	}

	// Empty record and nil event are no-ops.
	Enrich(&protocol.DaemonEvent{}, TurnRecord{})
	Enrich(nil, rec)
}
