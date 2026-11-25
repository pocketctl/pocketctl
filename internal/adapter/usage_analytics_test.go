package adapter

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
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

func TestCodexReceiptEnrichesOnlyTheMatchingTokenCount(t *testing.T) {
	const last = `{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":120}`
	const total = `{"input_tokens":800,"cached_input_tokens":280,"cache_write_input_tokens":0,"output_tokens":55,"reasoning_output_tokens":15,"total_tokens":855}`
	receipt := fmt.Sprintf(`{"type":"token_usage_record","payload":{"thread_id":"thread","turn_id":"turn","response_id":"native-response-id","usage":%s,"thread_token_usage":%s}}`, last, total)
	count := fmt.Sprintf(`{"type":"event_msg","timestamp":"2026-11-25T10:00:01Z","payload":{"type":"token_count","info":{"last_token_usage":%s,"total_token_usage":%s}}}`, last, total)
	for _, entry := range []string{"rollout", "stream"} {
		t.Run(entry, func(t *testing.T) {
			parse := NewCodexJSONLParser().Parse
			if entry == "stream" {
				parse = NewCodexAdapter().ParseStreamLine
			}
			for _, raw := range []string{
				`{"type":"session_meta","payload":{"id":"thread"}}`,
				`{"type":"turn_context","payload":{"model":"source-model"}}`,
				`{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}`,
			} {
				if _, err := parse(raw); err != nil {
					t.Fatal(err)
				}
			}
			for _, tc := range []struct{ receipt, count, wantID string }{
				{receipt, count, "native-response-id"},
				{"", strings.Replace(count, "10:00:01Z", "10:20:01Z", 1), "native-response-id"},
				{"", strings.Replace(count, `"total_tokens":855`, `"total_tokens":859`, 1), ""},
				{"", count, ""}, // A mismatched cumulative counter invalidated the receipt.
				{strings.Replace(receipt, `"thread_id":"thread"`, `"thread_id":"foreign"`, 1), count, ""},
				{strings.Replace(receipt, `"turn_id":"turn"`, `"turn_id":"old"`, 1), count, ""},
				{strings.ReplaceAll(receipt, `"cache_write_input_tokens":0`, `"cache_write_input_tokens":10`), strings.ReplaceAll(count, `"cache_write_input_tokens":0`, `"cache_write_input_tokens":10`), ""},
				{strings.Replace(receipt, `"total_tokens":855`, `"total_tokens":856`, 1), count, ""},
				{strings.Replace(receipt, `"reasoning_output_tokens":5`, `"reasoning_output_tokens":6`, 1), count, ""},
			} {
				if tc.receipt != "" {
					extra, err := parse(tc.receipt)
					if err != nil || len(extra) != 0 {
						t.Fatalf("receipt separately emitted: %+v, %v", extra, err)
					}
				}
				ev, err := parse(tc.count)
				if err != nil || len(ev) != 1 || ev[0].Usage == nil || ev[0].UsageMeta == nil {
					t.Fatalf("count lost: %+v, %v", ev, err)
				}
				want := protocol.ContextUsage{InputTokens: 100, CacheRead: 40, OutputTokens: 20, ReasoningTokens: 5, TotalTokens: 120}
				if *ev[0].Usage != want {
					t.Fatalf("wrong counters: %+v", ev[0].Usage)
				}
				m := ev[0].UsageMeta
				if m.SourceUsageID != tc.wantID || m.RequestID != "" || m.Model != "source-model" || m.InputSemantics != "includes_cache" || m.OccurredAt != "2026-11-25T10:00:01Z" {
					t.Fatalf("wrong identity or scope: %+v", m)
				}
			}
			for _, raw := range []string{receipt, count, `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}}`, `{"type":"event_msg","payload":{"type":"task_started","turn_id":"next-turn"}}`} {
				if _, err := parse(raw); err != nil {
					t.Fatal(err)
				}
			}
			if ev, err := parse(count); err != nil || len(ev) != 1 || ev[0].UsageMeta.SourceUsageID != "" {
				t.Fatalf("carried a receipt across turns: %+v, %v", ev, err)
			}
		})
	}
}
