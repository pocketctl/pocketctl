package adapter

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestParseStreamLine_TextOutput(t *testing.T) {
	a := NewClaudeAdapter("")
	line := `{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Hello!"}]}}`
	events, err := a.ParseStreamLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "agent_text" {
		t.Errorf("expected agent_text, got %s", events[0].Type)
	}
	if events[0].Text != "Hello!" {
		t.Errorf("unexpected text: %s", events[0].Text)
	}
}

func TestParseStreamLine_ToolUse(t *testing.T) {
	a := NewClaudeAdapter("")
	line := `{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"call_abc","name":"Read","input":{"file_path":"main.go"}}]}}`
	events, err := a.ParseStreamLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "tool_call" {
		t.Errorf("expected tool_call, got %s", events[0].Type)
	}
	if events[0].Tool != "Read" {
		t.Errorf("expected Read, got %s", events[0].Tool)
	}
	if events[0].CallID != "call_abc" {
		t.Errorf("expected call_abc, got %s", events[0].CallID)
	}
}

func TestParseStreamLine_Result(t *testing.T) {
	a := NewClaudeAdapter("")
	// Send init first to set session ID
	a.ParseStreamLine(`{"type":"system","subtype":"init","session_id":"abc-123"}`)
	line := `{"type":"result","subtype":"success","is_error":false,"num_turns":2,"total_cost_usd":0.05,"session_id":"abc-123"}`
	events, err := a.ParseStreamLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "session_status" {
		t.Errorf("expected session_status, got %s", events[0].Type)
	}
	if events[0].Status != "completed" {
		t.Errorf("expected completed, got %s", events[0].Status)
	}
	if events[0].SessionID != "abc-123" {
		t.Errorf("expected abc-123, got %s", events[0].SessionID)
	}
}

func TestParseStreamLine_InitEvent(t *testing.T) {
	a := NewClaudeAdapter("")
	line := `{"type":"system","subtype":"init","session_id":"test-session-1","tools":["Read","Edit"]}`
	events, err := a.ParseStreamLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("expected 0 events for init, got %d", len(events))
	}
	if a.SessionID() != "test-session-1" {
		t.Errorf("expected test-session-1, got %s", a.SessionID())
	}
}

func TestParseStreamLine_ResultError(t *testing.T) {
	a := NewClaudeAdapter("")
	line := `{"type":"result","subtype":"error","is_error":true,"num_turns":1,"total_cost_usd":0.01}`
	events, err := a.ParseStreamLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if events[0].Status != "error" {
		t.Errorf("expected error, got %s", events[0].Status)
	}
}

func TestParseStreamLine_EmptyLine(t *testing.T) {
	a := NewClaudeAdapter("")
	events, err := a.ParseStreamLine("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("expected 0 events, got %d", len(events))
	}
}

func TestBuildClaudeArgs_NewSession(t *testing.T) {
	args := BuildClaudeArgs("hello", "", protocol.SessionConfig{})
	if args[0] != "-p" || args[1] != "hello" {
		t.Errorf("expected -p hello, got %v", args[:2])
	}
	found := false
	for i, a := range args {
		if a == "--session-id" {
			found = true
			if args[i+1] == "" {
				t.Error("session-id should not be empty")
			}
		}
	}
	if !found {
		t.Error("expected --session-id flag")
	}
}

func TestExtractFirstAssistantMessage(t *testing.T) {
	lines := []string{
		`{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"帮我写一个React组件"}]}}`,
		`{"type":"assistant","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"好的，我来帮你创建一个React组件"}]}}`,
		`{"type":"assistant","sessionId":"s1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Write","input":{}}]}}`,
	}
	result := ExtractFirstAssistantMessage(lines, 60)
	if result != "好的，我来帮你创建一个React组件" {
		t.Errorf("unexpected result: %s", result)
	}
}

func TestExtractFirstAssistantMessage_ToolUseOnly(t *testing.T) {
	lines := []string{
		`{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"test"}]}}`,
		`{"type":"assistant","sessionId":"s1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}`,
		`{"type":"assistant","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"文件内容如下"}]}}`,
	}
	result := ExtractFirstAssistantMessage(lines, 60)
	if result != "文件内容如下" {
		t.Errorf("expected '文件内容如下', got: %s", result)
	}
}

func TestExtractFirstAssistantMessage_NoAssistant(t *testing.T) {
	lines := []string{
		`{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"test"}]}}`,
	}
	result := ExtractFirstAssistantMessage(lines, 60)
	if result != "" {
		t.Errorf("expected empty, got: %s", result)
	}
}

func TestBuildClaudeArgs_ResumeSession(t *testing.T) {
	args := BuildClaudeArgs("continue", "abc-123", protocol.SessionConfig{})
	found := false
	for i, a := range args {
		if a == "--resume" {
			found = true
			if args[i+1] != "abc-123" {
				t.Errorf("expected resume abc-123, got %s", args[i+1])
			}
		}
	}
	if !found {
		t.Error("expected --resume flag")
	}
}

// --- command_receipt: synthetic reply conversion (design D1-D4) ---

func TestSyntheticReplyBecomesReceipt_Unavailable(t *testing.T) {
	a := NewClaudeAdapter("/model")
	line := `{"type":"assistant","message":{"id":"m1","type":"message","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"/model isn't available in this environment."}]}}`
	events, err := a.ParseStreamLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "command_receipt" {
		t.Fatalf("expected command_receipt (not agent_text), got %s", events[0].Type)
	}
	if events[0].ReceiptStatus != "unavailable" {
		t.Fatalf("expected unavailable, got %s", events[0].ReceiptStatus)
	}
	if events[0].Command != "/model" {
		t.Fatalf("expected /model, got %s", events[0].Command)
	}
}

func TestCompactNotEnoughMessagesBecomesSuccess(t *testing.T) {
	// "Not enough messages to compact" is NOT a real failure — the command
	// ran fine, there was just nothing to compact. It must map to success so
	// the receipt shows a neutral tone, not an error.
	a := NewClaudeAdapter("/compact")
	// Feed the system status first (compact_result:failed + the benign message)
	if _, err := a.ParseStreamLine(`{"type":"system","subtype":"status","compact_result":"failed","compact_error":"Not enough messages to compact."}`); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not enough messages to compact."}]}}`
	events, _ := a.ParseStreamLine(line)
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected 1 command_receipt, got %v", events)
	}
	if events[0].ReceiptStatus != "success" {
		t.Fatalf("expected success (not a real failure), got %s", events[0].ReceiptStatus)
	}
	if events[0].Message != "Not enough messages to compact." {
		t.Fatalf("expected message, got %s", events[0].Message)
	}
}

func TestCompactRealFailureBecomesFailed(t *testing.T) {
	// A genuine compaction error (not the benign "not enough messages") must
	// still map to failed.
	a := NewClaudeAdapter("/compact")
	if _, err := a.ParseStreamLine(`{"type":"system","subtype":"status","compact_result":"failed","compact_error":"Compaction engine error: out of memory."}`); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Compaction failed."}]}}`
	events, _ := a.ParseStreamLine(line)
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected 1 command_receipt, got %v", events)
	}
	if events[0].ReceiptStatus != "failed" {
		t.Fatalf("expected failed for real error, got %s", events[0].ReceiptStatus)
	}
}

func TestSyntheticReplyBecomesReceipt_Success(t *testing.T) {
	a := NewClaudeAdapter("/context")
	line := `{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"## Context Usage\n**Model:** GLM-4.7"}]}}`
	events, _ := a.ParseStreamLine(line)
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected 1 command_receipt, got %v", events)
	}
	if events[0].ReceiptStatus != "success" {
		t.Fatalf("expected success, got %s", events[0].ReceiptStatus)
	}
	if events[0].Command != "/context" {
		t.Fatalf("expected /context, got %s", events[0].Command)
	}
}

func TestRealAssistantTextStillAgentText(t *testing.T) {
	// Non-synthetic (real model) text must remain agent_text even when a slash
	// command is pending — custom commands/skills reply as normal agent_text.
	a := NewClaudeAdapter("/compact")
	line := `{"type":"assistant","message":{"model":"glm-4.7","content":[{"type":"text","text":"real reply"}]}}`
	events, _ := a.ParseStreamLine(line)
	if len(events) != 1 || events[0].Type != "agent_text" {
		t.Fatalf("expected agent_text for real model, got %v", events)
	}
}

func TestExtractSlashCommand(t *testing.T) {
	cases := map[string]string{
		"/compact":        "compact",
		"/model sonnet":   "model",
		"/codex:status":   "codex:status",
		"hello world":     "",
		"":                "",
		"  /compact arg ": "compact",
	}
	for prompt, want := range cases {
		if got := extractSlashCommand(prompt); got != want {
			t.Errorf("extractSlashCommand(%q) = %q, want %q", prompt, got, want)
		}
	}
}

// --- isMeta filtering (design D5) ---

func TestIsMetaUserFiltered_StreamJSON(t *testing.T) {
	a := NewClaudeAdapter("")
	line := `{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<local-command-caveat>noise</local-command-caveat>"}]}}`
	events, _ := a.ParseStreamLine(line)
	if len(events) != 0 {
		t.Fatalf("expected isMeta user filtered from stream-json, got %v", events)
	}
}

func TestParseJSONLLineIsMetaFiltered(t *testing.T) {
	line := `{"type":"user","sessionId":"s1","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>noise</local-command-caveat>"}}`
	events, _ := ParseJSONLLine(line)
	if len(events) != 0 {
		t.Fatalf("expected isMeta user filtered from JSONL replay, got %v", events)
	}
}

func TestParseJSONLLineNonMetaUserNotFiltered(t *testing.T) {
	// A real user message (isMeta absent) must still be forwarded.
	line := `{"type":"user","sessionId":"s1","message":{"role":"user","content":"hello"}}`
	events, _ := ParseJSONLLine(line)
	if len(events) != 1 || events[0].Type != "user_text" {
		t.Fatalf("expected non-meta user_text forwarded, got %v", events)
	}
}

// --- system local_command feedback (the real format on --resume sessions) ---

func TestSystemLocalCommandBecomesReceipt(t *testing.T) {
	a := NewClaudeAdapter("/model")
	line := `{"type":"system","subtype":"local_command","content":"<local-command-stdout>/model isn't available in this environment.</local-command-stdout>"}`
	events, _ := a.ParseStreamLine(line)
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected command_receipt from system local_command, got %v", events)
	}
	if events[0].ReceiptStatus != "unavailable" {
		t.Fatalf("expected unavailable, got %s", events[0].ReceiptStatus)
	}
	if events[0].Message != "/model isn't available in this environment." {
		t.Fatalf("expected message unwrapped from stdout tags, got %s", events[0].Message)
	}
}

func TestParseJSONLLineSystemLocalCommand(t *testing.T) {
	line := `{"type":"system","subtype":"local_command","sessionId":"s1","content":"<local-command-stdout>Not enough messages to compact.</local-command-stdout>"}`
	events, _ := ParseJSONLLine(line)
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected command_receipt from JSONL system local_command, got %v", events)
	}
	if events[0].Message != "Not enough messages to compact." {
		t.Fatalf("expected unwrapped message, got %s", events[0].Message)
	}
}

func TestExtractLocalCommandOutput(t *testing.T) {
	if got := extractLocalCommandOutput("<local-command-stdout>hello world</local-command-stdout>"); got != "hello world" {
		t.Errorf("expected 'hello world', got %q", got)
	}
	if got := extractLocalCommandOutput("no tags here"); got != "" {
		t.Errorf("expected empty for no tags, got %q", got)
	}
}

func TestAssistantUsageForwarded(t *testing.T) {
	a := NewClaudeAdapter("hello")
	line := `{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":1200,"output_tokens":50,"cache_read_input_tokens":8000}}}`
	events, _ := a.ParseStreamLine(line)
	if len(events) != 1 || events[0].Type != "agent_text" {
		t.Fatalf("expected 1 agent_text, got %v", events)
	}
	u := events[0].Usage
	if u == nil {
		t.Fatal("expected Usage non-nil")
	}
	if u.InputTokens != 1200 || u.OutputTokens != 50 || u.CacheRead != 8000 {
		t.Errorf("unexpected usage: %+v", u)
	}
}
