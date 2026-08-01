package adapter

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestReadCodexRolloutMetadata_ClassifiesSubagentsStrictly(t *testing.T) {
	tests := []struct {
		name         string
		payload      string
		id           string
		cwd          string
		parent       string
		root         string
		nickname     string
		agentPath    string
		wantSubagent bool
	}{
		{
			name:    "ordinary main session",
			payload: `{"id":"main","session_id":"main","thread_source":"user","cwd":"/repo"}`,
			id:      "main", cwd: "/repo", root: "main",
		},
		{
			name:    "modern spawned subagent",
			payload: `{"id":"child","session_id":"root","parent_thread_id":"root","thread_source":"subagent","agent_nickname":"Newton","agent_path":"/root/task"}`,
			id:      "child", parent: "root", root: "root", nickname: "Newton", agentPath: "/root/task", wantSubagent: true,
		},
		{
			name:    "legacy review subagent",
			payload: `{"id":"review","session_id":"root","parent_thread_id":"root","thread_source":"subagent","source":{"subagent":"review"}}`,
			id:      "review", parent: "root", root: "root", wantSubagent: true,
		},
		{
			name:    "subagent without relation",
			payload: `{"id":"orphan","thread_source":"subagent"}`,
			id:      "orphan",
		},
		{
			name:         "parent only subagent uses parent as root",
			payload:      `{"id":"child","parent_thread_id":"parent","thread_source":"subagent"}`,
			id:           "child",
			parent:       "parent",
			root:         "parent",
			wantSubagent: true,
		},
		{
			name:    "self parent is not a subagent",
			payload: `{"id":"same","session_id":"same","parent_thread_id":"same","thread_source":"subagent"}`,
			id:      "same", parent: "same", root: "same",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rollout.jsonl")
			line := fmt.Sprintf(`{"type":"session_meta","payload":%s}`+"\n", tt.payload)
			if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
				t.Fatal(err)
			}

			got, ok := ReadCodexRolloutMetadata(path)
			if !ok {
				t.Fatal("metadata not parsed")
			}
			if got.ID != tt.id || got.Cwd != tt.cwd || got.ParentThreadID != tt.parent ||
				got.RootSessionID != tt.root || got.AgentNickname != tt.nickname ||
				got.AgentPath != tt.agentPath || got.IsSubagent != tt.wantSubagent {
				t.Fatalf("metadata = %+v", got)
			}

			legacyID, legacyCwd, legacyOK := CodexRolloutMeta(path)
			if !legacyOK || legacyID != tt.id || legacyCwd != tt.cwd {
				t.Fatalf("legacy tuple = (%q, %q, %v)", legacyID, legacyCwd, legacyOK)
			}
		})
	}
}

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

func TestCodex_TokenCountInfoFormat(t *testing.T) {
	line := `{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":12535,"cached_input_tokens":4736,"output_tokens":56,"reasoning_output_tokens":47,"total_tokens":12591}}}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Usage == nil {
		t.Fatalf("expected usage event, got %+v", evts)
	}
	if evts[0].Usage.InputTokens != 12535 || evts[0].Usage.OutputTokens != 56 || evts[0].Usage.CacheRead != 4736 {
		t.Errorf("got %+v", evts[0].Usage)
	}
}

func TestCodex_TaskCompleteKeepsTerminalSessionIdle(t *testing.T) {
	line := `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Hello"}}`
	evts := codexParse(t, line)
	if len(evts) != 1 || evts[0].Type != "session_status" {
		t.Fatalf("expected session_status, got %+v", evts)
	}
	if evts[0].Status != protocol.StatusIdle {
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
	args := CodexLauncher{}.BuildResumeArgs("hello", "sid-123", protocol.SessionConfig{Permission: &protocol.PermissionConfig{Agent: AgentCodex, Preset: "custom", ApprovalPolicy: "never", SandboxMode: "workspace-write"}})
	joined := joinArgs(args)
	for _, want := range []string{"exec", "resume", "sid-123", "--json", "--skip-git-repo-check", "hello"} {
		if !contains(joined, want) {
			t.Errorf("expected %q in args %v", want, args)
		}
	}
	for _, want := range []string{`approval_policy="never"`, `sandbox_mode="workspace-write"`} {
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

func TestCodexTurnContextEmitsEffort(t *testing.T) {
	events, err := NewCodexAdapter().ParseStreamLine(`{"type":"turn_context","payload":{"model":"gpt-5.4","effort":"high"}}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "session_meta" || events[0].Effort != "high" {
		t.Fatalf("events = %+v, want session_meta effort=high", events)
	}
}

func TestCodexExtractEffortUsesLatestNonEmptyTurnContext(t *testing.T) {
	lines := []string{
		`{"type":"turn_context","payload":{"effort":"low"}}`,
		`{"type":"turn_context","payload":{"effort":""}}`,
		`{"type":"turn_context","payload":{"effort":"xhigh"}}`,
	}
	if got := (CodexSessionStorage{}).ExtractEffort(lines); got != "xhigh" {
		t.Fatalf("ExtractEffort() = %q, want xhigh", got)
	}
}

func TestResolveJSONLPathForPTY_CodexFindsRealSessionIDByCwdAndStartTime(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	cwd := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	startedAt := time.Now().Add(-2 * time.Second)
	realID := "019f455f-17b1-7372-814c-8011accab8f4"
	path := writeCodexRollout(t, codexHome, realID, cwd, "fix this", time.Now())

	gotPath, gotID, err := ResolveJSONLPathForPTY(AgentCodex, "pocketctl-temp-id", cwd, PTYResolveHints{
		StartedAt:     startedAt,
		InitialPrompt: "fix this",
	})
	if err != nil {
		t.Fatalf("ResolveJSONLPathForPTY returned error: %v", err)
	}
	if gotPath != path {
		t.Fatalf("path = %q, want %q", gotPath, path)
	}
	if gotID != realID {
		t.Fatalf("real session id = %q, want %q", gotID, realID)
	}
}

func TestResolveJSONLPathForPTY_CodexExcludesPreexistingRollouts(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	cwd := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	startedAt := time.Now().Add(-2 * time.Second)
	oldID := "019f-old-terminal-session"
	newID := "019f-new-daemon-session"
	writeCodexRollout(t, codexHome, newID, cwd, "same prompt", time.Now())
	writeCodexRollout(t, codexHome, oldID, cwd, "same prompt", time.Now().Add(time.Second))

	_, gotID, err := ResolveJSONLPathForPTY(AgentCodex, "pocketctl-temp-id", cwd, PTYResolveHints{
		StartedAt:         startedAt,
		InitialPrompt:     "same prompt",
		ExcludeSessionIDs: map[string]struct{}{oldID: {}},
	})
	if err != nil {
		t.Fatalf("ResolveJSONLPathForPTY returned error: %v", err)
	}
	if gotID != newID {
		t.Fatalf("real session id = %q, want %q", gotID, newID)
	}
}

func TestResolveJSONLPathForPTY_CodexRequiresInitialPromptMatch(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	cwd := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	startedAt := time.Now().Add(-2 * time.Second)
	targetID := "019f-target-session"
	distractorID := "019f-distractor-session"
	writeCodexRollout(t, codexHome, targetID, cwd, "fix target bug", time.Now())
	writeCodexRollout(t, codexHome, distractorID, cwd, "unrelated terminal message", time.Now().Add(time.Second))

	_, gotID, err := ResolveJSONLPathForPTY(AgentCodex, "pocketctl-temp-id", cwd, PTYResolveHints{
		StartedAt:     startedAt,
		InitialPrompt: "fix target bug",
	})
	if err != nil {
		t.Fatalf("ResolveJSONLPathForPTY returned error: %v", err)
	}
	if gotID != targetID {
		t.Fatalf("real session id = %q, want %q", gotID, targetID)
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

func writeCodexRollout(t *testing.T, codexHome, sessionID, cwd, userMessage string, mtime time.Time) string {
	t.Helper()
	path := filepath.Join(codexHome, "sessions", "2026", "07", "09", "rollout-2026-07-09T13-34-47-"+sessionID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	lines := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"` + cwd + `","cli_version":"0.143.0"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"user_message","message":"` + userMessage + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return path
}
