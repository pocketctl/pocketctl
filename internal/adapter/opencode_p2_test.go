package adapter

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func TestConvertOpencodePart_StructuredDisplayParts(t *testing.T) {
	tests := []struct {
		name  string
		raw   string
		want  string
		check func(t *testing.T, event mapEvent)
	}{
		{
			name: "file",
			raw:  `{"id":"prt_file","sessionID":"ses_1","messageID":"msg_1","type":"file","mime":"text/plain","filename":"notes.txt","url":"file:///tmp/notes.txt","source":{"type":"file","path":"/tmp/notes.txt"}}`,
			want: "agent_file",
			check: func(t *testing.T, event mapEvent) {
				if event.filename != "notes.txt" || event.mime != "text/plain" || event.url != "file:///tmp/notes.txt" || len(event.partSource) == 0 {
					t.Fatalf("file event=%+v", event)
				}
			},
		},
		{
			name: "patch",
			raw:  `{"id":"prt_patch","sessionID":"ses_1","messageID":"msg_1","type":"patch","hash":"abc123","files":["a.go","b.go"]}`,
			want: "agent_patch",
			check: func(t *testing.T, event mapEvent) {
				if event.hash != "abc123" || !reflect.DeepEqual(event.files, []string{"a.go", "b.go"}) {
					t.Fatalf("patch event=%+v", event)
				}
			},
		},
		{
			name: "subtask",
			raw:  `{"id":"prt_sub","sessionID":"ses_1","messageID":"msg_1","type":"subtask","prompt":"Inspect tests","description":"Find regressions","agent":"explore","model":{"providerID":"openai","modelID":"gpt-5"},"command":"/review"}`,
			want: "agent_subtask",
			check: func(t *testing.T, event mapEvent) {
				if event.prompt != "Inspect tests" || event.description != "Find regressions" || event.agent != "explore" || event.model != "openai/gpt-5" || event.command != "/review" {
					t.Fatalf("subtask event=%+v", event)
				}
			},
		},
		{
			name: "agent",
			raw:  `{"id":"prt_agent","sessionID":"ses_1","messageID":"msg_1","type":"agent","name":"build","source":{"value":"@build","start":0,"end":6}}`,
			want: "agent_profile",
			check: func(t *testing.T, event mapEvent) {
				if event.profileName != "build" || len(event.partSource) == 0 {
					t.Fatalf("agent event=%+v", event)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			part, err := ParseOpencodePart([]byte(test.raw))
			if err != nil {
				t.Fatal(err)
			}
			events := ConvertOpencodePart(part, "assistant", "openai/gpt-5")
			if len(events) != 1 || events[0].Type != test.want || events[0].PartID != part.ID || events[0].MessageID != part.MessageID {
				t.Fatalf("events=%+v", events)
			}
			test.check(t, mapEvent{
				filename: events[0].Filename, mime: events[0].Mime, url: events[0].URL,
				partSource: events[0].PartSource, hash: events[0].Hash, files: events[0].Files,
				prompt: events[0].Prompt, description: events[0].Description, agent: events[0].Agent,
				model: events[0].Model, command: events[0].Command, profileName: events[0].ProfileName,
			})
		})
	}
}

type mapEvent struct {
	filename, mime, url, hash, prompt, description, agent, model, command, profileName string
	partSource                                                                         json.RawMessage
	files                                                                              []string
}

func TestOpencodeSync_StructuredPartsDeduplicate(t *testing.T) {
	syncer := NewOpencodeSync("ses_1", false)
	parts := []OpencodePart{
		{ID: "prt_patch", MessageID: "msg_1", Type: "patch", Hash: "h1", Files: []string{"a.go"}},
		{ID: "prt_sub", MessageID: "msg_1", Type: "subtask", Prompt: "Inspect", Description: "Read only", Agent: "explore"},
	}
	first := syncer.Diff([]OpencodeMessageWithParts{mkMsg("msg_1", "assistant", "gpt-5", 1, 2, parts...)})
	if len(first) < 2 || first[0].Type != "agent_patch" || first[1].Type != "agent_subtask" {
		t.Fatalf("first=%+v", first)
	}
	for _, event := range syncer.Diff([]OpencodeMessageWithParts{mkMsg("msg_1", "assistant", "gpt-5", 1, 2, parts...)}) {
		if event.Type == "agent_patch" || event.Type == "agent_subtask" {
			t.Fatalf("unchanged structured Part repeated: %+v", event)
		}
	}
}

func TestOpencodeServer_StatusAndTodos(t *testing.T) {
	var calls int
	srv := testOpencodeHTTPServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Query().Get("directory") != "/work/a b" {
			t.Errorf("directory=%q", r.URL.Query().Get("directory"))
		}
		switch calls {
		case 1:
			if r.Method != http.MethodGet || r.URL.Path != "/session/status" {
				t.Errorf("status request=%s %s", r.Method, r.URL.Path)
			}
			json.NewEncoder(w).Encode(map[string]any{
				"ses_busy":  map[string]any{"type": "busy"},
				"ses_retry": map[string]any{"type": "retry", "attempt": 3, "message": "rate limited", "next": 1234},
				"ses_idle":  map[string]any{"type": "idle"},
			})
		case 2:
			if r.Method != http.MethodGet || r.URL.EscapedPath() != "/session/ses%2F1/todo" {
				t.Errorf("todo request=%s %s", r.Method, r.URL.EscapedPath())
			}
			json.NewEncoder(w).Encode([]map[string]any{{"content": "Implement UI", "status": "in_progress", "priority": "high"}})
		default:
			t.Fatalf("unexpected call %d", calls)
		}
	})

	statuses, err := srv.ListSessionStatuses(context.Background(), "/work/a b")
	if err != nil || statuses["ses_busy"].Type != "busy" || statuses["ses_retry"].Attempt != 3 || statuses["ses_retry"].Next != 1234 || statuses["ses_idle"].Type != "idle" {
		t.Fatalf("statuses=%+v err=%v", statuses, err)
	}
	todos, err := srv.ListTodos(context.Background(), "ses/1", "/work/a b")
	if err != nil || len(todos) != 1 || todos[0].Content != "Implement UI" || todos[0].Status != "in_progress" || todos[0].Priority != "high" {
		t.Fatalf("todos=%+v err=%v", todos, err)
	}
}

func TestParseTodoUpdated(t *testing.T) {
	sessionID, todos, ok := ParseTodoUpdated(json.RawMessage(`{"sessionID":"ses_1","todos":[{"content":"Ship","status":"pending","priority":"medium"}]}`))
	if !ok || sessionID != "ses_1" || len(todos) != 1 || todos[0].Content != "Ship" {
		t.Fatalf("session=%q todos=%+v ok=%v", sessionID, todos, ok)
	}
}

func TestOpencodeSync_NativeStatusOverridesInference(t *testing.T) {
	syncer := NewOpencodeSync("ses_1", false)
	completed := []OpencodeMessageWithParts{mkMsg("msg_1", "assistant", "gpt-5", 1, 2)}
	events := syncer.DiffWithNativeStatus(completed, &OpencodeSessionStatus{Type: "retry", Attempt: 2, Message: "try later", Next: 4567})
	last := events[len(events)-1]
	if last.Type != "session_status" || last.Status != "retry" || last.Attempt != 2 || last.Error != "try later" || last.RetryAt != 4567 {
		t.Fatalf("native retry event=%+v", last)
	}
	for _, event := range syncer.DiffWithNativeStatus(completed, &OpencodeSessionStatus{Type: "busy"}) {
		if event.Type == "session_status" && event.Status == "idle" {
			t.Fatalf("snapshot inference overrode native status: %+v", event)
		}
	}
}
