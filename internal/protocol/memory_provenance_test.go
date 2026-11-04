package protocol

import (
	"encoding/json"
	"testing"
)

func TestMemoryProvenanceRoundTrip(t *testing.T) {
	raw := []byte(`{"type":"user_text","session_id":"s","memory_source":{"version":1,"producer":"claude","session_id":"s","turn_id":"t","event_id":"e","sequence":"1","invocation_id":"i","source_role":"user","skill_state":"non_skill","lineage_complete":true,"derived_from_event_ids":[]}}`)
	var event DaemonEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	json.Unmarshal(encoded, &object)
	if object["memory_source"] == nil {
		t.Fatal("source provenance lost on event transport")
	}
	var old struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(encoded, &old) != nil || old.Type != "user_text" {
		t.Fatal("old decoder cannot read new event")
	}
}
