package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPermissionConfigJSON(t *testing.T) {
	msg := ClientMessage{Type: "session_create", Agent: "codex", Permission: &PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "never", SandboxMode: "workspace-write"}}
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "permission_mode") {
		t.Fatalf("legacy field serialized: %s", b)
	}
	var decoded ClientMessage
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Permission == nil || decoded.Permission.ApprovalPolicy != "never" {
		t.Fatalf("bad round trip: %+v", decoded.Permission)
	}
}

func TestStatusConstants(t *testing.T) {
	statuses := []string{
		StatusRunning,
		StatusWaitingApproval,
		StatusIdle,
		StatusExited,
		StatusDisconnected,
		StatusCompleted,
		StatusError,
		StatusKilled,
	}

	// Verify expected values
	if StatusExited != "exited" {
		t.Errorf("StatusExited = %q, want %q", StatusExited, "exited")
	}
	if StatusDisconnected != "disconnected" {
		t.Errorf("StatusDisconnected = %q, want %q", StatusDisconnected, "disconnected")
	}

	// Verify no duplicates
	seen := make(map[string]bool)
	for _, s := range statuses {
		if seen[s] {
			t.Errorf("duplicate status constant: %q", s)
		}
		seen[s] = true
	}

	if len(statuses) != 8 {
		t.Errorf("expected 8 status constants, got %d", len(statuses))
	}
}

func TestExitReasonConstants(t *testing.T) {
	reasons := []string{
		ExitReasonUserInterrupt,
		ExitReasonNormalExit,
		ExitReasonProcessCrash,
		ExitReasonSignalKill,
		ExitReasonUnknown,
	}

	// Verify expected values
	if ExitReasonUserInterrupt != "user_interrupt" {
		t.Errorf("ExitReasonUserInterrupt = %q, want %q", ExitReasonUserInterrupt, "user_interrupt")
	}
	if ExitReasonNormalExit != "normal_exit" {
		t.Errorf("ExitReasonNormalExit = %q, want %q", ExitReasonNormalExit, "normal_exit")
	}
	if ExitReasonProcessCrash != "process_crash" {
		t.Errorf("ExitReasonProcessCrash = %q, want %q", ExitReasonProcessCrash, "process_crash")
	}
	if ExitReasonSignalKill != "signal_kill" {
		t.Errorf("ExitReasonSignalKill = %q, want %q", ExitReasonSignalKill, "signal_kill")
	}
	if ExitReasonUnknown != "unknown" {
		t.Errorf("ExitReasonUnknown = %q, want %q", ExitReasonUnknown, "unknown")
	}

	// Verify no duplicates
	seen := make(map[string]bool)
	for _, r := range reasons {
		if seen[r] {
			t.Errorf("duplicate exit_reason constant: %q", r)
		}
		seen[r] = true
	}
}

func TestDaemonEvent_NewFields_OmitEmpty(t *testing.T) {
	// When exit_reason and last_activity_at are empty, they should not appear in JSON
	evt := DaemonEvent{
		Type:      "session_status",
		SessionID: "test-123",
		Status:    "running",
	}

	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if _, ok := parsed["exit_reason"]; ok {
		t.Error("exit_reason should be omitted when empty")
	}
	if _, ok := parsed["last_activity_at"]; ok {
		t.Error("last_activity_at should be omitted when empty")
	}
}

func TestDaemonEvent_NewFields_Present(t *testing.T) {
	evt := DaemonEvent{
		Type:           "session_status",
		SessionID:      "test-456",
		Status:         StatusExited,
		ExitReason:     ExitReasonNormalExit,
		LastActivityAt: "2026-06-07T10:30:00Z",
	}

	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if v, ok := parsed["exit_reason"]; !ok {
		t.Error("exit_reason missing from JSON")
	} else if v != "normal_exit" {
		t.Errorf("exit_reason = %v, want %q", v, "normal_exit")
	}

	if v, ok := parsed["last_activity_at"]; !ok {
		t.Error("last_activity_at missing from JSON")
	} else if v != "2026-06-07T10:30:00Z" {
		t.Errorf("last_activity_at = %v, want %q", v, "2026-06-07T10:30:00Z")
	}
}

func TestDaemonEvent_NewFields_Deserialization(t *testing.T) {
	jsonStr := `{"type":"session_status","session_id":"abc","status":"exited","exit_reason":"user_interrupt","last_activity_at":"2026-06-07T12:00:00Z"}`

	var evt DaemonEvent
	if err := json.Unmarshal([]byte(jsonStr), &evt); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if evt.ExitReason != "user_interrupt" {
		t.Errorf("ExitReason = %q, want %q", evt.ExitReason, "user_interrupt")
	}
	if evt.LastActivityAt != "2026-06-07T12:00:00Z" {
		t.Errorf("LastActivityAt = %q, want %q", evt.LastActivityAt, "2026-06-07T12:00:00Z")
	}
	if evt.Status != StatusExited {
		t.Errorf("Status = %q, want %q", evt.Status, StatusExited)
	}
}

func TestDaemonEventSubagentFieldsSerialize(t *testing.T) {
	ev := DaemonEvent{
		Type:            "subagent_discovered",
		EventID:         "jsonl:source:1:0",
		SessionID:       "parent-1",
		AgentID:         "agent-abc",
		ParentSessionID: "parent-1",
		IsSubagent:      true,
		RootSessionID:   "parent-1",
	}
	out, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	j := string(out)
	for _, want := range []string{`"event_id":"jsonl:source:1:0"`, `"parent_session_id":"parent-1"`, `"is_subagent":true`, `"root_session_id":"parent-1"`} {
		if !contains(j, want) {
			t.Errorf("missing %q in %s", want, j)
		}
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
