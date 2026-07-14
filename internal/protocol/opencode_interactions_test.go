package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOpenCodeInteractionClientRoundTrip(t *testing.T) {
	tests := []ClientMessage{
		{Type: "approval_response", SessionID: "ses_1", RequestID: "per_1", Action: "always"},
		{Type: "question_response", SessionID: "ses_1", RequestID: "que_1", Answers: [][]string{{"A"}, {"B", "custom"}}},
		{Type: "set_session_agent", SessionID: "ses_1", AgentName: "build"},
	}
	for _, want := range tests {
		raw, err := json.Marshal(want)
		if err != nil {
			t.Fatal(err)
		}
		var got ClientMessage
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		if got.Type != want.Type || got.Action != want.Action || got.AgentName != want.AgentName {
			t.Fatalf("bad client round trip: got %+v want %+v", got, want)
		}
		if len(got.Answers) != len(want.Answers) {
			t.Fatalf("answers lost: got %+v want %+v", got.Answers, want.Answers)
		}
	}
}

func TestOpenCodeInteractionDaemonEventRoundTrip(t *testing.T) {
	event := DaemonEvent{
		Type:         "question_request",
		SessionID:    "ses_1",
		RequestID:    "que_1",
		CurrentAgent: "build",
		Agents: []SessionAgentOption{{
			Name: "build", Description: "Build agent", Mode: "primary", Color: "#fff",
			Model: "openai/gpt-5", Variant: "high",
		}},
		Capabilities:      []string{"dynamic_commands", "agent_switch", "permission_actions", "questions"},
		PermissionName:    "bash",
		Patterns:          []string{"git *"},
		Always:            []string{"git status"},
		Metadata:          json.RawMessage(`{"command":"git status"}`),
		ToolMessageID:     "msg_1",
		ToolCallID:        "call_1",
		PermissionVersion: "v2",
		Action:            "always",
		Questions: []QuestionInfo{
			{Header: "Scope", Question: "Choose", Options: []QuestionOption{{Label: "A", Description: "first"}}, Custom: true},
		},
		Answers:  [][]string{{"A"}},
		Rejected: true,
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var got DaemonEvent
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.CurrentAgent != "build" || len(got.Agents) != 1 || got.Agents[0].Mode != "primary" {
		t.Fatalf("agent fields lost: %+v", got)
	}
	if got.PermissionName != "bash" || got.PermissionVersion != "v2" || string(got.Metadata) != `{"command":"git status"}` {
		t.Fatalf("permission fields lost: %+v", got)
	}
	if len(got.Questions) != 1 || len(got.Answers) != 1 || !got.Rejected || got.Action != "always" {
		t.Fatalf("question/result fields lost: %+v", got)
	}
}

func TestOpenCodeInteractionLegacyPayloadOmitsNewFields(t *testing.T) {
	raw, err := json.Marshal(ClientMessage{Type: "approval_response", SessionID: "ses_1", RequestID: "per_1", Approved: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"action", "answers", "agent_name"} {
		if strings.Contains(string(raw), `"`+field+`"`) {
			t.Fatalf("legacy payload unexpectedly contains %s: %s", field, raw)
		}
	}
}

func TestOpenCodeInteractionApprovalActionValidation(t *testing.T) {
	for _, action := range []string{"once", "always", "reject"} {
		if !ValidApprovalAction(action) {
			t.Errorf("expected valid action %q", action)
		}
	}
	for _, action := range []string{"", "allow", "yes", "ALWAYS"} {
		if ValidApprovalAction(action) {
			t.Errorf("expected invalid action %q", action)
		}
	}
}

func TestOpenCodeInteractionQuestionAnswerValidation(t *testing.T) {
	questions := []QuestionInfo{
		{Question: "single", Options: []QuestionOption{{Label: "A"}, {Label: "B"}}},
		{Question: "multi", Options: []QuestionOption{{Label: "X"}, {Label: "Y"}}, Multiple: true, Custom: true},
	}
	if err := ValidateQuestionAnswers(questions, [][]string{{"A"}, {"X", "custom value"}}); err != nil {
		t.Fatalf("valid answers rejected: %v", err)
	}
	invalid := [][][]string{
		{{"A"}},              // wrong question count
		{{"A", "B"}, {"X"}},  // multiple values for single choice
		{{"unknown"}, {"X"}}, // unknown option without custom
		{{"A"}, {}},          // no answer
		{{"A"}, {strings.Repeat("x", MaxQuestionAnswerBytes+1)}},
	}
	for i, answers := range invalid {
		if err := ValidateQuestionAnswers(questions, answers); err == nil {
			t.Errorf("invalid answers %d accepted: %#v", i, answers)
		}
	}
}

func TestOpenCodeInteractionCommandMetadataRoundTrip(t *testing.T) {
	want := CommandItem{
		Name: "review", Source: "command", Kind: "command", Description: "Review changes",
		Template: "Review $ARGUMENTS", Hints: []string{"[scope]"}, Subtask: true,
		Agent: "build", Model: "openai/gpt-5",
	}
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var got CommandItem
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Template != want.Template || len(got.Hints) != 1 || !got.Subtask || got.Agent != "build" {
		t.Fatalf("command metadata lost: %+v", got)
	}
}
