package adapter

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestParseStreamLine_TextOutput(t *testing.T) {
	a := NewClaudeAdapter()
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
	a := NewClaudeAdapter()
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
	a := NewClaudeAdapter()
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
	a := NewClaudeAdapter()
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
	a := NewClaudeAdapter()
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
	a := NewClaudeAdapter()
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
