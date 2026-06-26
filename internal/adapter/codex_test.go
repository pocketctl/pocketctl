package adapter

import (
	"encoding/json"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// helper: parse a codex line via the JSONL parser and return events.
func codexParse(t *testing.T, line string) []protocol.DaemonEvent {
	t.Helper()
	p := NewCodexJSONLParser()
	evts, err := p.Parse(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	return evts
}

func TestCodex_SessionMetaSetsSessionID(t *testing.T) {
	a := NewCodexAdapter()
	line := `{"type":"session_meta","payload":{"id":"019f0259-eea5-75c3-8dde-1f58748ec69e","cwd":"/tmp/x","cli_version":"0.140.0"}}`
	if _, err := a.ParseStreamLine(line); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if a.SessionID() != "019f0259-eea5-75c3-8dde-1f58748ec69e" {
		t.Errorf("expected session id set, got %q", a.SessionID())
	}
}

func TestCodex_ResponseItemAssistantMessage(t *testing.T) {
	line := `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}],"phase":"final_answer"}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Type != "agent_text" {
		t.Fatalf("expected 1 agent_text, got %+v", evts)
	}
	if evts[0].Text != "Hello" {
		t.Errorf("expected text Hello, got %q", evts[0].Text)
	}
}

func TestCodex_EventMsgAgentMessage(t *testing.T) {
	line := `{"type":"event_msg","payload":{"type":"agent_message","message":"Hello","phase":"final_answer"}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Type != "agent_text" {
		t.Fatalf("expected 1 agent_text, got %+v", evts)
	}
	if evts[0].Text != "Hello" {
		t.Errorf("expected text Hello, got %q", evts[0].Text)
	}
}

func TestCodex_EventMsgUserMessage(t *testing.T) {
	line := `{"type":"event_msg","payload":{"type":"user_message","message":"hello in one word"}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Type != "user_text" {
		t.Fatalf("expected 1 user_text, got %+v", evts)
	}
	if evts[0].Text != "hello in one word" {
		t.Errorf("got %q", evts[0].Text)
	}
}

func TestCodex_FunctionCall(t *testing.T) {
	line := `{"type":"response_item","payload":{"type":"function_call","call_id":"call_123","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Type != "tool_call" {
		t.Fatalf("expected 1 tool_call, got %+v", evts)
	}
	if evts[0].CallID != "call_123" || evts[0].Tool != "shell" {
		t.Errorf("got CallID=%q Tool=%q", evts[0].CallID, evts[0].Tool)
	}
}

func TestCodex_FunctionCallOutput(t *testing.T) {
	line := `{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_123","output":"file.txt"}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Type != "tool_result" {
		t.Fatalf("expected 1 tool_result, got %+v", evts)
	}
	if evts[0].CallID != "call_123" || evts[0].Output != "file.txt" {
		t.Errorf("got CallID=%q Output=%q", evts[0].CallID, evts[0].Output)
	}
}

func TestCodex_TokenCount(t *testing.T) {
	line := `{"type":"event_msg","payload":{"type":"token_count","last_token_usage":{"input_tokens":31119,"cached_input_tokens":24448,"output_tokens":5}}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Usage == nil {
		t.Fatalf("expected usage event, got %+v", evts)
	}
	if evts[0].Usage.InputTokens != 31119 || evts[0].Usage.CacheRead != 24448 {
		t.Errorf("got %+v", evts[0].Usage)
	}
}

func TestCodex_TaskComplete(t *testing.T) {
	line := `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Hello"}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Type != "session_status" {
		t.Fatalf("expected session_status, got %+v", evts)
	}
	if evts[0].Status != protocol.StatusCompleted {
		t.Errorf("got status %q", evts[0].Status)
	}
}

func TestCodex_UserMessageWithEnvironmentContextFiltered(t *testing.T) {
	// The <environment_context> wrapper codex injects is not real user input.
	line := `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"}]}}`
	evts := codexParse(t, line)
	if len(evts) != 0 {
		t.Fatalf("expected 0 events (filtered), got %+v", evts)
	}
}

func TestCodex_EmptyLine(t *testing.T) {
	evts, err := NewCodexJSONLParser().Parse("   ")
	if err != nil || len(evts) != 0 {
		t.Fatalf("expected no error / no events, got %v / %v", err, evts)
	}
}

func TestCodexLauncher_InteractiveArgs(t *testing.T) {
	args := CodexLauncher{}.BuildInteractiveArgs(protocol.SessionConfig{Cwd: "/tmp/x", Model: "o3"})
	// Expect --ask-for-approval never -C /tmp/x -m o3
	joined := joinArgs(args)
	for _, want := range []string{"--ask-for-approval", "never", "-C", "/tmp/x", "-m", "o3"} {
		if !contains(joined, want) {
			t.Errorf("expected %q in args %v", want, args)
		}
	}
}

func TestCodexLauncher_ResumeArgs(t *testing.T) {
	args := CodexLauncher{}.BuildResumeArgs("hello", "sid-123", protocol.SessionConfig{})
	joined := joinArgs(args)
	for _, want := range []string{"exec", "resume", "sid-123", "--json", "hello"} {
		if !contains(joined, want) {
			t.Errorf("expected %q in args %v", want, args)
		}
	}
}

func TestCodex_ExtractTitle(t *testing.T) {
	s := CodexSessionStorage{}
	lines := []string{
		`{"type":"session_meta","payload":{"id":"x"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"fix the bug in main.go"}}`,
	}
	if got := s.ExtractTitle(lines); got != "fix the bug in main.go" {
		t.Errorf("got %q", got)
	}
}

func TestCodex_ExtractModel(t *testing.T) {
	s := CodexSessionStorage{}
	lines := []string{
		`{"type":"response_item","payload":{"type":"message","role":"assistant","model":"gpt-5.5","content":[{"type":"output_text","text":"Hi"}]}}`,
	}
	if got := s.ExtractModel(lines); got != "gpt-5.5" {
		t.Errorf("got %q", got)
	}
}

func TestCodex_SetPendingCmdNoOp(t *testing.T) {
	// Should not panic / change behavior.
	p := NewCodexJSONLParser()
	p.SetPendingCmd("/anything")
	// Still parses fine.
	if evts, _ := p.Parse(`{"type":"event_msg","payload":{"type":"agent_message","message":"x"}}`); len(evts) != 1 {
		t.Errorf("expected parse to still work, got %d events", len(evts))
	}
}

func TestCodex_CapabilitiesAllFalse(t *testing.T) {
	c := Capabilities("codex")
	if c.SupportsPermissionCycle || c.SupportsEffort || c.SupportsApprovalHook || c.SlashCommandsFromInit {
		t.Errorf("codex should have no claude-specific capabilities, got %+v", c)
	}
}

// --- helpers ---

func joinArgs(args []string) string { return " " + joinStr(args, " ") + " " }

func joinStr(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}

func contains(s, sub string) bool {
	return indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// Ensure unused imports don't cause failures if helpers evolve.
var _ = json.Unmarshal
