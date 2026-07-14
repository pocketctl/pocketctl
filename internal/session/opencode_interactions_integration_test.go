package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestOpenCodeP1IntegrationFlow(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var permissionReply string
	var questionAnswers [][]string
	var commandBody map[string]any
	bootstrapPermission := false

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/command":
			json.NewEncoder(w).Encode([]map[string]any{{"name": "review", "description": "Review", "source": "skill", "hints": []string{"[scope]"}, "agent": "build"}})
		case r.Method == http.MethodGet && r.URL.Path == "/agent":
			json.NewEncoder(w).Encode([]map[string]any{
				{"name": "build", "description": "Build", "mode": "primary", "model": map[string]any{"providerID": "openai", "modelID": "gpt-5"}},
				{"name": "explore", "mode": "subagent"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/session/ses_1":
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_1", "agent": "build"}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/session/ses_1/agent":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodPost && r.URL.Path == "/session/ses_1/command":
			mu.Lock()
			json.NewDecoder(r.Body).Decode(&commandBody)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/permission/per_1/reply":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			permissionReply = body["reply"]
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/api/session/ses_1/question/que_1/reply":
			var body struct {
				Answers [][]string `json:"answers"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			questionAnswers = body.Answers
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			mu.Lock()
			pending := bootstrapPermission
			mu.Unlock()
			if pending {
				json.NewEncoder(w).Encode([]map[string]any{{"requestID": "per_remote", "sessionID": "ses_1", "permission": "bash", "patterns": []string{"git *"}, "always": []string{"git status"}}})
			} else {
				json.NewEncoder(w).Encode([]any{})
			}
		case r.Method == http.MethodGet && r.URL.Path == "/question":
			json.NewEncoder(w).Encode([]any{})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})

	openCodeServer := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 64)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.mu.Lock()
	coord.server = openCodeServer
	coord.started = true
	coord.mu.Unlock()
	backend := &serverBackend{coord: coord}
	sm.opencode = coord
	sm.sessions["ses_1"] = &ProcessState{
		SessionID: "ses_1", Agent: adapter.AgentOpencode, Status: protocol.StatusIdle, Cwd: "/repo", Backend: backend,
		PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion),
	}

	commands, err := sm.CommandsForSession(context.Background(), "ses_1")
	if err != nil || len(commands) != 1 || commands[0].Name != "review" || commands[0].Kind != "skill" {
		t.Fatalf("commands=%+v err=%v", commands, err)
	}
	agents, err := sm.ListSessionAgents(context.Background(), "ses_1")
	if err != nil || len(agents) != 1 || agents[0].Name != "build" {
		t.Fatalf("agents=%+v err=%v", agents, err)
	}
	if err := sm.SetSessionAgent(context.Background(), "ses_1", "build"); err != nil {
		t.Fatal(err)
	}
	if event := waitDaemonEvent(t, out, "session_agent_changed", ""); event.CurrentAgent != "build" {
		t.Fatalf("agent event=%+v", event)
	}

	if err := backend.Send(context.Background(), "ses_1", "/review abc def"); err != nil {
		t.Fatal(err)
	}
	waitDaemonEvent(t, out, "command_receipt", "")
	mu.Lock()
	if commandBody["command"] != "review" || commandBody["arguments"] != "abc def" {
		t.Fatalf("command body=%#v", commandBody)
	}
	mu.Unlock()

	coord.handleInteractionEvent(adapter.SSEEvent{Type: "permission.asked", Properties: json.RawMessage(`{"requestID":"per_1","sessionID":"ses_1","permission":"bash","patterns":["git *"],"always":["git status"],"metadata":{"command":"git status"}}`)})
	permissionAsked := waitDaemonEvent(t, out, "approval_request", "per_1")
	if permissionAsked.PermissionName != "bash" || !reflect.DeepEqual(permissionAsked.Patterns, []string{"git *"}) || !reflect.DeepEqual(permissionAsked.Always, []string{"git status"}) {
		t.Fatalf("permission event=%+v", permissionAsked)
	}
	if err := sm.ResolveApprovalAction("ses_1", "per_1", "always"); err != nil {
		t.Fatal(err)
	}
	permissionResolved := waitDaemonEvent(t, out, "approval_resolved", "per_1")
	if permissionResolved.Action != "always" || !permissionResolved.Approved {
		t.Fatalf("permission resolved=%+v", permissionResolved)
	}

	coord.handleInteractionEvent(adapter.SSEEvent{Type: "question.asked", Properties: json.RawMessage(`{"requestID":"que_1","sessionID":"ses_1","questions":[{"header":"Mode","question":"Choose one","options":[{"label":"A"}],"multiple":false,"custom":false},{"header":"Files","question":"Choose many","options":[{"label":"B"},{"label":"C"}],"multiple":true,"custom":true}]}`)})
	questionAsked := waitDaemonEvent(t, out, "question_request", "que_1")
	if len(questionAsked.Questions) != 2 || !questionAsked.Questions[1].Multiple || !questionAsked.Questions[1].Custom {
		t.Fatalf("question event=%+v", questionAsked)
	}
	wantAnswers := [][]string{{"A"}, {"B", "custom"}}
	if err := sm.ResolveQuestion("ses_1", "que_1", wantAnswers); err != nil {
		t.Fatal(err)
	}
	questionResolved := waitDaemonEvent(t, out, "question_resolved", "que_1")
	if !reflect.DeepEqual(questionResolved.Answers, wantAnswers) {
		t.Fatalf("question resolved=%+v", questionResolved)
	}

	mu.Lock()
	if permissionReply != "always" || !reflect.DeepEqual(questionAnswers, wantAnswers) {
		t.Fatalf("reply=%q answers=%#v", permissionReply, questionAnswers)
	}
	bootstrapPermission = true
	mu.Unlock()
	coord.reconcileInteractions(context.Background())
	waitDaemonEvent(t, out, "approval_request", "per_remote")
	coord.handleInteractionEvent(adapter.SSEEvent{Type: "permission.replied", Properties: json.RawMessage(`{"sessionID":"ses_1","permissionID":"per_remote","response":"always"}`)})
	remoteResolved := waitDaemonEvent(t, out, "approval_resolved", "per_remote")
	if remoteResolved.Action != "always" || !remoteResolved.Approved || remoteResolved.Reason != "resolved_elsewhere" {
		t.Fatalf("remote resolution=%+v", remoteResolved)
	}
}

func TestOpenCodePerSessionRecoveryIncludesLegacyInteractions(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			json.NewEncoder(w).Encode([]map[string]any{
				{"requestID": "per_legacy", "sessionID": "ses_1", "permission": "bash"},
				{"requestID": "per_other", "sessionID": "ses_other", "permission": "edit"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/question":
			json.NewEncoder(w).Encode([]map[string]any{
				{"requestID": "que_legacy", "sessionID": "ses_1", "questions": []map[string]any{{"question": "Continue?"}}},
				{"requestID": "que_other", "sessionID": "ses_other", "questions": []map[string]any{{"question": "Other?"}}},
			})
		case r.Method == http.MethodGet && (r.URL.Path == "/api/session/ses_1/permission" || r.URL.Path == "/api/session/ses_1/question"):
			json.NewEncoder(w).Encode([]any{})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})

	openCodeServer := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.mu.Lock()
	coord.server = openCodeServer
	coord.started = true
	coord.mu.Unlock()
	sm.sessions["ses_1"] = &ProcessState{
		SessionID: "ses_1", Agent: adapter.AgentOpencode, Status: protocol.StatusIdle,
		PendingPermissions: make(map[string]PendingOpenCodePermission),
		PendingQuestions:   make(map[string]PendingOpenCodeQuestion),
	}

	coord.reconcileSessionInteractions(context.Background(), "ses_1")
	if event := waitDaemonEvent(t, out, "approval_request", "per_legacy"); event.SessionID != "ses_1" || event.PermissionVersion != adapter.PermissionVersionLegacy {
		t.Fatalf("legacy permission event=%+v", event)
	}
	if event := waitDaemonEvent(t, out, "question_request", "que_legacy"); event.SessionID != "ses_1" {
		t.Fatalf("legacy question event=%+v", event)
	}

	sm.mu.RLock()
	state := sm.sessions["ses_1"]
	permissionVersion := state.PendingPermissions["per_legacy"].ProtocolVersion
	questionVersion := state.PendingQuestions["que_legacy"].ProtocolVersion
	_, hasOtherPermission := state.PendingPermissions["per_other"]
	_, hasOtherQuestion := state.PendingQuestions["que_other"]
	sm.mu.RUnlock()
	if permissionVersion != adapter.PermissionVersionLegacy || questionVersion != adapter.PermissionVersionLegacy || hasOtherPermission || hasOtherQuestion {
		t.Fatal("per-session recovery must filter legacy snapshots to the tracked session")
	}
}

func TestOpenCodeSyncEmitsInitialEmptyTodoSnapshot(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/todo":
			json.NewEncoder(w).Encode([]any{})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})

	openCodeServer := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.mu.Lock()
	coord.server = openCodeServer
	coord.started = true
	coord.mu.Unlock()
	sm.sessions["ses_1"] = &ProcessState{SessionID: "ses_1", Agent: adapter.AgentOpencode, Status: protocol.StatusIdle, Cwd: "/repo"}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go coord.syncLoop(ctx, "ses_1", false)
	event := waitDaemonEvent(t, out, "agent_todo", "")
	if event.SessionID != "ses_1" || event.PartID != "todo:ses_1" || len(event.Todos) != 0 {
		t.Fatalf("initial Todo snapshot=%+v", event)
	}
}

func startFakeOpenCodeServer(t *testing.T, handler http.Handler) *adapter.OpencodeServer {
	t.Helper()
	httpServer := httptest.NewServer(handler)
	t.Cleanup(httpServer.Close)
	script := filepath.Join(t.TempDir(), "opencode")
	contents := fmt.Sprintf("#!/bin/sh\nprintf 'opencode server listening on %s\\n'\nwhile :; do sleep 60; done\n", httpServer.URL)
	if err := os.WriteFile(script, []byte(contents), 0o755); err != nil {
		t.Fatal(err)
	}
	server := adapter.NewOpencodeServer(script)
	ctx, cancel := context.WithCancel(context.Background())
	if err := server.Start(ctx); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		server.Stop()
	})
	return server
}

func waitDaemonEvent(t *testing.T, events <-chan protocol.DaemonEvent, eventType, requestID string) protocol.DaemonEvent {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			if event.Type == eventType && (requestID == "" || event.RequestID == requestID) {
				return event
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for %s %s", eventType, requestID)
		}
	}
}
