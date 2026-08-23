package protocol

import (
	"encoding/json"
	"testing"
)

// Stage-1 contract: the new optional turn/classification fields must not
// serialize when empty, and legacy event JSON must round-trip unchanged.
func TestDaemonEventTurnFieldsOmittedWhenEmpty(t *testing.T) {
	raw, err := json.Marshal(DaemonEvent{Type: "agent_text", SessionID: "s"})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{
		"source_turn_id", "turn_status", "turn_reason", "turn_origin",
		"turn_confidence", "previous_turn_id", "continuation_reason",
		"actor_scope", "flow_scope", "content_class", "classifier_version",
	} {
		if stringContainsKey(raw, field) {
			t.Errorf("empty field %s must not serialize: %s", field, raw)
		}
	}
}

func stringContainsKey(raw []byte, key string) bool {
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	_, ok := m[key]
	return ok
}

func TestDaemonEventTurnFieldsRoundTrip(t *testing.T) {
	ev := DaemonEvent{
		Type:               EventTypeTurnStatus,
		SessionID:          "s",
		TurnID:             "turn:v1:codex:t1",
		SourceTurnID:       "native-1",
		TurnStatus:         TurnStateInterruptRequested,
		TurnReason:         TurnReasonUserRequested,
		TurnOrigin:         TurnOriginNative,
		TurnConfidence:     TurnConfidenceNative,
		PreviousTurnID:     "turn:v1:codex:t0",
		ContinuationReason: ContinuationReasonAfterInterrupt,
		ActorScope:         ActorScopeRoot,
		FlowScope:          FlowScopeAuxiliary,
		ContentClass:       ContentClassLifecycle,
		ClassifierVersion:  ClassifierVersionV1,
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var back DaemonEvent
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if back.Type != ev.Type || back.TurnID != ev.TurnID || back.SourceTurnID != ev.SourceTurnID ||
		back.TurnStatus != ev.TurnStatus || back.TurnReason != ev.TurnReason ||
		back.TurnOrigin != ev.TurnOrigin || back.TurnConfidence != ev.TurnConfidence ||
		back.PreviousTurnID != ev.PreviousTurnID || back.ContinuationReason != ev.ContinuationReason ||
		back.ActorScope != ev.ActorScope || back.FlowScope != ev.FlowScope ||
		back.ContentClass != ev.ContentClass || back.ClassifierVersion != ev.ClassifierVersion {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", back, ev)
	}
}

// A legacy payload (no new fields) decodes with the new struct unchanged.
func TestDaemonEventLegacyPayloadDecodesWithNewFields(t *testing.T) {
	legacy := `{"type":"user_text","session_id":"s","text":"hi","request_id":"r1"}`
	var ev DaemonEvent
	if err := json.Unmarshal([]byte(legacy), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Type != "user_text" || ev.SessionID != "s" || ev.Text != "hi" || ev.RequestID != "r1" {
		t.Errorf("legacy decode = %+v", ev)
	}
	if ev.TurnID != "" || ev.TurnStatus != "" || ev.ActorScope != "" {
		t.Error("new fields must default to empty on legacy payloads")
	}
}
