package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDisconnectMessageRoundTrip(t *testing.T) {
	want := DisconnectMessage{
		Type: "disconnect", Reason: "token_check_unavailable",
		Retryable: true, RetryAfterMS: 750,
	}
	data, _ := json.Marshal(want)
	var got DisconnectMessage
	if err := json.Unmarshal(data, &got); err != nil || got != want {
		t.Fatalf("got %#v err=%v", got, err)
	}
}

func TestUserMessageReceiptCorrelationRoundTrip(t *testing.T) {
	var command ClientMessage
	if err := json.Unmarshal([]byte(`{
		"type":"user_message",
		"session_id":"thr_1",
		"msg_id":"message-1",
		"request_id":"request-1",
		"content":"continue"
	}`), &command); err != nil {
		t.Fatal(err)
	}
	commandRaw, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	var commandWire map[string]any
	if err := json.Unmarshal(commandRaw, &commandWire); err != nil {
		t.Fatal(err)
	}
	if commandWire["msg_id"] != "message-1" || commandWire["request_id"] != "request-1" {
		t.Fatalf("client correlation lost: %s", commandRaw)
	}

	var receipt DaemonEvent
	if err := json.Unmarshal([]byte(`{
		"type":"user_message_receipt",
		"session_id":"thr_1",
		"msg_id":"message-1",
		"request_id":"request-1",
		"status":"rejected",
		"reason":"Codex turn/start: disconnected",
		"retryable":true
	}`), &receipt); err != nil {
		t.Fatal(err)
	}
	receiptRaw, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	var receiptWire map[string]any
	if err := json.Unmarshal(receiptRaw, &receiptWire); err != nil {
		t.Fatal(err)
	}
	if receiptWire["msg_id"] != "message-1" || receiptWire["request_id"] != "request-1" ||
		receiptWire["status"] != "rejected" || receiptWire["retryable"] != true {
		t.Fatalf("receipt correlation lost: %s", receiptRaw)
	}

	var permanent DaemonEvent
	if err := json.Unmarshal([]byte(`{
		"type":"user_message_receipt",
		"session_id":"thr_1",
		"msg_id":"message-2",
		"status":"rejected",
		"retryable":false
	}`), &permanent); err != nil {
		t.Fatal(err)
	}
	permanentRaw, err := json.Marshal(permanent)
	if err != nil {
		t.Fatal(err)
	}
	var permanentWire map[string]any
	if err := json.Unmarshal(permanentRaw, &permanentWire); err != nil {
		t.Fatal(err)
	}
	retryable, exists := permanentWire["retryable"]
	if !exists || retryable != false {
		t.Fatalf("explicit retryable=false lost: %s", permanentRaw)
	}
}

func TestDurableIngressControlMessagesRoundTrip(t *testing.T) {
	register := RegisterAckMessage{
		Type: "register_ack", SupportsEventAck: true,
		Capabilities: []string{"durable_inbox", "flow_control", "tool_output_stream_v1"},
		EventWindow:  128, DaemonGeneration: 17,
		MaxEventBytes: 1_048_576, MaxChunkBytes: 131_072,
	}
	data, err := json.Marshal(register)
	if err != nil {
		t.Fatal(err)
	}
	var decoded RegisterAckMessage
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.EventWindow != 128 || decoded.DaemonGeneration != 17 ||
		decoded.MaxEventBytes != 1_048_576 || decoded.MaxChunkBytes != 131_072 ||
		len(decoded.Capabilities) != 3 {
		t.Fatalf("register ack did not round-trip: %+v", decoded)
	}

	ack := EventAckMessage{Type: "event_ack", UpToSeq: 4, EventWindow: 64, DaemonGeneration: 17}
	flow := FlowControlMessage{
		Type: "flow_control", Window: 1, RetryAfterMS: 50,
		Reason: "event_too_large", BlockedSeq: 9,
	}
	for _, message := range []any{ack, flow} {
		if _, err := json.Marshal(message); err != nil {
			t.Fatalf("marshal durable control message: %v", err)
		}
	}
	flowRaw, _ := json.Marshal(flow)
	var decodedFlow FlowControlMessage
	if err := json.Unmarshal(flowRaw, &decodedFlow); err != nil || decodedFlow.BlockedSeq != 9 {
		t.Fatalf("flow control barrier did not round-trip: %+v err=%v", decodedFlow, err)
	}

	rejected := RegisterRejectedMessage{
		Type: "register_rejected", Reason: "durable_ingress_unavailable",
		Retryable: true, RetryAfterMS: 250,
	}
	raw, err := json.Marshal(rejected)
	if err != nil {
		t.Fatal(err)
	}
	var decodedRejected RegisterRejectedMessage
	if err := json.Unmarshal(raw, &decodedRejected); err != nil {
		t.Fatal(err)
	}
	if !decodedRejected.Retryable || decodedRejected.RetryAfterMS != 250 {
		t.Fatalf("register rejection did not round-trip: %+v", decodedRejected)
	}
}

func TestContentStreamEventRoundTrip(t *testing.T) {
	chunkSeq, byteOffset := 0, 0
	event := DaemonEvent{
		Type: "tool_result", SessionID: "session-1", CallID: "call-1",
		Output: "你好", StreamID: "stream-1",
		ChunkSeq: &chunkSeq, ByteOffset: &byteOffset,
		Streaming: true, Final: true, TotalBytes: 6,
		ContentHash: "abc123", Truncated: true,
		OriginalType: "tool_result", OriginalBytes: 1234,
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var decoded DaemonEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.StreamID != "stream-1" || decoded.ChunkSeq == nil || *decoded.ChunkSeq != 0 ||
		decoded.ByteOffset == nil || *decoded.ByteOffset != 0 || !decoded.Final ||
		decoded.TotalBytes != 6 || decoded.ContentHash != "abc123" || !decoded.Truncated {
		t.Fatalf("content stream event did not round-trip: %+v", decoded)
	}
	if decoded.OriginalType != "tool_result" || decoded.OriginalBytes != 1234 {
		t.Fatalf("delivery error metadata did not round-trip: %+v", decoded)
	}
}

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

func TestQuotaGrantProtocolRoundTrip(t *testing.T) {
	msg := ClientMessage{
		Type:      "session_create",
		RequestID: "request-1",
		QuotaGrant: &QuotaGrant{
			ReservationID: "reservation-1",
			ExpiresAt:     1_800_000_000_000,
			Operation:     "create",
		},
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	var decoded ClientMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.RequestID != "request-1" || decoded.QuotaGrant == nil || decoded.QuotaGrant.ReservationID != "reservation-1" {
		t.Fatalf("quota grant did not round-trip: %+v", decoded)
	}

	eventRaw, err := json.Marshal(DaemonEvent{Type: "session_created", RequestID: "request-1", ReservationID: "reservation-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(eventRaw), `"reservation_id":"reservation-1"`) {
		t.Fatalf("reservation_id missing from event JSON: %s", eventRaw)
	}

	registerRaw, err := json.Marshal(RegisterMessage{Type: "register", SupportsQuotaGrant: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(registerRaw), `"supports_quota_grant":true`) {
		t.Fatalf("quota capability missing from register JSON: %s", registerRaw)
	}
}

func TestStatusConstants(t *testing.T) {
	statuses := []string{
		StatusRunning,
		StatusWaitingApproval,
		StatusWaitingQuestion,
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

	if len(statuses) != 9 {
		t.Errorf("expected 9 status constants, got %d", len(statuses))
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
		PreviousEventID: "jsonl:source:0:0",
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
	for _, want := range []string{`"event_id":"jsonl:source:1:0"`, `"previous_event_id":"jsonl:source:0:0"`, `"parent_session_id":"parent-1"`, `"is_subagent":true`, `"root_session_id":"parent-1"`} {
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
