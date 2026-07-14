package adapter

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func testOpencodeHTTPServer(t *testing.T, handler http.HandlerFunc) *OpencodeServer {
	t.Helper()
	srv := NewOpencodeServer("unused")
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder.Result(), nil
	})}
	srv.mu.Lock()
	srv.baseURL = "http://opencode.test"
	srv.http = client
	srv.httpLong = client
	srv.mu.Unlock()
	return srv
}

func TestOpencodeServer_Commands(t *testing.T) {
	var calls int
	srv := testOpencodeHTTPServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if got := r.URL.Query().Get("directory"); got != "/work/a b" {
			t.Errorf("directory=%q", got)
		}
		switch calls {
		case 1:
			if r.Method != http.MethodGet || r.URL.Path != "/command" {
				t.Errorf("list request = %s %s", r.Method, r.URL.Path)
			}
			json.NewEncoder(w).Encode([]map[string]any{{
				"name": "review", "description": "Review", "source": "command",
				"template": "Review $ARGUMENTS", "hints": []string{"[scope]"}, "subtask": true,
				"agent": "build", "model": "openai/gpt-5",
			}})
		case 2:
			if r.Method != http.MethodPost || r.URL.EscapedPath() != "/session/ses%2F1/command" {
				t.Errorf("execute request = %s %s", r.Method, r.URL.EscapedPath())
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["command"] != "review" || body["arguments"] != "abc def" {
				t.Errorf("body=%#v", body)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected call %d", calls)
		}
	})
	commands, err := srv.ListCommands(context.Background(), "/work/a b")
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || commands[0].Name != "review" || !commands[0].Subtask || len(commands[0].Hints) != 1 {
		t.Fatalf("commands=%+v", commands)
	}
	if err := srv.ExecuteCommand(context.Background(), "ses/1", "/work/a b", "review", "abc def"); err != nil {
		t.Fatal(err)
	}
}

func TestOpencodeServer_AgentsAndSwitchAgent(t *testing.T) {
	var calls int
	srv := testOpencodeHTTPServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			if r.Method != http.MethodGet || r.URL.Path != "/agent" || r.URL.Query().Get("directory") != "/repo" {
				t.Errorf("agent request=%s %s?%s", r.Method, r.URL.Path, r.URL.RawQuery)
			}
			json.NewEncoder(w).Encode([]map[string]any{
				{"name": "build", "description": "Build", "mode": "primary", "color": "#fff", "model": map[string]any{"providerID": "openai", "modelID": "gpt-5"}, "variant": "high", "options": map[string]any{}, "permission": []any{}},
				{"name": "explore", "mode": "subagent", "hidden": true, "options": map[string]any{}, "permission": []any{}},
			})
		case 2:
			if r.Method != http.MethodPost || r.URL.EscapedPath() != "/api/session/ses%2F1/agent" {
				t.Errorf("switch request=%s %s", r.Method, r.URL.EscapedPath())
			}
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["agent"] != "build" {
				t.Errorf("body=%#v", body)
			}
			w.WriteHeader(http.StatusNoContent)
		}
	})
	agents, err := srv.ListAgents(context.Background(), "/repo")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 2 || agents[0].Model != "openai/gpt-5" || agents[1].Mode != "subagent" || !agents[1].Hidden {
		t.Fatalf("agents=%+v", agents)
	}
	if err := srv.SwitchAgent(context.Background(), "ses/1", "build"); err != nil {
		t.Fatal(err)
	}
}

func TestOpencodeServer_PermissionRoutes(t *testing.T) {
	var calls int
	srv := testOpencodeHTTPServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			if r.Method != http.MethodGet || r.URL.Path != "/permission" {
				t.Errorf("list permission=%s %s", r.Method, r.URL.Path)
			}
			json.NewEncoder(w).Encode([]map[string]any{{"id": "per_1", "sessionID": "ses_1", "permission": "bash", "patterns": []string{"git *"}, "metadata": map[string]any{"command": "git status"}, "always": []string{"git status"}}})
		case 2:
			if r.URL.EscapedPath() != "/permission/per%2F1/reply" {
				t.Errorf("legacy reply path=%s", r.URL.EscapedPath())
			}
			assertJSONField(t, r, "reply", "always")
			w.WriteHeader(http.StatusNoContent)
		case 3:
			if r.URL.EscapedPath() != "/api/session/ses%2F1/permission/per%2F1/reply" {
				t.Errorf("v2 reply path=%s", r.URL.EscapedPath())
			}
			assertJSONField(t, r, "reply", "reject")
			w.WriteHeader(http.StatusNoContent)
		}
	})
	permissions, err := srv.ListPermissions(context.Background())
	if err != nil || len(permissions) != 1 || permissions[0].Permission != "bash" {
		t.Fatalf("permissions=%+v err=%v", permissions, err)
	}
	if err := srv.ReplyPermissionVersioned(context.Background(), "ses/1", "per/1", "always", PermissionVersionLegacy); err != nil {
		t.Fatal(err)
	}
	if err := srv.ReplyPermissionVersioned(context.Background(), "ses/1", "per/1", "reject", PermissionVersionV2); err != nil {
		t.Fatal(err)
	}
}

func TestOpencodeServer_QuestionRoutes(t *testing.T) {
	var calls int
	srv := testOpencodeHTTPServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			if r.Method != http.MethodGet || r.URL.Path != "/question" {
				t.Errorf("list question=%s %s", r.Method, r.URL.Path)
			}
			json.NewEncoder(w).Encode([]map[string]any{{"id": "que_1", "sessionID": "ses_1", "questions": []map[string]any{{"header": "Scope", "question": "Choose", "options": []map[string]any{{"label": "A", "description": "first"}}, "multiple": false, "custom": true}}}})
		case 2:
			if r.URL.EscapedPath() != "/api/session/ses%2F1/question/que%2F1/reply" {
				t.Errorf("reply path=%s", r.URL.EscapedPath())
			}
			var body struct {
				Answers [][]string `json:"answers"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if !reflect.DeepEqual(body.Answers, [][]string{{"A"}}) {
				t.Errorf("answers=%#v", body.Answers)
			}
			w.WriteHeader(http.StatusNoContent)
		case 3:
			if r.URL.EscapedPath() != "/api/session/ses%2F1/question/que%2F1/reject" {
				t.Errorf("reject path=%s", r.URL.EscapedPath())
			}
			w.WriteHeader(http.StatusNoContent)
		}
	})
	questions, err := srv.ListQuestions(context.Background())
	if err != nil || len(questions) != 1 || len(questions[0].Questions) != 1 || !questions[0].Questions[0].Custom {
		t.Fatalf("questions=%+v err=%v", questions, err)
	}
	if err := srv.ReplyQuestion(context.Background(), "ses/1", "que/1", [][]string{{"A"}}); err != nil {
		t.Fatal(err)
	}
	if err := srv.RejectQuestion(context.Background(), "ses/1", "que/1"); err != nil {
		t.Fatal(err)
	}
}

func TestOpencodeServer_V2PendingRoutes(t *testing.T) {
	var calls int
	srv := testOpencodeHTTPServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			if r.URL.EscapedPath() != "/api/session/ses%2F1/permission" {
				t.Errorf("permission path=%s", r.URL.EscapedPath())
			}
			json.NewEncoder(w).Encode([]map[string]any{{"id": "per_2", "sessionID": "ses/1", "action": "edit", "resources": []string{"a"}, "save": []string{"*"}}})
		case 2:
			if r.URL.EscapedPath() != "/api/session/ses%2F1/question" {
				t.Errorf("question path=%s", r.URL.EscapedPath())
			}
			json.NewEncoder(w).Encode([]map[string]any{{"id": "que_2", "sessionID": "ses/1", "questions": []map[string]any{{"question": "Choose", "options": []map[string]any{{"label": "A"}}}}}})
		}
	})
	permissions, err := srv.ListPermissionsV2(context.Background(), "ses/1")
	if err != nil || len(permissions) != 1 || permissions[0].Version != PermissionVersionV2 {
		t.Fatalf("permissions=%+v err=%v", permissions, err)
	}
	questions, err := srv.ListQuestionsV2(context.Background(), "ses/1")
	if err != nil || len(questions) != 1 || questions[0].ID != "que_2" {
		t.Fatalf("questions=%+v err=%v", questions, err)
	}
}

func TestParsePermissionAskedFullLegacyAndV2(t *testing.T) {
	legacy, ok := ParsePermissionAsked(json.RawMessage(`{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["git *"],"metadata":{"command":"git status"},"always":["git status"],"tool":{"messageID":"msg_1","callID":"call_1"}}`))
	if !ok || legacy.Version != PermissionVersionLegacy || legacy.Permission != "bash" || len(legacy.Patterns) != 1 || len(legacy.Always) != 1 || legacy.ToolMessageID != "msg_1" || legacy.ToolCallID != "call_1" {
		t.Fatalf("legacy=%+v ok=%v", legacy, ok)
	}
	v2, ok := ParsePermissionV2Asked(json.RawMessage(`{"request":{"id":"per_2","sessionID":"ses_2","action":"edit","resources":["/tmp/a"],"save":["/tmp/*"],"metadata":{"path":"/tmp/a"},"source":{"type":"tool","messageID":"msg_2","callID":"call_2"}}}`))
	if !ok || v2.Version != PermissionVersionV2 || v2.Permission != "edit" || v2.Patterns[0] != "/tmp/a" || v2.Always[0] != "/tmp/*" || v2.ToolCallID != "call_2" {
		t.Fatalf("v2=%+v ok=%v", v2, ok)
	}
}

func TestParseQuestionAskedFull(t *testing.T) {
	question, ok := ParseQuestionAsked(json.RawMessage(`{"request":{"requestID":"que_1","sessionID":"ses_1","questions":[{"header":"Scope","question":"Choose","options":[{"label":"A","description":"first"},{"label":"B","description":"second"}],"multiple":true,"custom":true}],"tool":{"messageID":"msg_1","callID":"call_1"}}}`))
	if !ok || question.ID != "que_1" || question.SessionID != "ses_1" || question.ToolCallID != "call_1" || len(question.Questions) != 1 || len(question.Questions[0].Options) != 2 || !question.Questions[0].Multiple || !question.Questions[0].Custom {
		t.Fatalf("question=%+v ok=%v", question, ok)
	}
}

func TestParseOutOfBandInteractionResolutions(t *testing.T) {
	requestID, sessionID, action, ok := ParsePermissionResolution(json.RawMessage(`{"sessionID":"ses_1","permissionID":"per_1","response":"always"}`))
	if !ok || requestID != "per_1" || sessionID != "ses_1" || action != "always" {
		t.Fatalf("permission resolution=%q %q %q ok=%v", requestID, sessionID, action, ok)
	}
	requestID, sessionID, answers, ok := ParseQuestionResolution(json.RawMessage(`{"requestID":"que_1","sessionID":"ses_1","answers":[["A"],["B","custom"]]}`))
	if !ok || requestID != "que_1" || sessionID != "ses_1" || !reflect.DeepEqual(answers, [][]string{{"A"}, {"B", "custom"}}) {
		t.Fatalf("question resolution=%q %q %#v ok=%v", requestID, sessionID, answers, ok)
	}
}

func assertJSONField(t *testing.T, r *http.Request, key string, want any) {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body[key] != want {
		t.Errorf("%s=%#v want %#v", key, body[key], want)
	}
}
