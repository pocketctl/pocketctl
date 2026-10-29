package teamdelivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestExternalStopRequiresExactAcknowledgement(t *testing.T) {
	for _, scenario := range []string{"valid", "wrong-call", "wrong-request", "missing-ack", "unavailable"} {
		t.Run(scenario, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/team/daemons/daemon/calls/call/external-stop" || r.Header.Get("Authorization") != "Bearer current" {
					t.Error("stop receipt routing or authentication changed")
				}
				var input ExternalStopReport
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.State != "cancelled" || input.RequestID != "original" || input.NativeSessionID != "native" {
					t.Error("original stop identity lost")
				}
				if scenario == "unavailable" {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				out := map[string]any{"call_id": "call", "request_id": "original", "recorded": true}
				switch scenario {
				case "wrong-call":
					out["call_id"] = "other"
				case "wrong-request":
					out["request_id"] = "other"
				case "missing-ack":
					delete(out, "recorded")
				}
				_ = json.NewEncoder(w).Encode(out)
			}))
			defer server.Close()
			client, _ := NewClient(server.URL, func() string { return "current" }, nil)
			err := client.RecordExternalStop(context.Background(), ExternalStopReport{Authorization: protocol.CollaborationAuthorization{CallID: "call", DaemonID: "daemon"}, RequestID: "original", NativeSessionID: "native", State: "cancelled"})
			if (err == nil) != (scenario == "valid") {
				t.Fatal("incorrect acknowledgement result", err)
			}
		})
	}
}
