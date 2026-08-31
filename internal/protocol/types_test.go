package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
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

func TestAgentFileChangeEventRoundTrip(t *testing.T) {
	event := DaemonEvent{
		Type:        "agent_file_change",
		Seq:         101,
		EventID:     "codex:file:two",
		SessionID:   "session-1",
		TurnID:      "turn-1",
		ChangeSetID: "native:call-1",
		CallID:      "call-1",
		ChangeIndex: 1,
		ChangeTotal: 2,
		Path:        "old/name.go",
		ChangeKind:  "move",
		MovePath:    "new/name.go",
		Diff:        "@@ -1 +1 @@\n-old\n+new\n",
		Additions:   1,
		Deletions:   1,
		Status:      "completed",
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var decoded DaemonEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.TurnID != event.TurnID || decoded.ChangeSetID != event.ChangeSetID ||
		decoded.ChangeIndex != event.ChangeIndex || decoded.ChangeTotal != event.ChangeTotal ||
		decoded.Path != event.Path || decoded.ChangeKind != event.ChangeKind ||
		decoded.MovePath != event.MovePath || decoded.Diff != event.Diff ||
		decoded.Additions != event.Additions || decoded.Deletions != event.Deletions {
		t.Fatalf("file change event did not round-trip: %+v", decoded)
	}
}

func TestLegacyDaemonEventOmitsAgentFileChangeFields(t *testing.T) {
	var event DaemonEvent
	if err := json.Unmarshal([]byte(`{"type":"agent_text","session_id":"session-1","text":"hello"}`), &event); err != nil {
		t.Fatal(err)
	}
	if event.TurnID != "" || event.ChangeSetID != "" || event.ChangeTotal != 0 ||
		event.Path != "" || event.ChangeKind != "" || event.Diff != "" ||
		event.Additions != 0 || event.Deletions != 0 {
		t.Fatalf("legacy event gained file change values: %+v", event)
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"turn_id", "change_set_id", "change_index", "change_total", "path",
		"change_kind", "move_path", "diff", "additions", "deletions",
	} {
		if _, exists := wire[key]; exists {
			t.Fatalf("legacy event serialized %q: %s", key, raw)
		}
	}
}

func TestAgentFileChangeContractFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "contracts", "agent_file_change_turn.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		SessionID string        `json:"session_id"`
		TurnID    string        `json:"turn_id"`
		Events    []DaemonEvent `json:"events"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SessionID != "ses_contract" || fixture.TurnID != "turn_contract" || len(fixture.Events) != 2 {
		t.Fatalf("unexpected contract envelope: %+v", fixture)
	}
	if fixture.Events[0].TurnID != fixture.TurnID || fixture.Events[0].Path != "a.txt" ||
		fixture.Events[0].Additions != 2 || fixture.Events[0].Deletions != 1 ||
		fixture.Events[1].TurnID != fixture.TurnID || fixture.Events[1].Path != "b.txt" ||
		fixture.Events[1].ChangeKind != "create" {
		t.Fatalf("unexpected contract events: %+v", fixture.Events)
	}
}

func TestAgentPlanEventRoundTripPreservesStructuredSnapshot(t *testing.T) {
	event := DaemonEvent{
		Type:            "agent_plan",
		SessionID:       "session-1",
		PartID:          "plan:session-1",
		EventID:         "codex:plan:call-2",
		PreviousEventID: "codex:plan:call-1",
		Revision:        2,
		Explanation:     "Implement the clients",
		Plan: []PlanItem{
			{Step: "Parse Codex plan", Status: PlanCompleted},
			{Step: "Render Web panel", Status: PlanInProgress},
			{Step: "Render iOS sheet", Status: PlanPending},
		},
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var decoded DaemonEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Explanation != event.Explanation || len(decoded.Plan) != 3 ||
		decoded.Plan[1].Step != "Render Web panel" || decoded.Plan[1].Status != PlanInProgress {
		t.Fatalf("plan snapshot did not round-trip: %+v", decoded)
	}
	for _, status := range []string{PlanPending, PlanInProgress, PlanCompleted} {
		if !ValidPlanStatus(status) {
			t.Fatalf("known plan status rejected: %q", status)
		}
	}
	if ValidPlanStatus("cancelled") {
		t.Fatal("unknown plan status accepted")
	}
}

func TestFinalizeAgentPlanEventUsesTheResolvedSessionID(t *testing.T) {
	event := DaemonEvent{Type: "agent_plan", SessionID: "session-1", PartID: "stale"}
	FinalizeAgentPlanEvent(&event)
	if event.PartID != "plan:session-1" {
		t.Fatalf("part_id = %q", event.PartID)
	}

	ordinary := DaemonEvent{Type: "agent_text", SessionID: "session-1", PartID: "text-1"}
	FinalizeAgentPlanEvent(&ordinary)
	if ordinary.PartID != "text-1" {
		t.Fatalf("ordinary event identity changed: %+v", ordinary)
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

func TestDaemonEventRiskClassificationRoundTrip(t *testing.T) {
	incomplete := false
	event := DaemonEvent{
		Type: "approval_request", SessionID: "session-1", RequestID: "request-1",
		RiskLevel: "medium", RiskIncomplete: &incomplete,
		RiskReasons: []string{"executes_command", "requests_permissions"},
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var decoded DaemonEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.RiskIncomplete == nil || *decoded.RiskIncomplete {
		t.Fatalf("explicit complete classification did not round-trip: %+v", decoded)
	}
	if got := strings.Join(decoded.RiskReasons, ","); got != "executes_command,requests_permissions" {
		t.Fatalf("risk reasons=%q", got)
	}
}

func TestApprovalSecurityContextRoundTrip(t *testing.T) {
	want := ApprovalSecurityContext{
		SchemaVersion:            1,
		RiskLevel:                "high",
		ClassificationIncomplete: true,
		RiskReasons:              []string{RiskReasonExecutesCommand},
		AllowedActions:           []string{"once", "reject"},
	}
	raw, err := json.Marshal(DaemonEvent{
		Type: "approval_request", SessionID: "session-1", RequestID: "request-1",
		SecurityContext: &want,
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded DaemonEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.SecurityContext == nil {
		t.Fatal("security context was not preserved")
	}
	got := decoded.SecurityContext
	if got.SchemaVersion != 1 || got.RiskLevel != "high" || !got.ClassificationIncomplete {
		t.Fatalf("security context facts=%+v", got)
	}
	if strings.Join(got.RiskReasons, ",") != RiskReasonExecutesCommand || strings.Join(got.AllowedActions, ",") != "once,reject" {
		t.Fatalf("security context lists=%+v", got)
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

func TestMemoryMcpGrantWireRoundTrip(t *testing.T) {
	request := MemoryMcpGrantRequest{Type: "memory_mcp_grant", RequestID: "corr-1"}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"type":"memory_mcp_grant"`) ||
		!strings.Contains(string(encoded), `"request_id":"corr-1"`) {
		t.Fatalf("request wire shape changed: %s", encoded)
	}

	result := MemoryMcpGrantResult{
		Type: "memory_mcp_grant_result", RequestID: "corr-1",
		Grant: "token", ExpiresIn: 300, TokenType: "extension_capability",
		InstallationID: "i-1", ProviderPublicOrigin: "https://memory.example",
		Services: []string{"memory.mcp"},
	}
	encodedResult, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"type":"memory_mcp_grant_result"`, `"expires_in":300`,
		`"installation_id":"i-1"`, `"provider_public_origin":"https://memory.example"`,
	} {
		if !strings.Contains(string(encodedResult), want) {
			t.Fatalf("result wire missing %s: %s", want, encodedResult)
		}
	}

	failure := MemoryMcpGrantError{Type: "memory_mcp_grant_error", RequestID: "corr-2", Code: "no_installation"}
	encodedFailure, err := json.Marshal(failure)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encodedFailure), `"code":"no_installation"`) {
		t.Fatalf("error wire shape changed: %s", encodedFailure)
	}
}

func TestClientMessageDecodesMemoryMcpReplies(t *testing.T) {
	inbound := `{"type":"memory_mcp_grant_result","request_id":"r1","grant":"g","expires_in":240,` +
		`"token_type":"extension_capability","installation_id":"i1",` +
		`"provider_public_origin":"https://memory.example","services":["memory.mcp"]}`
	var message ClientMessage
	if err := json.Unmarshal([]byte(inbound), &message); err != nil {
		t.Fatal(err)
	}
	if message.Type != "memory_mcp_grant_result" || message.Grant != "g" ||
		message.ExpiresIn != 240 || message.InstallationID != "i1" ||
		message.ProviderPublicOrigin != "https://memory.example" {
		t.Fatalf("decode mismatch: %+v", message)
	}

	errorInbound := `{"type":"memory_mcp_grant_error","request_id":"r2","code":"service_disabled"}`
	var errorMessage ClientMessage
	if err := json.Unmarshal([]byte(errorInbound), &errorMessage); err != nil {
		t.Fatal(err)
	}
	if errorMessage.GrantErrorCode != "service_disabled" {
		t.Fatalf("error code decode mismatch: %+v", errorMessage)
	}
}

func TestPhase2ContextMessagesRoundTrip(t *testing.T) {
	req := MemoryContextGrantRequest{Type: "memory_context_grant", RequestID: "r1", SessionID: "ses-1"}
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal grant request: %v", err)
	}
	var decodedReq MemoryContextGrantRequest
	if err := json.Unmarshal(encoded, &decodedReq); err != nil {
		t.Fatalf("unmarshal grant request: %v", err)
	}
	if decodedReq.SessionID != "ses-1" || decodedReq.RequestID != "r1" {
		t.Fatalf("grant request round trip mismatch: %+v", decodedReq)
	}

	ack := SessionRegistrationAck{Type: "session_registration_ack", SessionID: "ses-1", Status: "ready"}
	ackEncoded, err := json.Marshal(ack)
	if err != nil {
		t.Fatalf("marshal ack: %v", err)
	}
	var decodedAck SessionRegistrationAck
	if err := json.Unmarshal(ackEncoded, &decodedAck); err != nil {
		t.Fatalf("unmarshal ack: %v", err)
	}
	if decodedAck.Status != "ready" || decodedAck.SessionID != "ses-1" {
		t.Fatalf("ack round trip mismatch: %+v", decodedAck)
	}
}
