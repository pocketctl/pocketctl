package zcode

import "testing"

func TestPersonalUsageStablePartRevision(t *testing.T) {
	m := NewMapper("fixture-source")
	e, _ := m.MapPart("session", "message", "native-part", ZcodePartData{Type: "step-finish", Usage: &ZcodeUsage{InputTokens: 100, OutputTokens: 20, TotalTokens: 120}}, "actual-model", "", 2)
	if e.UsageMeta == nil || e.UsageMeta.SourceUsageID != "native-part" || e.UsageMeta.Model != "actual-model" || e.UsageMeta.Revision != 2 || e.UsageMeta.InputSemantics != "unknown" {
		t.Fatalf("%+v", e.UsageMeta)
	}
}

func TestPersonalUsageNativeErrorWithoutBody(t *testing.T) {
	m := NewMapper("fixture")
	event, _ := m.MapPart("s", "m", "p", ZcodePartData{Type: "tool", CallID: "call", State: &ZcodeToolState{Status: "error"}}, "model", "", 1)
	if event.CallMeta == nil || event.CallMeta.Outcome != "failure" {
		t.Fatalf("explicit native failure lost: %+v", event)
	}
}
