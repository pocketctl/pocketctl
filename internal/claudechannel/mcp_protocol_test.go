package claudechannel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMCPInitializeResultAdvertisesChannelCapability verifies the wire shape
// of the Channel server's initialize result, as recorded by the Task 4
// contract spike. The result MUST advertise ONLY the two experimental
// capability keys; it MUST NOT advertise tools/resources/prompts.
func TestMCPInitializeResultAdvertisesChannelCapability(t *testing.T) {
	result := NewInitializeResult()
	if result.ProtocolVersion != MCPProtocolVersion {
		t.Fatalf("protocolVersion=%q want %q", result.ProtocolVersion, MCPProtocolVersion)
	}
	body, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, key := range []string{`"claude/channel":{}`, `"claude/channel/permission":{}`} {
		if !strings.Contains(text, key) {
			t.Fatalf("initialize result missing experimental key %s: %s", key, text)
		}
	}
	for _, forbidden := range []string{`"tools"`, `"resources"`, `"prompts"`} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("initialize result must not advertise %s: %s", forbidden, text)
		}
	}
}

// TestMCPVerdictShapeAllowsAndDenies verifies the verdict notification wire
// shape and that only allow/deny are permitted. "always", "acceptForSession"
// and "" must fail closed.
func TestMCPVerdictShapeAllowsAndDenies(t *testing.T) {
	tests := []struct {
		name     string
		behavior string
		ok       bool
	}{
		{"allow", BehaviorAllow, true},
		{"deny", BehaviorDeny, true},
		{"always rejected", "always", false},
		{"acceptForSession rejected", "acceptForSession", false},
		{"empty rejected", "", false},
		{"cancel rejected", "cancel", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := PermissionVerdictParams{
				RequestID: "abcde", Behavior: tt.behavior,
			}
			_, err := BuildVerdictNotification(params)
			if tt.ok && err != nil {
				t.Fatalf("expected ok, got %v", err)
			}
			if !tt.ok && err == nil {
				t.Fatalf("expected error for behavior %q", tt.behavior)
			}
		})
	}
}

// TestMCPVerdictNotificationUsesVerdictMethod verifies the Channel response
// uses the official verdict method. Claude's request uses the distinct
// notifications/claude/channel/permission_request method.
func TestMCPVerdictNotificationUsesVerdictMethod(t *testing.T) {
	notification, err := BuildVerdictNotification(PermissionVerdictParams{
		RequestID: "abcde", Behavior: BehaviorAllow,
	})
	if err != nil {
		t.Fatal(err)
	}
	if notification.Method != MethodChannelPermission {
		t.Fatalf("method=%q want %q", notification.Method, MethodChannelPermission)
	}
	if notification.JSONRPC != JSONRPCVersion {
		t.Fatalf("jsonrpc=%q want %q", notification.JSONRPC, JSONRPCVersion)
	}
	if IsVerdict(notification.Params) == false {
		t.Fatalf("IsVerdict must detect behavior-bearing params")
	}
}

// TestMCPValidatePermissionRequestFields verifies the official four string
// fields are validated. Claude does not send session_id or permission_mode.
func TestMCPValidatePermissionRequestFields(t *testing.T) {
	tests := []struct {
		name    string
		params  PermissionRequestParams
		wantErr bool
	}{
		{"valid", PermissionRequestParams{
			RequestID: "abcde", ToolName: "Bash", Description: "do thing", InputPreview: "echo ok",
		}, false},
		{"missing request", PermissionRequestParams{
			ToolName: "Bash", Description: "x", InputPreview: "x",
		}, true},
		{"missing tool", PermissionRequestParams{
			RequestID: "abcde", Description: "x", InputPreview: "x",
		}, true},
		{"missing description", PermissionRequestParams{
			RequestID: "abcde", ToolName: "Bash", InputPreview: "x",
		}, true},
		{"missing input preview", PermissionRequestParams{
			RequestID: "abcde", ToolName: "Bash", Description: "x",
		}, true},
		{"uppercase request id", PermissionRequestParams{
			RequestID: "ABCDE", ToolName: "Bash", Description: "x", InputPreview: "x",
		}, true},
		{"request id containing l", PermissionRequestParams{
			RequestID: "ablde", ToolName: "Bash", Description: "x", InputPreview: "x",
		}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, _ := json.Marshal(tt.params)
			_, err := ValidatePermissionRequest(raw)
			if tt.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// TestMCPIPRequestIsNotVerdict verifies IsVerdict returns false for request
// params (no behavior field) so the dispatch layer knows which side sent it.
func TestMCPIPRequestIsNotVerdict(t *testing.T) {
	request := PermissionRequestParams{
		RequestID: "abcde", ToolName: "Bash", Description: "x", InputPreview: "x",
	}
	raw, _ := json.Marshal(request)
	if IsVerdict(raw) {
		t.Fatal("request params without behavior must not be classified as verdict")
	}
}

// TestMCPFrameEncodingAndLimit verifies EncodeFrame emits newline-terminated
// JSON and enforces the 64KiB cap.
func TestMCPFrameEncodingAndLimit(t *testing.T) {
	body, err := EncodeFrame(map[string]string{"hello": "world"})
	if err != nil {
		t.Fatal(err)
	}
	if string(body[len(body)-1]) != "\n" {
		t.Fatalf("frame must be newline terminated: %q", body)
	}
	// Oversized payload.
	big := map[string]string{"k": strings.Repeat("x", MaxJSONRPCFrame)}
	if _, err := EncodeFrame(big); err == nil {
		t.Fatal("EncodeFrame must reject oversized payload")
	}
}

// TestMCPUnknownMethodIgnoredWithoutParams verifies that an unknown method
// can be decoded without inspecting params (design §Task 4: "未知
// method/field 忽略并 debug 记录 method 名,不记录 params").
func TestMCPUnknownMethodIgnoredWithoutParams(t *testing.T) {
	raw := []byte(`{"jsonrpc":"2.0","method":"notifications/someFutureThing","params":{"secret":"do_not_log"}}`)
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	if req.Method != "notifications/someFutureThing" {
		t.Fatalf("method=%q", req.Method)
	}
	// Params are preserved but the dispatch layer promises not to log them;
	// this test only asserts the decoder keeps them accessible.
	if len(req.Params) == 0 {
		t.Fatal("params should be preserved for caller inspection")
	}
}

// TestMCPPermissionRequestWireMatchesFixture verifies our parser accepts the
// redacted four-field fixture derived from the official Channels contract.
// A live Claude 2.1.211 round trip remains a release gate.
func TestMCPPermissionRequestWireMatchesFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "permission-request.json"))
	if err != nil {
		t.Fatal(err)
	}
	var envelope Request
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Method != "notifications/claude/channel/permission_request" {
		t.Fatalf("method=%q want official permission_request method", envelope.Method)
	}
	if IsVerdict(envelope.Params) {
		t.Fatal("fixture is a request, not a verdict")
	}
	params, err := ValidatePermissionRequest(envelope.Params)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if params.RequestID != "abcde" {
		t.Fatalf("request_id=%q want abcde", params.RequestID)
	}
	if params.ToolName != "Bash" {
		t.Fatalf("tool_name=%q want Bash", params.ToolName)
	}
}

// TestMCPProtocolVersionPinned verifies the protocol version is pinned so a
// regression is caught at compile-time comparison.
func TestMCPProtocolVersionPinned(t *testing.T) {
	if MCPProtocolVersion != "2025-06-18" {
		t.Fatalf("protocol version drifted: %q", MCPProtocolVersion)
	}
}
