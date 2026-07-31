package adapter

import (
	"encoding/json"
	"testing"
)

// JSONLStreamParser tests — these verify that the PTY (daemon) path now
// produces command_receipt events with the correct command name and status
// for synthetic replies, /compact outcomes, and local-command feedback,
// mirroring what ClaudeAdapter does for the -p (stream-json) path.

func TestJSONLStreamParserSyntheticBecomesReceipt(t *testing.T) {
	p := NewJSONLStreamParser()
	p.SetPendingCmd("/compact")

	// A synthetic assistant reply (model "<synthetic>") must become a
	// command_receipt — NOT a plain agent_text bubble.
	line := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Conversation compacted."}]}}`
	events, err := p.Parse(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d: %v", len(events), events)
	}
	ev := events[0]
	if ev.Type != "command_receipt" {
		t.Errorf("expected command_receipt, got %s", ev.Type)
	}
	if ev.Command != "/compact" {
		t.Errorf("expected command /compact, got %q", ev.Command)
	}
	if ev.ReceiptStatus != "success" {
		t.Errorf("expected status success, got %s", ev.ReceiptStatus)
	}
	if ev.Message != "Conversation compacted." {
		t.Errorf("expected message 'Conversation compacted.', got %q", ev.Message)
	}
}

func TestJSONLStreamParserRealAssistantStaysAgentText(t *testing.T) {
	// Regression guard: a real (non-synthetic) assistant reply must still be
	// forwarded as agent_text, even when a pendingCmd is set.
	p := NewJSONLStreamParser()
	p.SetPendingCmd("/model sonnet")

	line := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Here is the answer."}]}}`
	events, _ := p.Parse(line)
	if len(events) != 1 || events[0].Type != "agent_text" {
		t.Fatalf("expected agent_text for real model, got %v", events)
	}
	if events[0].Text != "Here is the answer." {
		t.Errorf("unexpected text: %q", events[0].Text)
	}
	// The model Claude actually used must be surfaced on the event so the
	// daemon can detect a /model switch.
	if events[0].Model != "claude-sonnet-4" {
		t.Errorf("expected model claude-sonnet-4, got %q", events[0].Model)
	}
}

func TestJSONLStreamParserAgentTextModelSuffixStripped(t *testing.T) {
	// A model id carrying a context-window suffix (e.g. [1M]) must be cleaned.
	p := NewJSONLStreamParser()
	line := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"GLM-5.2[1M]","content":[{"type":"text","text":"hi"}]}}`
	events, _ := p.Parse(line)
	if len(events) != 1 || events[0].Type != "agent_text" {
		t.Fatalf("expected agent_text, got %v", events)
	}
	if events[0].Model != "GLM-5.2" {
		t.Errorf("expected stripped model GLM-5.2, got %q", events[0].Model)
	}
}

func TestJSONLStreamParserCompactNotEnoughMessages(t *testing.T) {
	// "Not enough messages to compact" is a benign outcome, not a failure —
	// the command ran successfully. Status must be success.
	p := NewJSONLStreamParser()
	p.SetPendingCmd("/compact")

	sysLine := `{"type":"system","sessionId":"s1","subtype":"status","compact_result":"failed","compact_error":"Not enough messages to compact."}`
	if events, _ := p.Parse(sysLine); len(events) != 0 {
		t.Fatalf("system status event should produce no events, got %v", events)
	}

	replyLine := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Not enough messages to compact."}]}}`
	events, err := p.Parse(replyLine)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected command_receipt, got %v", events)
	}
	if events[0].ReceiptStatus != "success" {
		t.Errorf("expected success (benign outcome), got %s", events[0].ReceiptStatus)
	}
	if events[0].Message != "Not enough messages to compact." {
		t.Errorf("expected message, got %q", events[0].Message)
	}
}

func TestJSONLStreamParserCompactRealFailure(t *testing.T) {
	// A genuine error must still be failed.
	p := NewJSONLStreamParser()
	p.SetPendingCmd("/compact")

	sysLine := `{"type":"system","sessionId":"s1","subtype":"status","compact_result":"failed","compact_error":"Compaction engine error."}`
	p.Parse(sysLine)

	replyLine := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Compaction failed."}]}}`
	events, _ := p.Parse(replyLine)
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected command_receipt, got %v", events)
	}
	if events[0].ReceiptStatus != "failed" {
		t.Errorf("expected failed for real error, got %s", events[0].ReceiptStatus)
	}
}

func TestJSONLStreamParserLocalCommandReceipt(t *testing.T) {
	p := NewJSONLStreamParser()
	p.SetPendingCmd("/clear")

	line := `{"type":"system","sessionId":"s1","subtype":"local_command","content":"<local-command-stdout>Context cleared.</local-command-stdout>"}`
	events, err := p.Parse(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected command_receipt, got %v", events)
	}
	if events[0].Command != "/clear" {
		t.Errorf("expected command /clear, got %q", events[0].Command)
	}
	if events[0].Message != "Context cleared." {
		t.Errorf("expected message 'Context cleared.', got %q", events[0].Message)
	}
}

func TestJSONLStreamParserUnavailableStatus(t *testing.T) {
	p := NewJSONLStreamParser()
	p.SetPendingCmd("/model")

	// Synthetic text containing the unavailable marker → status unavailable.
	line := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"/model isn't available in this environment."}]}}`
	events, _ := p.Parse(line)
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected command_receipt, got %v", events)
	}
	if events[0].ReceiptStatus != "unavailable" {
		t.Errorf("expected status unavailable, got %s", events[0].ReceiptStatus)
	}
}

func TestJSONLStreamParserPendingCmdConsumed(t *testing.T) {
	// After a receipt is produced, the pendingCmd is consumed so subsequent
	// synthetic replies (unlikely but possible) don't carry a stale command.
	p := NewJSONLStreamParser()
	p.SetPendingCmd("/compact")

	line1 := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"done."}]}}`
	p.Parse(line1)

	// Second synthetic reply without a new SetPendingCmd → command should be empty.
	line2 := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"again."}]}}`
	events, _ := p.Parse(line2)
	if len(events) != 1 || events[0].Type != "command_receipt" {
		t.Fatalf("expected command_receipt, got %v", events)
	}
	if events[0].Command != "" {
		t.Errorf("expected empty command after consumption, got %q", events[0].Command)
	}
}

func TestJSONLStreamParserNonSlashClearsPending(t *testing.T) {
	// A non-slash user message should clear any stale pendingCmd.
	p := NewJSONLStreamParser()
	p.SetPendingCmd("/compact")
	p.SetPendingCmd("hello world") // not a slash command

	if p.pendingCmd != "" {
		t.Errorf("expected pendingCmd cleared, got %q", p.pendingCmd)
	}
}

func TestParseJSONLLineBackwardCompat(t *testing.T) {
	// Regression: the original stateless ParseJSONLLine must still work
	// unchanged for callers that don't use JSONLStreamParser.
	line := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"hi"}]}}`
	events, err := ParseJSONLLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 || events[0].Type != "agent_text" {
		t.Fatalf("ParseJSONLLine regression: expected agent_text, got %v", events)
	}
}

func TestJSONLStreamParserUsageForwarded(t *testing.T) {
	p := NewJSONLStreamParser()
	line := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":500,"output_tokens":30,"cache_read_input_tokens":3000}}}`
	events, _ := p.Parse(line)
	if len(events) != 1 || events[0].Usage == nil {
		t.Fatalf("expected agent_text with usage, got %v", events)
	}
	if events[0].Usage.InputTokens != 500 {
		t.Errorf("expected 500 input tokens, got %d", events[0].Usage.InputTokens)
	}
}

func TestJSONLResultEventForwarded(t *testing.T) {
	// PTY path previously dropped result events — verify cost/turns now forwarded.
	p := NewJSONLStreamParser()
	line := `{"type":"result","sessionId":"s1","total_cost_usd":0.0878,"num_turns":1}`
	events, _ := p.Parse(line)
	if len(events) != 1 || events[0].Type != "session_status" {
		t.Fatalf("expected session_status, got %v", events)
	}
	if events[0].CostUSD != 0.0878 {
		t.Errorf("expected cost 0.0878, got %f", events[0].CostUSD)
	}
	if events[0].Turns != 1 {
		t.Errorf("expected 1 turn, got %d", events[0].Turns)
	}
}

func TestJSONLStreamParserPermissionConfigChanged(t *testing.T) {
	p := NewJSONLStreamParser()
	// Claude Code 2.1.206 writes the mode in permissionMode, not content.
	line := `{"type":"permission-mode","sessionId":"s1","permissionMode":"plan"}`
	events, _ := p.Parse(line)
	if len(events) != 1 || events[0].Type != "permission_config_changed" {
		t.Fatalf("expected permission_config_changed, got %v", events)
	}
	if events[0].Permission == nil || events[0].Permission.Mode != "plan" {
		t.Errorf("expected plan, got %+v", events[0].Permission)
	}
}

func TestParseSidechainEntryFields(t *testing.T) {
	line := `{"type":"user","sessionId":"85d3d7b6","isSidechain":true,"parentUuid":"abc-123","message":{"role":"user","content":"hi"}}`
	events, err := ParseJSONLLine(line)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// 主要断言：字段被接住、不报错、user_text 正常产出
	if len(events) == 0 {
		t.Fatal("expected at least one event")
	}
	// 直接验证 JSONLEntry 反序列化接住字段
	var entry JSONLEntry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		t.Fatalf("unmarshal entry: %v", err)
	}
	if !entry.IsSidechain {
		t.Error("IsSidechain not parsed")
	}
	if entry.ParentUuid != "abc-123" {
		t.Errorf("ParentUuid = %q, want abc-123", entry.ParentUuid)
	}
}
