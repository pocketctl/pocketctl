package adapter

import "testing"

func TestClaudeStreamPermissionDeniedMessage(t *testing.T) {
	a := NewClaudeAdapter("")
	// Captured from Claude Code 2.1.293 -p --resume after a PreToolUse denial.
	lines := []string{
		`{"type":"system","subtype":"init","session_id":"resumed"}`,
		`{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"call-1","decision_reason_type":"hook","decision_reason":"denied by user","message":"denied by user","session_id":"resumed"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"denied by user","is_error":true,"tool_use_id":"call-1"}]},"session_id":"resumed"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Stopped without retrying."}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"session_id":"resumed"}`,
	}
	for i, line := range lines {
		events, err := a.ParseStreamLine(line)
		if err != nil {
			t.Errorf("line %d: %v", i, err)
			continue
		}
		if i == 2 && (len(events) != 1 || events[0].Output != "denied by user" || events[0].CallID != "call-1") {
			t.Errorf("lost tool denial: %#v", events)
		}
		if i == 3 && (len(events) != 1 || events[0].Text != "Stopped without retrying.") {
			t.Errorf("lost continuation: %#v", events)
		}
		if i == 4 && (len(events) != 1 || events[0].Status != "completed" || events[0].SessionID != "resumed") {
			t.Errorf("lost completion: %#v", events)
		}
	}
}

func TestClaudeStreamMalformedConversationMessageStillFails(t *testing.T) {
	for _, line := range []string{`{"type":"assistant","message":"invalid"}`, `{"type":"user","message":42}`, `{"type":"system",`} {
		if _, err := NewClaudeAdapter("").ParseStreamLine(line); err == nil {
			t.Errorf("accepted malformed conversation event: %s", line)
		}
	}
}

func TestClaudeStreamToolResultContentBlocks(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-2","content":[{"type":"text","text":"first"},{"type":"image","source":{"type":"base64","data":"ignored"}},{"type":"text","text":"second"}]}]}}`
	events, err := NewClaudeAdapter("").ParseStreamLine(line)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Output != "first\nsecond" {
		t.Fatalf("tool result text=%v", events)
	}
}
