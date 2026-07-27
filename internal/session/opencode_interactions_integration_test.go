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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestOpenCodeP1IntegrationFlow(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	permissionReplies := make(map[string]string)
	var questionAnswers [][]string
	var questionRejected bool
	var commandBody map[string]any
	bootstrapPermission := false

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/command":
			json.NewEncoder(w).Encode([]map[string]any{
				{"name": "review", "description": "Review", "source": "command", "template": "Review $ARGUMENTS", "hints": []string{"[scope]"}, "agent": "build"},
				{"name": "mcp_search", "source": "mcp", "template": map[string]any{}, "hints": []string{"[query]"}},
				{"name": "deploy", "source": "skill", "hints": []string{"[target]"}},
			})
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
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/permission/") && strings.HasSuffix(r.URL.Path, "/reply"):
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("permission reply directory=%q", r.URL.Query().Get("directory"))
			}
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			permissionReplies[strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/permission/"), "/reply")] = body["reply"]
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/question/que_1/reply":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("question reply directory=%q", r.URL.Query().Get("directory"))
			}
			var body struct {
				Answers [][]string `json:"answers"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			questionAnswers = body.Answers
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/question/que_reject/reject":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("question reject directory=%q", r.URL.Query().Get("directory"))
			}
			mu.Lock()
			questionRejected = true
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("permission directory=%q", r.URL.Query().Get("directory"))
			}
			mu.Lock()
			pending := bootstrapPermission
			mu.Unlock()
			if pending {
				json.NewEncoder(w).Encode([]map[string]any{{"requestID": "per_remote", "sessionID": "ses_1", "permission": "bash", "patterns": []string{"git *"}, "always": []string{"git status"}}})
			} else {
				json.NewEncoder(w).Encode([]any{})
			}
		case r.Method == http.MethodGet && r.URL.Path == "/question":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("question directory=%q", r.URL.Query().Get("directory"))
			}
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
		SessionID: "ses_1", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Status: protocol.StatusIdle, Cwd: "/repo", Backend: backend,
		PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion),
	}
	coord.tracked["ses_1"] = func() {}

	commands, err := sm.CommandsForSession(context.Background(), "ses_1")
	if err != nil || len(commands) != 3 || commands[0].Name != "review" || commands[0].Kind != "command" || commands[0].ArgHint != "[scope]" || commands[0].Template != "Review $ARGUMENTS" ||
		commands[1].Name != "mcp_search" || commands[1].Source != "mcp" || commands[1].Kind != "command" || commands[1].ArgHint != "[query]" || commands[1].Template != "" ||
		commands[2].Name != "deploy" || commands[2].Kind != "skill" || commands[2].ArgHint != "[target]" || commands[2].Template != "" {
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

	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_permission", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["git *"],"always":["git status"],"metadata":{"command":"git status"}}`)})
	permissionAsked := waitDaemonEvent(t, out, "approval_request", "per_1")
	if permissionAsked.PermissionName != "bash" || !reflect.DeepEqual(permissionAsked.Patterns, []string{"git *"}) || !reflect.DeepEqual(permissionAsked.Always, []string{"git status"}) {
		t.Fatalf("permission event=%+v", permissionAsked)
	}
	if sm.sessions["ses_1"].Status != protocol.StatusWaitingApproval {
		t.Fatalf("permission status=%q", sm.sessions["ses_1"].Status)
	}
	if err := sm.ResolveApprovalAction("ses_1", "per_1", "always"); err != nil {
		t.Fatal(err)
	}
	permissionResolved := waitDaemonEvent(t, out, "approval_resolved", "per_1")
	if permissionResolved.Action != "always" || !permissionResolved.Approved {
		t.Fatalf("permission resolved=%+v", permissionResolved)
	}
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_permission_replay", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_1","sessionID":"ses_1","permission":"bash"}`)})
	if _, replayed := sm.sessions["ses_1"].PendingPermissions["per_1"]; replayed {
		t.Fatal("resolved permission request replayed under a new event ID")
	}
	for _, decision := range []string{"once", "reject"} {
		requestID := "per_" + decision
		coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_" + decision, Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(fmt.Sprintf(`{"id":%q,"sessionID":"ses_1","permission":"bash"}`, requestID))})
		waitDaemonEvent(t, out, "approval_request", requestID)
		if err := sm.ResolveApprovalAction("ses_1", requestID, decision); err != nil {
			t.Fatal(err)
		}
		resolved := waitDaemonEvent(t, out, "approval_resolved", requestID)
		if resolved.Action != decision || resolved.Approved != (decision != "reject") {
			t.Fatalf("permission %s resolved=%+v", decision, resolved)
		}
	}

	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_question", Type: "question.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"que_1","sessionID":"ses_1","questions":[{"header":"Mode","question":"Choose one","options":[{"label":"A"}],"multiple":false,"custom":false},{"header":"Files","question":"Choose many","options":[{"label":"B"},{"label":"C"}],"multiple":true,"custom":true}]}`)})
	questionAsked := waitDaemonEvent(t, out, "question_request", "que_1")
	if len(questionAsked.Questions) != 2 || !questionAsked.Questions[1].Multiple || !questionAsked.Questions[1].Custom {
		t.Fatalf("question event=%+v", questionAsked)
	}
	if sm.sessions["ses_1"].Status != protocol.StatusWaitingQuestion {
		t.Fatalf("question status=%q", sm.sessions["ses_1"].Status)
	}
	wantAnswers := [][]string{{"A"}, {"B", "custom"}}
	if err := sm.ResolveQuestion("ses_1", "que_1", wantAnswers); err != nil {
		t.Fatal(err)
	}
	questionResolved := waitDaemonEvent(t, out, "question_resolved", "que_1")
	if !reflect.DeepEqual(questionResolved.Answers, wantAnswers) {
		t.Fatalf("question resolved=%+v", questionResolved)
	}
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_question_replay", Type: "question.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"que_1","sessionID":"ses_1","questions":[{"question":"Again?"}]}`)})
	if _, replayed := sm.sessions["ses_1"].PendingQuestions["que_1"]; replayed {
		t.Fatal("resolved question request replayed under a new event ID")
	}
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_question_reject", Type: "question.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"que_reject","sessionID":"ses_1","questions":[{"question":"Continue?"}]}`)})
	waitDaemonEvent(t, out, "question_request", "que_reject")
	if err := sm.RejectQuestion("ses_1", "que_reject"); err != nil {
		t.Fatal(err)
	}
	if rejected := waitDaemonEvent(t, out, "question_resolved", "que_reject"); !rejected.Rejected {
		t.Fatalf("question reject=%+v", rejected)
	}
	if sm.sessions["ses_1"].Status != protocol.StatusIdle {
		t.Fatalf("resolved native status=%q", sm.sessions["ses_1"].Status)
	}

	mu.Lock()
	if permissionReplies["per_1"] != "always" || permissionReplies["per_once"] != "once" || permissionReplies["per_reject"] != "reject" || !reflect.DeepEqual(questionAnswers, wantAnswers) || !questionRejected {
		t.Fatalf("permission replies=%v answers=%#v rejected=%v", permissionReplies, questionAnswers, questionRejected)
	}
	bootstrapPermission = true
	mu.Unlock()
	coord.reconcileInteractions(context.Background())
	waitDaemonEvent(t, out, "approval_request", "per_remote")
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_remote_resolved", Type: "permission.replied", Directory: "/repo", Properties: json.RawMessage(`{"sessionID":"ses_1","permissionID":"per_remote","response":"always"}`)})
	remoteResolved := waitDaemonEvent(t, out, "approval_resolved", "per_remote")
	if remoteResolved.Action != "always" || !remoteResolved.Approved || remoteResolved.Reason != "resolved_elsewhere" {
		t.Fatalf("remote resolution=%+v", remoteResolved)
	}
	coord.reconcileInteractions(context.Background())
	if _, replayed := sm.sessions["ses_1"].PendingPermissions["per_remote"]; replayed {
		t.Fatal("resolved request was re-added by a later pending snapshot")
	}
}

func TestOpenCodePerSessionRecoveryIncludesLegacyInteractions(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("permission directory=%q", r.URL.Query().Get("directory"))
			}
			json.NewEncoder(w).Encode([]map[string]any{
				{"requestID": "per_legacy", "sessionID": "ses_1", "permission": "bash"},
				{"requestID": "per_other", "sessionID": "ses_other", "permission": "edit"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/question":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("question directory=%q", r.URL.Query().Get("directory"))
			}
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
		SessionID: "ses_1", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Status: protocol.StatusIdle, Cwd: "/repo",
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

func TestOpenCodeInteractionReconcileGroupsLegacyRequestsByCwd(t *testing.T) {
	var mu sync.Mutex
	calls := make(map[string]int)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.URL.Path == "/permission" || r.URL.Path == "/question":
			directory := r.URL.Query().Get("directory")
			mu.Lock()
			calls[r.URL.Path+":"+directory]++
			mu.Unlock()
			if r.URL.Path == "/permission" && directory == normalizeCwd("/repo/a") {
				json.NewEncoder(w).Encode([]map[string]any{
					{"id": "per_1", "sessionID": "ses_1", "permission": "bash"},
					{"id": "per_2", "sessionID": "ses_2", "permission": "edit"},
				})
			} else {
				json.NewEncoder(w).Encode([]any{})
			}
		case strings.HasPrefix(r.URL.Path, "/api/session/"):
			mu.Lock()
			calls[r.URL.Path]++
			mu.Unlock()
			json.NewEncoder(w).Encode([]any{})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})

	openCodeServer := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.server = openCodeServer
	coord.started = true
	for _, item := range []struct{ id, cwd string }{{"ses_1", "/repo/a"}, {"ses_2", "/repo/a/./"}, {"ses_3", "/repo/b"}, {"ses_empty", ""}} {
		sm.sessions[item.id] = &ProcessState{SessionID: item.id, Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Cwd: item.cwd, PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion)}
		coord.tracked[item.id] = func() {}
	}

	coord.reconcileInteractions(context.Background())
	mu.Lock()
	defer mu.Unlock()
	for _, path := range []string{
		"/permission:" + normalizeCwd("/repo/a"),
		"/question:" + normalizeCwd("/repo/a"),
		"/permission:" + normalizeCwd("/repo/b"),
		"/question:" + normalizeCwd("/repo/b"),
	} {
		if calls[path] != 1 {
			t.Fatalf("calls[%q]=%d want 1 (all=%v)", path, calls[path], calls)
		}
	}
	if calls["/permission:"] != 0 || calls["/question:"] != 0 {
		t.Fatalf("empty cwd reached unscoped legacy endpoints: %v", calls)
	}
	if calls["/api/session/ses_empty/permission"] != 1 || calls["/api/session/ses_empty/question"] != 1 {
		t.Fatalf("empty cwd must not suppress v2 per-session reconciliation: %v", calls)
	}
	if len(sm.sessions["ses_1"].PendingPermissions) != 1 || len(sm.sessions["ses_2"].PendingPermissions) != 1 || len(sm.sessions["ses_3"].PendingPermissions) != 0 {
		t.Fatalf("pending by session: ses_1=%v ses_2=%v ses_3=%v", sm.sessions["ses_1"].PendingPermissions, sm.sessions["ses_2"].PendingPermissions, sm.sessions["ses_3"].PendingPermissions)
	}
}

func TestOpenCodeGlobalInteractionStreamAcrossDirectory(t *testing.T) {
	var streamCalls atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.URL.Path == "/global/event":
			streamCalls.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			permission := `data: {"directory":"/repo/other","payload":{"id":"evt_1","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["pwd"]}}}` + "\n\n"
			question := `data: {"directory":"/repo/other","payload":{"id":"evt_2","type":"question.asked","properties":{"id":"que_1","sessionID":"ses_1","questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}}}` + "\n\n"
			_, _ = w.Write([]byte(permission + permission + question + question))
		case r.URL.Path == "/permission" || r.URL.Path == "/question":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo/other") {
				t.Errorf("legacy pending directory=%q", r.URL.Query().Get("directory"))
			}
			json.NewEncoder(w).Encode([]any{})
		case r.URL.Path == "/api/session/ses_1/permission" || r.URL.Path == "/api/session/ses_1/question":
			json.NewEncoder(w).Encode([]any{})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})

	openCodeServer := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.server = openCodeServer
	coord.started = true
	sm.sessions["ses_1"] = &ProcessState{SessionID: "ses_1", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Cwd: "/repo/other", PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion)}
	coord.tracked["ses_1"] = func() {}
	ctx, cancel := context.WithCancel(context.Background())
	go coord.interactionLoop(ctx)
	waitDaemonEvent(t, out, "approval_request", "per_1")
	waitDaemonEvent(t, out, "question_request", "que_1")
	cancel()
	if streamCalls.Load() == 0 {
		t.Fatal("global interaction stream was not requested")
	}
	var duplicateCards int
	for len(out) > 0 {
		event := <-out
		if event.Type == "approval_request" || event.Type == "question_request" {
			duplicateCards++
		}
	}
	if duplicateCards != 0 {
		t.Fatalf("duplicate global frames emitted %d additional cards", duplicateCards)
	}
}

func TestOpenCodeInteractionReplyFailureKeepsPending(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodPost && r.URL.Path == "/permission/per_retry/reply":
			http.Error(w, "retry", http.StatusInternalServerError)
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})
	openCodeServer := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.server = openCodeServer
	backend := &serverBackend{coord: coord}
	sm.sessions["ses_1"] = &ProcessState{SessionID: "ses_1", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Cwd: "/repo", Backend: backend, PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion)}
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_retry", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_retry","sessionID":"ses_1","permission":"bash"}`)})
	waitDaemonEvent(t, out, "approval_request", "per_retry")
	if err := sm.ResolveApprovalAction("ses_1", "per_retry", "once"); err == nil {
		t.Fatal("expected reply failure")
	}
	if _, ok := sm.sessions["ses_1"].PendingPermissions["per_retry"]; !ok || sm.sessions["ses_1"].Status != protocol.StatusWaitingApproval {
		t.Fatalf("failed reply cleared retryable request: %+v", sm.sessions["ses_1"])
	}
}

func TestOpenCodeInteractionReconcileDoesNotStaleClearNewRequest(t *testing.T) {
	queryStarted := make(chan struct{})
	releaseQuery := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.URL.Path == "/permission":
			close(queryStarted)
			<-releaseQuery
			json.NewEncoder(w).Encode([]any{})
		case r.URL.Path == "/question" || strings.HasPrefix(r.URL.Path, "/api/session/"):
			json.NewEncoder(w).Encode([]any{})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})
	server := startFakeOpenCodeServer(t, handler)
	sm, _ := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].Cwd = "/repo"
	coord := newOpencodeCoordinator(sm)
	coord.server = server
	coord.tracked["ses_1"] = func() {}
	reconcileDone := make(chan struct{})
	go func() {
		coord.reconcileInteractions(context.Background())
		close(reconcileDone)
	}()
	<-queryStarted
	askedDone := make(chan struct{})
	go func() {
		coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_new", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_new","sessionID":"ses_1","permission":"bash"}`)})
		close(askedDone)
	}()
	select {
	case <-askedDone:
	case <-time.After(time.Second):
		close(releaseQuery)
		<-reconcileDone
		t.Fatal("blocked snapshot HTTP prevented concurrent asked SSE")
	}
	if _, ok := sm.sessions["ses_1"].PendingPermissions["per_new"]; !ok {
		close(releaseQuery)
		<-reconcileDone
		t.Fatal("concurrent asked mutation was not applied before snapshot returned")
	}
	close(releaseQuery)
	<-reconcileDone
	if _, ok := sm.sessions["ses_1"].PendingPermissions["per_new"]; !ok {
		t.Fatal("snapshot begun before asked stale-cleared the new request")
	}
}

func TestOpenCodeInteractionLegacyBatchValidatesEachSessionGeneration(t *testing.T) {
	queryStarted := make(chan struct{})
	releaseQuery := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.URL.Path == "/permission":
			close(queryStarted)
			<-releaseQuery
			json.NewEncoder(w).Encode([]map[string]any{
				{"id": "per_stale", "sessionID": "ses_1", "permission": "bash"},
				{"id": "per_peer", "sessionID": "ses_2", "permission": "edit"},
			})
		case r.URL.Path == "/question" || strings.HasPrefix(r.URL.Path, "/api/session/"):
			json.NewEncoder(w).Encode([]any{})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})
	server := startFakeOpenCodeServer(t, handler)
	sm, _ := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].Cwd = "/repo"
	sm.sessions["ses_2"] = &ProcessState{SessionID: "ses_2", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Cwd: "/repo", PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion)}
	coord := newOpencodeCoordinator(sm)
	coord.server = server
	coord.tracked["ses_1"] = func() {}
	coord.tracked["ses_2"] = func() {}
	reconcileDone := make(chan struct{})
	go func() {
		coord.reconcileInteractions(context.Background())
		close(reconcileDone)
	}()
	<-queryStarted
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_newer", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_newer","sessionID":"ses_1","permission":"bash"}`)})
	close(releaseQuery)
	<-reconcileDone
	if _, ok := sm.sessions["ses_1"].PendingPermissions["per_newer"]; !ok {
		t.Fatal("changed session lost its newer request")
	}
	if _, ok := sm.sessions["ses_1"].PendingPermissions["per_stale"]; ok {
		t.Fatal("changed session accepted its stale batch snapshot")
	}
	if _, ok := sm.sessions["ses_2"].PendingPermissions["per_peer"]; !ok {
		t.Fatal("unchanged peer discarded its valid batch snapshot")
	}
}

func TestOpenCodeInteractionReconcileDoesNotStaleReaddResolvedRequest(t *testing.T) {
	queryStarted := make(chan struct{})
	releaseQuery := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			close(queryStarted)
			<-releaseQuery
			json.NewEncoder(w).Encode([]map[string]any{{"id": "per_old", "sessionID": "ses_1", "permission": "bash"}})
		case r.Method == http.MethodGet && (r.URL.Path == "/question" || strings.HasPrefix(r.URL.Path, "/api/session/")):
			json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodPost && r.URL.Path == "/permission/per_old/reply":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})
	server := startFakeOpenCodeServer(t, handler)
	out := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(out)
	coord := newOpencodeCoordinator(sm)
	coord.server = server
	backend := &serverBackend{coord: coord}
	sm.sessions["ses_1"] = &ProcessState{SessionID: "ses_1", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Cwd: "/repo", Backend: backend, PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion)}
	coord.tracked["ses_1"] = func() {}
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_old", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_old","sessionID":"ses_1","permission":"bash"}`)})
	reconcileDone := make(chan struct{})
	go func() {
		coord.reconcileInteractions(context.Background())
		close(reconcileDone)
	}()
	<-queryStarted
	replyDone := make(chan error, 1)
	go func() { replyDone <- sm.ResolveApprovalAction("ses_1", "per_old", "once") }()
	var replyErr error
	select {
	case replyErr = <-replyDone:
	case <-time.After(time.Second):
		close(releaseQuery)
		<-reconcileDone
		t.Fatal("blocked snapshot HTTP prevented concurrent user reply")
	}
	if _, ok := sm.sessions["ses_1"].PendingPermissions["per_old"]; ok {
		close(releaseQuery)
		<-reconcileDone
		t.Fatal("concurrent reply did not clear request before snapshot returned")
	}
	close(releaseQuery)
	<-reconcileDone
	if replyErr != nil {
		t.Fatal(replyErr)
	}
	if _, ok := sm.sessions["ses_1"].PendingPermissions["per_old"]; ok {
		t.Fatal("snapshot begun before reply stale-readded the resolved request")
	}
}

func TestOpenCodeInteractionSnapshotResolutionTombstonesRequests(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.URL.Path == "/permission" || r.URL.Path == "/question" || strings.HasPrefix(r.URL.Path, "/api/session/"):
			json.NewEncoder(w).Encode([]any{})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})
	server := startFakeOpenCodeServer(t, handler)
	sm, _ := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].Cwd = "/repo"
	coord := newOpencodeCoordinator(sm)
	coord.server = server
	coord.tracked["ses_1"] = func() {}
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_per_snapshot", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_snapshot","sessionID":"ses_1","permission":"bash"}`)})
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_que_snapshot", Type: "question.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"que_snapshot","sessionID":"ses_1","questions":[{"question":"Continue?"}]}`)})
	coord.reconcileInteractions(context.Background())
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_per_snapshot_replay", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_snapshot","sessionID":"ses_1","permission":"bash"}`)})
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_que_snapshot_replay", Type: "question.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"que_snapshot","sessionID":"ses_1","questions":[{"question":"Again?"}]}`)})
	if len(sm.sessions["ses_1"].PendingPermissions) != 0 || len(sm.sessions["ses_1"].PendingQuestions) != 0 {
		t.Fatalf("snapshot-resolved requests replayed: permissions=%v questions=%v", sm.sessions["ses_1"].PendingPermissions, sm.sessions["ses_1"].PendingQuestions)
	}
}

func TestOpenCodeInteractionStatusReconcileDoesNotHoldLifecycleLock(t *testing.T) {
	statusStarted := make(chan struct{})
	releaseStatus := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodPost && r.URL.Path == "/permission/per_status/reply":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			close(statusStarted)
			<-releaseStatus
			json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})
	server := startFakeOpenCodeServer(t, handler)
	sm, _ := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].Cwd = "/repo"
	coord := newOpencodeCoordinator(sm)
	coord.server = server
	backend := &serverBackend{coord: coord}
	sm.sessions["ses_1"].Backend = backend
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_status", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_status","sessionID":"ses_1","permission":"bash"}`)})
	replyDone := make(chan error, 1)
	go func() { replyDone <- sm.ResolveApprovalAction("ses_1", "per_status", "once") }()
	<-statusStarted
	askedDone := make(chan struct{})
	go func() {
		coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_during_status", Type: "question.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"que_during_status","sessionID":"ses_1","questions":[{"question":"Continue?"}]}`)})
		close(askedDone)
	}()
	select {
	case <-askedDone:
	case <-time.After(time.Second):
		close(releaseStatus)
		<-replyDone
		t.Fatal("native status network call held the interaction lifecycle lock")
	}
	close(releaseStatus)
	if err := <-replyDone; err != nil {
		t.Fatal(err)
	}
	if _, ok := sm.sessions["ses_1"].PendingQuestions["que_during_status"]; !ok {
		t.Fatal("asked event during status reconciliation was not applied")
	}
}

func TestOpenCodeInteractionGlobalResolutionStatusDoesNotHoldLifecycleLock(t *testing.T) {
	statusStarted := make(chan struct{})
	releaseStatus := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			close(statusStarted)
			<-releaseStatus
			json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]any{"type": "idle"}})
		default:
			http.Error(w, fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		}
	})
	server := startFakeOpenCodeServer(t, handler)
	sm, _ := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].Cwd = "/repo"
	coord := newOpencodeCoordinator(sm)
	coord.server = server
	sm.sessions["ses_1"].Backend = &serverBackend{coord: coord}
	coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_resolve_status", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_resolve_status","sessionID":"ses_1","permission":"bash"}`)})
	resolvedDone := make(chan struct{})
	go func() {
		coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_resolve_done", Type: "permission.replied", Directory: "/repo", Properties: json.RawMessage(`{"sessionID":"ses_1","permissionID":"per_resolve_status","response":"once"}`)})
		close(resolvedDone)
	}()
	<-statusStarted
	askedDone := make(chan struct{})
	go func() {
		coord.handleInteractionEvent(adapter.SSEEvent{ID: "evt_during_resolution_status", Type: "question.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"que_during_resolution_status","sessionID":"ses_1","questions":[{"question":"Continue?"}]}`)})
		close(askedDone)
	}()
	select {
	case <-askedDone:
	case <-time.After(time.Second):
		close(releaseStatus)
		<-resolvedDone
		t.Fatal("global resolution status HTTP held the interaction lifecycle lock")
	}
	close(releaseStatus)
	<-resolvedDone
	if _, ok := sm.sessions["ses_1"].PendingQuestions["que_during_resolution_status"]; !ok {
		t.Fatal("asked event during global resolution status reconciliation was not applied")
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
	sm.sessions["ses_1"] = &ProcessState{SessionID: "ses_1", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Status: protocol.StatusIdle, Cwd: "/repo"}

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
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/global/health" {
			json.NewEncoder(w).Encode(map[string]any{"healthy": true, "version": "1.17.11"})
			return
		}
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(httpServer.Close)
	script := filepath.Join(t.TempDir(), "opencode")
	script = writeFakeCommandFixture(t, script,
		fmt.Sprintf("#!/bin/sh\nprintf 'opencode server listening on %s\\n'\nwhile :; do sleep 60; done\n", httpServer.URL),
		fmt.Sprintf("@echo off\necho opencode server listening on %s\n:loop\ntimeout /t 60 /nobreak >nul\ngoto loop\n", httpServer.URL),
	)
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

func TestOpenCodeRestartPreservesServeOwnership(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var permissionReply, questionReject bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/health":
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			json.NewEncoder(w).Encode([]map[string]any{{"requestID": "per_restart", "sessionID": "ses_restart", "permission": "bash"}})
		case r.Method == http.MethodGet && r.URL.Path == "/question":
			json.NewEncoder(w).Encode([]map[string]any{{"requestID": "que_restart", "sessionID": "ses_restart", "questions": []map[string]any{{"question": "Continue?"}}}})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/session/ses_restart/"):
			json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodPost && r.URL.Path == "/permission/per_restart/reply":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("permission reply directory=%q", r.URL.Query().Get("directory"))
			}
			permissionReply = true
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Path == "/question/que_restart/reject":
			if r.URL.Query().Get("directory") != normalizeCwd("/repo") {
				t.Errorf("question reject directory=%q", r.URL.Query().Get("directory"))
			}
			questionReject = true
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			json.NewEncoder(w).Encode(map[string]any{"ses_restart": map[string]string{"type": "idle"}})
		default:
			http.NotFound(w, r)
		}
	})
	server := startFakeOpenCodeServer(t, handler)
	pid, base := server.PID(), server.BaseURL()
	if err := daemon.WriteOpenCodeServeState(&daemon.OpenCodeServeState{PID: pid, BaseURL: base, Password: server.Password(), Version: server.Version(), OwnerPID: os.Getpid(), UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	old := newOpencodeCoordinator(NewSessionManager(make(chan protocol.DaemonEvent, 8)))
	old.ctx, old.cancel = context.WithCancel(context.Background())
	old.server, old.started = server, true
	if err := old.PrepareDaemonRestart(); err != nil {
		t.Fatal(err)
	}
	state, err := daemon.ReadOpenCodeServeState()
	if err != nil {
		t.Fatal(err)
	}
	if state.PID != pid || state.BaseURL != base || state.Password == "" || state.Version != "1.17.11" {
		t.Fatalf("handoff=%+v", state)
	}
	old.Shutdown()

	out := make(chan protocol.DaemonEvent, 16)
	nextSM := NewSessionManager(out)
	next := newOpencodeCoordinator(nextSM)
	next.ctx, next.cancel = context.WithCancel(context.Background())
	cli := writeFakeCommandFixture(t, filepath.Join(t.TempDir(), "opencode"),
		"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'opencode version 1.17.11'; fi\n",
		"@echo off\nif \"%~1\"==\"--version\" echo opencode version 1.17.11\n",
	)
	cfg := agentcontrol.DefaultConfig()
	cfg.OpenCode.RealBinary = cli
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if err := next.attachHandoffLocked(state); err != nil {
		t.Fatal(err)
	}
	if next.server.PID() != pid || next.server.BaseURL() != base {
		t.Fatalf("attached pid/url changed: %d %s", next.server.PID(), next.server.BaseURL())
	}
	nextSM.sessions["ses_restart"] = &ProcessState{SessionID: "ses_restart", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlManaged, Cwd: "/repo", Backend: &serverBackend{coord: next}, PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion)}
	next.tracked["ses_restart"] = func() {}
	next.reconcileInteractions(context.Background())
	if event := waitDaemonEvent(t, out, "approval_request", "per_restart"); event.SessionID != "ses_restart" {
		t.Fatalf("permission=%+v", event)
	}
	if event := waitDaemonEvent(t, out, "question_request", "que_restart"); event.SessionID != "ses_restart" {
		t.Fatalf("question=%+v", event)
	}
	if err := nextSM.ResolveApprovalAction("ses_restart", "per_restart", "once"); err != nil {
		t.Fatal(err)
	}
	if err := nextSM.RejectQuestion("ses_restart", "que_restart"); err != nil {
		t.Fatal(err)
	}
	if !permissionReply || !questionReject {
		t.Fatalf("reply=%v reject=%v", permissionReply, questionReject)
	}
	next.Shutdown()
	if _, err := os.Stat(daemon.OpenCodeServeStatePath()); !os.IsNotExist(err) {
		t.Fatalf("handoff survived explicit shutdown: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for platform.NewProcessController().IsAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if platform.NewProcessController().IsAlive(pid) {
		t.Fatalf("serve pid %d survived explicit shutdown", pid)
	}
}

func TestOpenCodeRestartRejectsConcurrentOwnerAndStopsIncompatibleServe(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	owner := sleepCommand(t, 30)
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	defer owner.Process.Kill()
	if handoffOwnerAvailable(&daemon.OpenCodeServeState{OwnerPID: owner.Process.Pid}) {
		t.Fatal("accepted live concurrent owner")
	}
	if !handoffOwnerAvailable(&daemon.OpenCodeServeState{OwnerPID: 99999999}) {
		t.Fatal("rejected stale owner")
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
			return
		}
		http.NotFound(w, r)
	})
	server := startFakeOpenCodeServer(t, handler)
	state := &daemon.OpenCodeServeState{PID: server.PID(), BaseURL: server.BaseURL(), Password: server.Password(), Version: server.Version(), OwnerPID: 99999999, UpdatedAt: time.Now()}
	if err := daemon.WriteOpenCodeServeState(state); err != nil {
		t.Fatal(err)
	}
	coord := newOpencodeCoordinator(NewSessionManager(make(chan protocol.DaemonEvent, 4)))
	coord.ctx, coord.cancel = context.WithCancel(context.Background())
	attached, err := coord.tryAttachHandoffLocked(state, "9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	if attached {
		t.Fatal("attached incompatible serve")
	}
	if _, err := os.Stat(daemon.OpenCodeServeStatePath()); !os.IsNotExist(err) {
		t.Fatalf("incompatible state remains: %v", err)
	}
}

func TestOpenCodeRestartSupervisorReplacesExitedServeAndUpdatesState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
			return
		}
		if r.URL.Path == "/global/health" {
			json.NewEncoder(w).Encode(map[string]any{"healthy": true, "version": "1.2.3"})
			return
		}
	}))
	defer httpServer.Close()
	dir := t.TempDir()
	counter := filepath.Join(dir, "count")
	cli := filepath.Join(dir, "opencode")
	cli = writeFakeCommandFixture(t, cli,
		fmt.Sprintf(`#!/bin/sh
if [ "$1" = "--version" ]; then echo 'opencode version 1.2.3'; exit 0; fi
n=$(cat %q 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > %q
echo 'opencode server listening on %s'
if [ "$n" = "1" ]; then sleep 0.1; exit 0; fi
while :; do sleep 1; done
`, counter, counter, httpServer.URL),
		fmt.Sprintf(`@echo off
if "%%~1"=="--version" (
  echo opencode version 1.2.3
  exit /B 0
)
if exist "%s" (
  set /p n=<"%s"
) else (
  set n=0
)
set /a n=n+1
> "%s" echo %%n%%
echo opencode server listening on %s
if "%%n%%"=="1" exit /B 0
:loop
timeout /t 1 /nobreak >nul
goto loop
`, counter, counter, counter, httpServer.URL),
	)
	cfg := agentcontrol.DefaultConfig()
	cfg.OpenCode.RealBinary = cli
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	server := adapter.NewOpencodeServer(cli)
	if err := server.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	oldPID := server.PID()
	if err := daemon.WriteOpenCodeServeState(&daemon.OpenCodeServeState{PID: oldPID, BaseURL: server.BaseURL(), Password: server.Password(), Version: server.Version(), OwnerPID: os.Getpid(), UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	coord := newOpencodeCoordinator(NewSessionManager(make(chan protocol.DaemonEvent, 4)))
	coord.ctx, coord.cancel = context.WithCancel(context.Background())
	coord.server, coord.started = server, true
	coord.restartServer()
	defer coord.Shutdown()
	if coord.server == nil || coord.server.PID() == oldPID {
		t.Fatalf("serve pid not replaced: old=%d new=%v", oldPID, coord.server)
	}
	state, err := daemon.ReadOpenCodeServeState()
	if err != nil || state.PID != coord.server.PID() {
		t.Fatalf("updated state=%+v err=%v", state, err)
	}
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
