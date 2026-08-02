package adapter

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestParseCodexPlanToolCallAcceptsObservedExecLiteral(t *testing.T) {
	source := `const p = await tools.update_plan({plan:[
		{step:"Inspect \"wire\" format",status:"completed"},
		{step:'Build iOS sheet',status:'in_progress'},
		{step:"  ",status:"pending"}
	],explanation:"Render clients"});
	text(p);`
	raw, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}

	got, err := parseCodexPlanToolCall("exec", raw)
	if err != nil {
		t.Fatalf("parse observed exec plan: %v", err)
	}
	want := []protocol.PlanItem{
		{Step: `Inspect "wire" format`, Status: protocol.PlanCompleted},
		{Step: "Build iOS sheet", Status: protocol.PlanInProgress},
	}
	if got.Explanation != "Render clients" || len(got.Plan) != len(want) {
		t.Fatalf("plan = %+v", got)
	}
	for i := range want {
		if got.Plan[i] != want[i] {
			t.Fatalf("plan[%d] = %+v, want %+v", i, got.Plan[i], want[i])
		}
	}
}

func TestParseCodexPlanToolCallAcceptsDirectJSONObject(t *testing.T) {
	raw := json.RawMessage(`{"explanation":"Direct","plan":[{"step":"Ship","status":"pending"}]}`)
	got, err := parseCodexPlanToolCall("update_plan", raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Explanation != "Direct" || len(got.Plan) != 1 || got.Plan[0].Step != "Ship" {
		t.Fatalf("plan = %+v", got)
	}
}

func TestParseCodexPlanToolCallFailsClosed(t *testing.T) {
	tests := []struct {
		name   string
		tool   string
		source string
	}{
		{name: "dynamic plan", tool: "exec", source: `tools.update_plan(buildPlan())`},
		{name: "variable steps", tool: "exec", source: `tools.update_plan({plan:steps})`},
		{name: "template expression", tool: "exec", source: "tools.update_plan({plan:[{step:`run ${target}`,status:'pending'}]})"},
		{name: "unknown status", tool: "exec", source: `tools.update_plan({plan:[{step:"A",status:"cancelled"}]})`},
		{name: "multiple calls", tool: "exec", source: `tools.update_plan({plan:[{step:"A",status:"pending"}]}); tools.update_plan({plan:[{step:"B",status:"pending"}]})`},
		{name: "empty effective plan", tool: "exec", source: `tools.update_plan({plan:[{step:" ",status:"pending"}]})`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := json.Marshal(tt.source)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := parseCodexPlanToolCall(tt.tool, raw); err == nil {
				t.Fatalf("unsafe input accepted: %s", tt.source)
			}
		})
	}

	oversized, err := json.Marshal(`tools.update_plan({plan:[{step:"` + strings.Repeat("x", codexPlanMaxStepBytes+1) + `",status:"pending"}]})`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseCodexPlanToolCall("exec", oversized); err == nil {
		t.Fatal("oversized step accepted")
	}
}

func TestCodexPlanProjectionKeepsToolCallAndBuildsCausalSnapshots(t *testing.T) {
	parser := NewCodexJSONLParser()
	first := codexPlanResponseLine(t, "call-1", `const p = await tools.update_plan({plan:[{step:"Parse",status:"in_progress"}]}); text(p);`)
	second := codexPlanResponseLine(t, "call-2", `const p = await tools.update_plan({explanation:"Next",plan:[{step:"Parse",status:"completed"},{step:"Render",status:"in_progress"}]}); text(p);`)

	firstEvents, err := parser.Parse(first)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstEvents) != 2 || firstEvents[0].Type != "tool_call" || firstEvents[1].Type != "agent_plan" {
		t.Fatalf("first events = %+v", firstEvents)
	}
	if firstEvents[1].EventID != "codex:plan:call-1" || firstEvents[1].PreviousEventID != "" || firstEvents[1].Revision != 1 {
		t.Fatalf("first identity = %+v", firstEvents[1])
	}

	secondEvents, err := parser.Parse(second)
	if err != nil {
		t.Fatal(err)
	}
	if len(secondEvents) != 2 || secondEvents[1].EventID != "codex:plan:call-2" ||
		secondEvents[1].PreviousEventID != "codex:plan:call-1" || secondEvents[1].Revision != 2 {
		t.Fatalf("second events = %+v", secondEvents)
	}
	if secondEvents[1].Explanation != "Next" || len(secondEvents[1].Plan) != 2 {
		t.Fatalf("second plan = %+v", secondEvents[1])
	}

	duplicate, err := parser.Parse(second)
	if err != nil {
		t.Fatal(err)
	}
	if len(duplicate) != 2 || duplicate[1].Revision != 2 || duplicate[1].PreviousEventID != "codex:plan:call-1" {
		t.Fatalf("duplicate changed identity = %+v", duplicate)
	}
}

func TestCodexPlanProjectionLeavesMalformedExecAsOrdinaryToolCall(t *testing.T) {
	parser := NewCodexJSONLParser()
	events, err := parser.Parse(codexPlanResponseLine(t, "call-bad", `tools.update_plan({plan:steps})`))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "tool_call" || events[0].Tool != "exec" {
		t.Fatalf("events = %+v", events)
	}
}

func codexPlanResponseLine(t *testing.T, callID, source string) string {
	t.Helper()
	payload := map[string]any{
		"type": "custom_tool_call", "call_id": callID, "name": "exec", "input": source,
	}
	line, err := json.Marshal(map[string]any{"type": "response_item", "payload": payload})
	if err != nil {
		t.Fatal(err)
	}
	return string(line)
}
