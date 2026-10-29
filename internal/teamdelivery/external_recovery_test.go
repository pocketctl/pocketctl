package teamdelivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestExternalRecoveryTransportBindsOriginalOperation(t *testing.T) {
	for _, scenario := range []string{"valid", "wrong-operation", "wrong-call", "missing-ack", "invalid-command"} {
		t.Run(scenario, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer current" {
					t.Error("missing current authentication")
				}
				if r.Method == "GET" {
					if r.URL.Path != "/api/team/daemons/daemon/external-recovery" {
						t.Error("wrong daemon")
					}
					action := "query"
					if scenario == "invalid-command" {
						action = "submit_new"
					}
					json.NewEncoder(w).Encode(map[string]any{"commands": []ExternalRecoveryCommand{{CallID: "call", OperationID: "operation", Action: action, OriginalRequestID: "original", NativeSessionID: "native", TeamSessionID: "team-session"}}})
					return
				}
				if r.URL.Path != "/api/team/daemons/daemon/calls/call/external-recovery" {
					t.Error("wrong original call")
				}
				var body ExternalRecoveryReport
				if json.NewDecoder(r.Body).Decode(&body) != nil || body.OperationID != "operation" || body.RequestID != "original" || body.Result.State != "absent" {
					t.Error("original payload lost")
				}
				response := map[string]any{"call_id": "call", "operation_id": "operation", "recorded": true}
				if scenario == "wrong-operation" {
					response["operation_id"] = "another"
				}
				if scenario == "wrong-call" {
					response["call_id"] = "another"
				}
				if scenario == "missing-ack" {
					delete(response, "recorded")
				}
				json.NewEncoder(w).Encode(response)
			}))
			defer server.Close()
			client, _ := NewClient(server.URL, func() string { return "current" }, nil)
			commands, err := client.PendingExternalRecovery(context.Background(), "daemon")
			if scenario == "invalid-command" {
				if err == nil {
					t.Fatal("invalid command accepted")
				}
				return
			}
			if err != nil || len(commands) != 1 {
				t.Fatal(err, commands)
			}
			err = client.RecordExternalRecovery(context.Background(), ExternalRecoveryReport{ExternalAuthorizationRequest: ExternalAuthorizationRequest{Authorization: protocol.CollaborationAuthorization{CallID: "call", DaemonID: "daemon"}, RequestID: "original", NativeSessionID: "native", Phase: "account"}, OperationID: "operation", Result: ExternalRecoveryResult{State: "absent"}})
			if (err == nil) != (scenario == "valid") {
				t.Fatal("incorrect acknowledgement accepted", err)
			}
		})
	}
}
