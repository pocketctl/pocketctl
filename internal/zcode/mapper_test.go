package zcode

import (
	"strings"
	"testing"
)

const testSourceID = "aabbccddeeff00112233445566778899"

func TestMapper_SessionDiscovered_Fields(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev := mp.SessionDiscovered("zcode-wire1", "title", "/cwd", "anthropic/claude", "completed")
	if ev.Type != "session_discovered" || ev.Agent != "zcode" || ev.Source != "observer" {
		t.Fatalf("discovered fields: %+v", ev)
	}
	if ev.ControlMode != "legacy_read_only" {
		t.Fatalf("control_mode = %q", ev.ControlMode)
	}
	if len(ev.Capabilities) != 1 || ev.Capabilities[0] != "history_sync" {
		t.Fatalf("capabilities = %v", ev.Capabilities)
	}
	if !strings.HasPrefix(ev.EventID, "zcode:") {
		t.Fatalf("event id must be zcode-namespaced: %q", ev.EventID)
	}
	if strings.Contains(ev.EventID, "zcode-wire1") {
		t.Fatalf("event id must not contain wire id plaintext: %q", ev.EventID)
	}
}

func TestMapper_MapPart_TextAndReasoning(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev, reason := mp.MapPart("zcode-wire1", "msg1", "p1", ZcodePartData{Type: "text", Text: "hello"}, "anthropic/claude", "", 1)
	if reason != "" || ev.Type != "agent_text" || ev.Text != "hello" {
		t.Fatalf("text part: reason=%q ev=%+v", reason, ev)
	}
	if !ev.Replace || ev.Snapshot != "hello" {
		t.Fatalf("text must use Replace+Snapshot: %+v", ev)
	}
	ev2, reason := mp.MapPart("zcode-wire1", "msg1", "p2", ZcodePartData{Type: "reasoning", Reasoning: "thinking"}, "anthropic/claude", "", 1)
	if reason != "" || ev2.Type != "agent_reasoning" || ev2.Text != "thinking" {
		t.Fatalf("reasoning part: %+v", ev2)
	}
}

func TestMapper_MapPart_EmptyTextSkipped(t *testing.T) {
	mp := NewMapper(testSourceID)
	if _, reason := mp.MapPart("w", "m", "p", ZcodePartData{Type: "text", Text: "  "}, "", "", 1); reason != "skip" {
		t.Fatal("empty text should skip")
	}
}

func TestMapper_MapPart_ToolLifecycle(t *testing.T) {
	mp := NewMapper(testSourceID)
	tests := []struct {
		state string
		want  string
	}{
		{"pending", "tool_call"},
		{"running", "tool_call"},
		{"completed", "tool_result"},
		{"error", "tool_result"},
	}
	for _, tt := range tests {
		t.Run(tt.state, func(t *testing.T) {
			ev, reason := mp.MapPart("w", "m", "p1", ZcodePartData{
				Type:   "tool",
				Tool:   "bash",
				CallID: "call1",
				State:  &ZcodeToolState{Status: tt.state},
			}, "", "", 1)
			if reason != "" {
				t.Fatalf("reason = %q", reason)
			}
			if ev.Type != tt.want {
				t.Fatalf("type = %s want %s", ev.Type, tt.want)
			}
			if ev.CallID != "call1" {
				t.Fatalf("call id lost: %q", ev.CallID)
			}
		})
	}
}

func TestMapper_MapPart_ToolWithoutCallIDSkipped(t *testing.T) {
	mp := NewMapper(testSourceID)
	if _, reason := mp.MapPart("w", "m", "p", ZcodePartData{Type: "tool", Tool: "bash"}, "", "", 1); reason != "skip" {
		t.Fatal("tool without callID should skip")
	}
}

func TestMapper_MapPart_FileClearsURLAndSource(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev, reason := mp.MapPart("w", "m", "p1", ZcodePartData{
		Type: "file",
		File: &ZcodeFile{Filename: "/secret/dir/file.txt", Mime: "text/plain", URL: "file:///x", Source: "disk"},
	}, "", "", 1)
	if reason != "" {
		t.Fatalf("reason = %q", reason)
	}
	if ev.Type != "agent_file" {
		t.Fatalf("type = %s", ev.Type)
	}
	if ev.Filename != "file.txt" {
		t.Fatalf("filename must be basename only: %q", ev.Filename)
	}
	if ev.URL != "" {
		t.Fatal("URL must be cleared")
	}
	if ev.PartSource != nil {
		t.Fatal("PartSource must be cleared")
	}
}

func TestMapper_MapPart_FileLengthLimits(t *testing.T) {
	mp := NewMapper(testSourceID)
	longName := strings.Repeat("a", maxFileBasename+50)
	longMime := strings.Repeat("b", maxFileMime+50)
	ev, _ := mp.MapPart("w", "m", "p", ZcodePartData{
		Type: "file", File: &ZcodeFile{Filename: longName, Mime: longMime},
	}, "", "", 1)
	if len(ev.Filename) > maxFileBasename {
		t.Fatalf("basename not limited: %d", len(ev.Filename))
	}
	if len(ev.Mime) > maxFileMime {
		t.Fatalf("mime not limited: %d", len(ev.Mime))
	}
}

func TestMapper_MapPart_UnknownTypeDoesNotUploadJSON(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev, reason := mp.MapPart("w", "m", "p", ZcodePartData{Type: "timeline", Text: "secret"}, "", "", 1)
	if reason != "unknown" {
		t.Fatalf("unknown type reason = %q want unknown", reason)
	}
	if ev.Type != "" {
		t.Fatalf("unknown type must not produce an event: %+v", ev)
	}
}

func TestMapper_MapPart_StepStartNoContent(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev, reason := mp.MapPart("w", "m", "p", ZcodePartData{Type: "step-start"}, "", "", 1)
	if reason != "step-start" || ev.Type != "" {
		t.Fatalf("step-start reason=%q ev=%+v", reason, ev)
	}
}

func TestMapper_MapPart_StepFinishUsage(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev, reason := mp.MapPart("w", "m", "p", ZcodePartData{Type: "step-finish", Usage: &ZcodeUsage{InputTokens: 100, OutputTokens: 50, ReasoningTokens: 20, TotalTokens: 150}}, "", "", 1)
	if reason != "" || ev.Type != "agent_text" {
		t.Fatalf("step-finish: reason=%q ev=%+v", reason, ev)
	}
	if ev.Usage == nil || ev.Usage.InputTokens != 100 || ev.Usage.OutputTokens != 50 || ev.Usage.ReasoningTokens != 20 || ev.Usage.TotalTokens != 150 {
		t.Fatalf("usage not carried: %+v", ev.Usage)
	}
}

func TestMapper_EventIDNamespaceAndStability(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev1, _ := mp.MapPart("w", "m", "p1", ZcodePartData{Type: "text", Text: "same"}, "", "", 1)
	ev2, _ := mp.MapPart("w", "m", "p1", ZcodePartData{Type: "text", Text: "same"}, "", "", 1)
	if ev1.EventID != ev2.EventID {
		t.Fatalf("same content must yield same event id: %q vs %q", ev1.EventID, ev2.EventID)
	}
	if !strings.HasPrefix(ev1.EventID, "zcode:"+testSourceID[:12]+":") {
		t.Fatalf("event id namespace wrong: %q", ev1.EventID)
	}
	if strings.Contains(ev1.EventID, "p1") {
		t.Fatalf("event id must not contain native part id plaintext: %q", ev1.EventID)
	}
}

func TestMapper_TodoClearProducesEvent(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev := mp.MapTodo("w", []TodoRow{{Content: "a", Status: "pending"}}, "")
	if ev.Type != "agent_todo" || len(ev.Todos) != 1 {
		t.Fatalf("todo event: %+v", ev)
	}
}

func TestMapper_SessionStatusEvent(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev := mp.SessionStatus("zcode-wire1", "running", "prev-evt")
	if ev.Type != "session_status" || ev.Status != "running" {
		t.Fatalf("status event: %+v", ev)
	}
	if ev.Agent != "zcode" || ev.Source != "observer" {
		t.Fatalf("agent/source wrong: %+v", ev)
	}
	if ev.PreviousEventID != "prev-evt" {
		t.Fatalf("prevEventID = %q", ev.PreviousEventID)
	}
	if !strings.HasPrefix(ev.EventID, "zcode:") {
		t.Fatalf("event id not namespaced: %q", ev.EventID)
	}
	// Same status → same event id (stable)
	ev2 := mp.SessionStatus("zcode-wire1", "running", "prev-evt")
	if ev2.EventID != ev.EventID {
		t.Fatalf("same status must yield same event id: %q vs %q", ev.EventID, ev2.EventID)
	}
}

func TestMapper_SubagentDiscovered(t *testing.T) {
	mp := NewMapper(testSourceID)
	ev := mp.SubagentDiscovered("zcode-parent1", "zcode-child1", "zcode-explore", "Explore task", "prev-evt")
	if ev.Type != "subagent_discovered" {
		t.Fatalf("type = %s", ev.Type)
	}
	if ev.SessionID != "zcode-parent1" {
		t.Fatalf("SessionID should be parent: %s", ev.SessionID)
	}
	if ev.AgentID != "zcode-child1" {
		t.Fatalf("AgentID should be child: %s", ev.AgentID)
	}
	if ev.ParentSessionID != "zcode-parent1" || ev.RootSessionID != "zcode-parent1" {
		t.Fatalf("parent/root wrong: %+v", ev)
	}
	if !ev.IsSubagent {
		t.Fatal("IsSubagent must be true")
	}
	if ev.SubAgentType != "zcode-explore" || ev.SubAgentDesc != "Explore task" {
		t.Fatalf("subagent type/desc wrong: %+v", ev)
	}
	if ev.Agent != "zcode" {
		t.Fatalf("agent = %s want zcode", ev.Agent)
	}
	if !strings.HasPrefix(ev.EventID, "zcode:") {
		t.Fatalf("event id not namespaced: %q", ev.EventID)
	}
	// Stable
	ev2 := mp.SubagentDiscovered("zcode-parent1", "zcode-child1", "zcode-explore", "Explore task", "")
	if ev2.EventID != ev.EventID {
		t.Fatalf("same parent+child must yield same event id: %q vs %q", ev.EventID, ev2.EventID)
	}
}
