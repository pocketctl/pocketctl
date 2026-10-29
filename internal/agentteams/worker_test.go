package agentteams

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkerUsageDeduplicatesOriginalTurns(t *testing.T) {
	const room = "!own:local"
	detail := `{"messages":[{"role":"assistant","metadata":{"original_id":"turn-1","finished_at":"2026-10-28T10:00:00Z","metadata":{"qwenpaw_turn_usage":{"usage":{"model_name":"m","prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cache_read_tokens":80,"cache_write_tokens":0}}}}},{"role":"assistant","metadata":{"original_id":"turn-1","finished_at":"2026-10-28T10:00:00Z","metadata":{"qwenpaw_turn_usage":{"usage":{"model_name":"m","prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cache_read_tokens":80,"cache_write_tokens":0}}}}}],"status":"idle"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/chats":
			w.Write([]byte(`[{"id":"chat-1","session_id":"matrix:!own:local","channel":"agentteams_matrix"}]`))
		case "/api/chats/chat-1":
			w.Write([]byte(detail))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	client, err := NewWorkerClient(server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	value, err := client.Usage(context.Background(), room)
	if err != nil {
		t.Fatal(err)
	}
	if value.ChatID != "chat-1" || len(value.Turns) != 1 || value.Turns[0].InputTokens != 20 || value.Turns[0].CacheReadTokens != 80 || value.Turns[0].TotalTokens != 110 {
		t.Fatalf("unexpected usage %+v", value)
	}
}

func TestWorkerUsageRejectsUnfinishedConflictingAndInvalidFacts(t *testing.T) {
	good := `{"role":"assistant","metadata":{"original_id":"t","finished_at":"2026-10-28T10:00:00Z","metadata":{"qwenpaw_turn_usage":{"usage":{"model_name":"m","prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cache_read_tokens":80,"cache_write_tokens":0}}}}}`
	for _, test := range []struct{ name, body string }{
		{"unfinished", `{"messages":[{"role":"assistant","metadata":{"original_id":"t","metadata":{"qwenpaw_turn_usage":{"usage":{}}}}}]}`},
		{"unknown", `{"messages":[]}`},
		{"conflicting", `{"messages":[` + good + `,{"role":"assistant","metadata":{"original_id":"t","finished_at":"2026-10-28T10:00:00Z","metadata":{"qwenpaw_turn_usage":{"usage":{"model_name":"m","prompt_tokens":101,"completion_tokens":10,"total_tokens":111,"cache_read_tokens":80,"cache_write_tokens":0}}}}}]}`},
		{"cache-over-input", `{"messages":[{"role":"assistant","metadata":{"original_id":"t","finished_at":"2026-10-28T10:00:00Z","metadata":{"qwenpaw_turn_usage":{"usage":{"model_name":"m","prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cache_read_tokens":8,"cache_write_tokens":0}}}}}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseWorkerUsage([]byte(test.body)); err == nil {
				t.Fatal("invalid or unavailable usage accepted")
			}
		})
	}
}
func TestWorkerUsageRejectsAmbiguousChat(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chats" {
			t.Error("must not read unbound chat")
		}
		w.Write([]byte(`[{"id":"a","session_id":"matrix:!r:x","channel":"agentteams_matrix"},{"id":"b","session_id":"matrix:!r:x","channel":"agentteams_matrix"}]`))
	}))
	defer server.Close()
	client, _ := NewWorkerClient(server.URL, nil)
	if _, err := client.Usage(context.Background(), "!r:x"); err == nil {
		t.Fatal("ambiguous identity")
	}
}
