package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOpenCodeInteractionRaceResolvedElsewhereWireContract(t *testing.T) {
	if InteractionResolvedElsewhere != "resolved_elsewhere" {
		t.Fatalf("code=%q", InteractionResolvedElsewhere)
	}
	event := DaemonEvent{
		Type: "interaction_result", SessionID: "ses_1", RequestID: "per_1",
		Operation: "approval_response", Status: InteractionResolvedElsewhere, Reason: InteractionResolvedElsewhere,
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	wire := string(raw)
	for _, want := range []string{`"type":"interaction_result"`, `"request_id":"per_1"`, `"status":"resolved_elsewhere"`, `"reason":"resolved_elsewhere"`} {
		if !strings.Contains(wire, want) {
			t.Fatalf("wire=%s missing %s", wire, want)
		}
	}
}
