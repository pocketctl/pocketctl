package adapter

import (
	"encoding/json"
	"testing"
)

func TestPersonalUsageClaudeMessageOnceAndNativeSkill(t *testing.T) {
	raw := ClaudeStreamEvent{Message: &ClaudeMessage{ID: "msg-1", Model: "model-a", Content: []ClaudeContent{{Type: "text", Text: "first"}, {Type: "text", Text: "second"}, {Type: "tool_use", ID: "call-read", Name: "Read", Input: json.RawMessage(`{"file_path":"SKILL.md"}`)}, {Type: "tool_use", ID: "call-skill", Name: "Skill", Input: json.RawMessage(`{"skill":"review"}`)}}, Usage: &TokenUsage{InputTokens: 100, OutputTokens: 20, CacheRead: 40}}}
	events, err := (&ClaudeAdapter{}).convertAssistant(raw, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	skills := 0
	for _, e := range events {
		if e.Usage != nil {
			count++
			if e.UsageMeta == nil || e.UsageMeta.SourceUsageID != "msg-1" || e.UsageMeta.Model != "model-a" {
				t.Fatalf("metadata %+v", e.UsageMeta)
			}
		}
		if e.CallMeta != nil && e.CallMeta.EvidenceKind == "native_skill_execution" {
			skills++
		}
	}
	if count != 1 || skills != 1 {
		t.Fatalf("usage=%d skills=%d", count, skills)
	}
}
func TestPersonalUsageCodexDoesNotInventRequestIdentity(t *testing.T) {
	p := NewCodexJSONLParser()
	p.Parse(`{"timestamp":"2026-11-14T10:00:00Z","type":"turn_context","payload":{"model":"source-model"}}`)
	events, err := p.Parse(`{"timestamp":"2026-11-14T10:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":40}}}}`)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if e.Usage != nil {
			if e.UsageMeta == nil || e.UsageMeta.SourceUsageID != "" || e.UsageMeta.RequestID != "" || e.UsageMeta.Model != "source-model" {
				t.Fatalf("unexpected identity %+v", e.UsageMeta)
			}
			return
		}
	}
	t.Fatal("usage missing")
}
func TestPersonalUsageOpenCodePartAndExplicitOutcome(t *testing.T) {
	p, err := ParseOpencodePart([]byte(`{"id":"part-usage","type":"step-finish","time":{"created":1794650400000},"tokens":{"input":100,"output":20,"cache":{"read":40,"write":5}}}`))
	if err != nil {
		t.Fatal(err)
	}
	e := ConvertOpencodePart(p, "assistant", "actual-model")
	if len(e) != 1 || e[0].UsageMeta == nil || e[0].UsageMeta.SourceUsageID != "part-usage" || e[0].UsageMeta.InputSemantics != "unknown" {
		t.Fatalf("%+v", e)
	}
	p, err = ParseOpencodePart([]byte(`{"id":"part-tool","type":"tool","callID":"call-1","tool":"server/read","state":{"status":"completed","output":"body excluded from analytics"}}`))
	if err != nil {
		t.Fatal(err)
	}
	e = ConvertOpencodePart(p, "assistant", "actual-model")
	if e[0].CallMeta == nil || e[0].CallMeta.Outcome != "success" || e[0].CallMeta.ToolKind != "unknown" {
		t.Fatalf("%+v", e[0])
	}
}

func TestPersonalUsageClaudeRevisionUsesNativeTimeNotTokenAmount(t *testing.T) {
	makeEntry := func(at string, input, output, cache int) JSONLEntry {
		return JSONLEntry{Timestamp: at, UUID: "record", Message: &JSONLMessage{ID: "message", Model: "m", Content: json.RawMessage(`[{"type":"text","text":"first"},{"type":"text","text":"second"}]`), Usage: &TokenUsage{InputTokens: input, OutputTokens: output, CacheRead: cache}}}
	}
	a, _ := parseAssistantJSONL(makeEntry("2026-11-14T10:00:00.000001Z", 100, 20, 40), "fixture")
	b, _ := parseAssistantJSONL(makeEntry("2026-11-14T10:00:00.000002Z", 90, 20, 30), "fixture")
	c, _ := parseAssistantJSONL(makeEntry("2026-11-14T10:00:00.000003Z", 90, 15, 30), "fixture")
	if a[0].UsageMeta.Revision >= b[0].UsageMeta.Revision || b[0].UsageMeta.Revision >= c[0].UsageMeta.Revision {
		t.Fatal("token counts used instead of source order")
	}
}

func TestPersonalUsageClaudeToolAndThinkingOnlyStillAccountOnce(t *testing.T) {
	for _, content := range []string{`[{"type":"tool_use","id":"tool-only","name":"Read","input":{"file_path":"SKILL.md"}}]`, `[{"type":"thinking","thinking":"omitted"}]`} {
		entry := JSONLEntry{Timestamp: "2026-11-14T10:00:00Z", UUID: "native-record", Message: &JSONLMessage{ID: "native-request", Model: "source-model", Content: json.RawMessage(content), Usage: &TokenUsage{InputTokens: 100, OutputTokens: 20, CacheRead: 40}}}
		events, err := parseAssistantJSONL(entry, "fixture")
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, event := range events {
			if event.Usage != nil {
				count++
				if event.UsageMeta == nil || event.UsageMeta.SourceUsageID != "native-request" {
					t.Fatalf("missing evidence %+v", event)
				}
			}
		}
		if count != 1 {
			t.Fatalf("content=%s usage=%d", content, count)
		}
	}
}

func TestPersonalUsageNativeErrorWithoutBody(t *testing.T) {
	for _, output := range []string{"", "partial output"} {
		p, err := ParseOpencodePart([]byte(`{"id":"part","type":"tool","callID":"call","state":{"status":"error","output":"` + output + `","error":""}}`))
		if err != nil {
			t.Fatal(err)
		}
		events := ConvertOpencodePart(p, "assistant", "model")
		if len(events) != 1 || events[0].CallMeta.Outcome != "failure" {
			t.Fatalf("explicit native failure lost: %+v", events)
		}
	}
}
