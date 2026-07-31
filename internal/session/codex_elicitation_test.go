package session

import (
	"encoding/json"
	"testing"
)

func TestMcpFormAcceptsTitledMultiSelectSchema(t *testing.T) {
	schema := json.RawMessage(`{
		"type":"object",
		"properties":{"regions":{"type":"array","items":{"anyOf":[
			{"const":"us","title":"United States"},
			{"const":"eu","title":"Europe"}
		]}}}
	}`)
	if err := validateMcpFormContent(schema, json.RawMessage(`{"regions":["us","eu"]}`)); err != nil {
		t.Fatalf("valid titled multi-select was rejected: %v", err)
	}
}

func TestMcpFormValidatesStringFormats(t *testing.T) {
	tests := []struct {
		name   string
		format string
		value  string
	}{
		{name: "email", format: "email", value: "not an email"},
		{name: "uri", format: "uri", value: "://missing-scheme"},
		{name: "date", format: "date", value: "2026-02-30"},
		{name: "date-time", format: "date-time", value: "tomorrow"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			schema := json.RawMessage(`{"type":"object","properties":{"value":{"type":"string","format":"` + tt.format + `"}}}`)
			content, _ := json.Marshal(map[string]string{"value": tt.value})
			if err := validateMcpFormContent(schema, content); err == nil {
				t.Fatalf("invalid %s value was accepted", tt.format)
			}
		})
	}
}

func TestMcpFormRejectsTrailingJSONContent(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"name":{"type":"string"}}}`)
	if err := validateMcpFormContent(schema, json.RawMessage(`{"name":"safe"} {"name":"hidden"}`)); err == nil {
		t.Fatal("trailing JSON content was accepted")
	}
}
