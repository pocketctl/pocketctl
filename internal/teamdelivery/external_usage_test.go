package teamdelivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentteams"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestExternalUsageAcknowledgementBoundToOriginal(t *testing.T) {
	for _, scenario := range []string{"new", "replay", "missing", "wrong-call", "wrong-count"} {
		t.Run(scenario, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/team/daemons/daemon/calls/call/external-usage" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer current" {
					t.Error("wrong transport binding")
				}
				var input ExternalUsageRequest
				if json.NewDecoder(r.Body).Decode(&input) != nil || input.Phase != "account" || input.Usage.Turns[0].TotalTokens != 110 {
					t.Error("usage dropped")
				}
				response := map[string]any{"call_id": "call", "request_id": "team-call", "recorded_turns": 1, "new_turns": 1, "cost_status": "unavailable"}
				switch scenario {
				case "replay":
					response["new_turns"] = 0
				case "missing":
					delete(response, "recorded_turns")
				case "wrong-call":
					response["call_id"] = "another"
				case "wrong-count":
					response["recorded_turns"] = 2
				}
				json.NewEncoder(w).Encode(response)
			}))
			defer server.Close()
			client, _ := NewClient(server.URL, func() string { return "current" }, nil)
			err := client.RecordExternalUsage(context.Background(), ExternalUsageRequest{ExternalAuthorizationRequest: ExternalAuthorizationRequest{Authorization: protocol.CollaborationAuthorization{CallID: "call", DaemonID: "daemon"}, RequestID: "team-call", NativeSessionID: "native", Phase: "account"}, RemoteTaskID: "remote", Usage: agentteams.WorkerUsage{Turns: []agentteams.TurnUsage{{TotalTokens: 110}}}})
			valid := scenario == "new" || scenario == "replay"
			if (err == nil) != valid {
				t.Fatal("incorrect receipt accepted", err)
			}
		})
	}
}
