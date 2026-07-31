package agentcontrol

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestControlProtocolRoundTrip(t *testing.T) {
	payload, err := json.Marshal(AcquirePayload{
		CWD:         "/tmp/project",
		Intent:      IntentResume,
		SessionID:   "ses_123",
		Fork:        true,
		OperationID: "op_123",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := Request{
		Version:   ProtocolVersion,
		ID:        "req_123",
		Method:    MethodRuntimeAcquire,
		Agent:     AgentOpenCode,
		ClientPID: 42,
		Payload:   payload,
	}
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var got Request
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Version != want.Version || got.ID != want.ID || got.Method != want.Method || got.Agent != want.Agent || got.ClientPID != want.ClientPID {
		t.Fatalf("round trip mismatch: got %+v want %+v", got, want)
	}
	if err := ValidateRequest(got); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	var gotPayload AcquirePayload
	if err := json.Unmarshal(got.Payload, &gotPayload); err != nil {
		t.Fatal(err)
	}
	if gotPayload.SessionID != "ses_123" || !gotPayload.Fork {
		t.Fatalf("payload mismatch: %+v", gotPayload)
	}
}

func TestControlProtocolAcceptsCodexAndRemoteURI(t *testing.T) {
	req := Request{Version: ProtocolVersion, ID: "req-codex", Method: MethodRuntimeStatus, Agent: AgentCodex}
	if err := ValidateRequest(req); err != nil {
		t.Fatalf("Codex request rejected: %v", err)
	}
	raw, err := json.Marshal(AcquireResult{Mode: string(LaunchManaged), RemoteURI: "unix:///tmp/codex.sock"})
	if err != nil {
		t.Fatal(err)
	}
	var result AcquireResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.RemoteURI != "unix:///tmp/codex.sock" {
		t.Fatalf("result=%+v", result)
	}
}

func TestControlProtocolRejectsInvalidEnvelope(t *testing.T) {
	tests := []struct {
		name string
		req  Request
		code string
	}{
		{"version", Request{Version: 99, ID: "r", Method: MethodRuntimeStatus, Agent: AgentOpenCode}, ErrUnsupportedVersion},
		{"request id", Request{Version: ProtocolVersion, Method: MethodRuntimeStatus, Agent: AgentOpenCode}, ErrInvalidRequest},
		{"method", Request{Version: ProtocolVersion, ID: "r", Method: "unknown", Agent: AgentOpenCode}, ErrInvalidRequest},
		{"agent", Request{Version: ProtocolVersion, ID: "r", Method: MethodRuntimeStatus, Agent: "other"}, ErrInvalidRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRequest(tt.req)
			var protocolErr *ProtocolError
			if !errors.As(err, &protocolErr) || protocolErr.Code != tt.code {
				t.Fatalf("error=%v, want protocol code %q", err, tt.code)
			}
		})
	}
}

func TestControlProtocolRejectsOversizedFrame(t *testing.T) {
	if err := ValidateFrameSize(make([]byte, MaxFrameSize)); err != nil {
		t.Fatalf("max-size frame rejected: %v", err)
	}
	err := ValidateFrameSize(make([]byte, MaxFrameSize+1))
	var protocolErr *ProtocolError
	if !errors.As(err, &protocolErr) || protocolErr.Code != ErrInvalidRequest {
		t.Fatalf("oversized frame error=%v", err)
	}
}

func TestAcquireValidation(t *testing.T) {
	valid := AcquirePayload{CWD: "/tmp/project", Intent: IntentNew, OperationID: "op_1"}
	if err := ValidateAcquire(valid); err != nil {
		t.Fatalf("valid acquire rejected: %v", err)
	}

	tests := []struct {
		name string
		edit func(*AcquirePayload)
	}{
		{"missing cwd", func(p *AcquirePayload) { p.CWD = "" }},
		{"long cwd", func(p *AcquirePayload) { p.CWD = strings.Repeat("x", MaxCWDLength+1) }},
		{"bad intent", func(p *AcquirePayload) { p.Intent = "takeover" }},
		{"missing operation", func(p *AcquirePayload) { p.OperationID = "" }},
		{"resume missing session", func(p *AcquirePayload) { p.Intent = IntentResume }},
		{"long session", func(p *AcquirePayload) {
			p.Intent = IntentResume
			p.SessionID = strings.Repeat("s", MaxSessionIDLength+1)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload := valid
			tt.edit(&payload)
			err := ValidateAcquire(payload)
			var protocolErr *ProtocolError
			if !errors.As(err, &protocolErr) || protocolErr.Code != ErrInvalidRequest {
				t.Fatalf("error=%v, want invalid_request", err)
			}
		})
	}
}
