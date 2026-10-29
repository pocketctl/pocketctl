package teamdelivery

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestExternalAuthorizationBindsResponseAndUsesCurrentToken(t *testing.T) {
	input := ExternalAuthorizationRequest{Authorization: protocol.CollaborationAuthorization{CallID: "call", DaemonID: "daemon"}, RequestID: "original", NativeSessionID: "native", Phase: "execute"}
	for _, scenario := range []string{"valid", "wrong-call", "wrong-request", "wrong-native", "wrong-phase", "wrong-provider", "denied", "empty", "not-ready", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			token := "first"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/api/team/daemons/daemon/calls/call/external-authorization" || r.Header.Get("Authorization") != "Bearer fresh" {
					t.Error("request binding or current token lost")
				}
				var got ExternalAuthorizationRequest
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil || got.RequestID != input.RequestID || got.Authorization.CallID != "call" {
					t.Error("frozen authority lost")
				}
				if scenario == "not-ready" {
					w.WriteHeader(503)
					w.Write([]byte(`{"error":{"code":"external_call_not_ready"}}`))
					return
				}
				if scenario == "missing" {
					w.WriteHeader(404)
					return
				}
				response := map[string]any{"authorized": true, "call_id": "call", "request_id": "original", "native_session_id": "native", "phase": "execute", "provider": "agentteams"}
				switch scenario {
				case "wrong-call":
					response["call_id"] = "another"
				case "wrong-request":
					response["request_id"] = "another"
				case "wrong-native":
					response["native_session_id"] = "another"
				case "wrong-phase":
					response["phase"] = "observe"
				case "wrong-provider":
					response["provider"] = "claude-code"
				case "denied":
					response["authorized"] = false
				case "empty":
					response = map[string]any{}
				}
				json.NewEncoder(w).Encode(response)
			}))
			defer server.Close()
			client, err := NewClient(server.URL, func() string { return token }, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			token = "fresh"
			err = client.AuthorizeExternalExecution(context.Background(), input)
			if scenario == "valid" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("invalid authority accepted")
			}
			if scenario == "not-ready" {
				var failure *HTTPError
				if !errors.As(err, &failure) || failure.Code != "external_call_not_ready" {
					t.Fatalf("lost transient result: %v", err)
				}
			}
		})
	}
}
