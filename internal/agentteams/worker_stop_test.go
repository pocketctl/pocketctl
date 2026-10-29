package agentteams

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkerStopExactChatRequiresIdleReadback(t *testing.T) {
	for _, scenario := range []string{"stopped", "still-running", "wrong-chat", "denied"} {
		t.Run(scenario, func(t *testing.T) {
			status := "running"
			posts := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/chats" {
					json.NewEncoder(w).Encode([]any{map[string]any{"id": "original-chat", "session_id": "matrix:!room:local", "channel": "agentteams_matrix", "status": status}})
					return
				}
				if r.URL.Path != "/api/console/chat/stop" || r.URL.Query().Get("chat_id") != "original-chat" || r.Method != "POST" {
					t.Error("unbound stop")
					w.WriteHeader(400)
					return
				}
				posts++
				if scenario == "denied" {
					w.WriteHeader(401)
					return
				}
				if scenario != "still-running" {
					status = "idle"
				}
				json.NewEncoder(w).Encode(map[string]any{"stopped": true})
			}))
			defer server.Close()
			c, _ := NewWorkerClient(server.URL, nil)
			expected := "original-chat"
			if scenario == "wrong-chat" {
				expected = "other-chat"
			}
			_, err := c.StopChat(context.Background(), "!room:local", expected)
			if scenario == "stopped" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("unconfirmed stop reported success")
			}
			if scenario == "wrong-chat" && posts != 0 {
				t.Fatal("stopped a different chat")
			}
		})
	}
}
