package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type fakeCodexRuntimeClient struct {
	mu      sync.Mutex
	calls   []fakeCodexCall
	results map[string]json.RawMessage
	errs    map[string]error
	events  chan codexapp.Inbound
}

type fakeCodexCall struct {
	method string
	params json.RawMessage
}

func newFakeCodexRuntimeClient() *fakeCodexRuntimeClient {
	return &fakeCodexRuntimeClient{results: make(map[string]json.RawMessage), errs: make(map[string]error), events: make(chan codexapp.Inbound)}
}

func (f *fakeCodexRuntimeClient) Call(_ context.Context, method string, params any, result any) error {
	raw, _ := json.Marshal(params)
	f.mu.Lock()
	f.calls = append(f.calls, fakeCodexCall{method: method, params: raw})
	err := f.errs[method]
	response := append(json.RawMessage(nil), f.results[method]...)
	f.mu.Unlock()
	if err != nil {
		return err
	}
	if result != nil && len(response) > 0 {
		return json.Unmarshal(response, result)
	}
	return nil
}

func (f *fakeCodexRuntimeClient) Events() <-chan codexapp.Inbound { return f.events }
func (f *fakeCodexRuntimeClient) Close() error                    { return nil }
func (f *fakeCodexRuntimeClient) Respond(codexapp.RequestID, any, *codexapp.RPCError) error {
	return nil
}

func (f *fakeCodexRuntimeClient) lastCall(t *testing.T, method string) fakeCodexCall {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].method == method {
			return f.calls[i]
		}
	}
	t.Fatalf("missing %s call: %+v", method, f.calls)
	return fakeCodexCall{}
}

func TestCodexAppServerBackendStartSendSteerInterruptAndResume(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/start"] = json.RawMessage(`{"thread":{"id":"thr_1","cwd":"/repo","status":{"type":"idle"},"turns":[]}}`)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"turn_1","status":"inProgress","items":[]}}`)
	rpc.results["thread/resume"] = json.RawMessage(`{"thread":{"id":"thr_2","cwd":"/other","status":{"type":"idle"},"turns":[]}}`)
	backend := newCodexAppServerBackend(sm, coord, rpc, 4)

	sessionID, err := backend.Start(context.Background(), protocol.SessionConfig{
		Agent: "codex", Cwd: "/repo", Prompt: "hello", Model: "gpt-5",
		Permission: &protocol.PermissionConfig{Agent: "codex", ApprovalPolicy: "never", SandboxMode: "workspace-write"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if sessionID != "thr_1" {
		t.Fatalf("session=%q", sessionID)
	}
	var startParams map[string]any
	if err := json.Unmarshal(rpc.lastCall(t, "thread/start").params, &startParams); err != nil {
		t.Fatal(err)
	}
	if startParams["cwd"] != "/repo" || startParams["model"] != "gpt-5" || startParams["approvalPolicy"] != "never" || startParams["sandbox"] != "workspace-write" {
		t.Fatalf("thread/start params=%v", startParams)
	}
	var initialTurn map[string]any
	_ = json.Unmarshal(rpc.lastCall(t, "turn/start").params, &initialTurn)
	if initialTurn["threadId"] != "thr_1" || initialTurn["input"].([]any)[0].(map[string]any)["text"] != "hello" {
		t.Fatalf("initial turn=%v", initialTurn)
	}

	coord.setActiveTurn("thr_1", "turn_1")
	if err := backend.Send(context.Background(), "thr_1", "more"); err != nil {
		t.Fatal(err)
	}
	var steer map[string]any
	_ = json.Unmarshal(rpc.lastCall(t, "turn/steer").params, &steer)
	if steer["expectedTurnId"] != "turn_1" {
		t.Fatalf("steer=%v", steer)
	}
	if err := backend.Interrupt("thr_1"); err != nil {
		t.Fatal(err)
	}
	var interrupt map[string]any
	_ = json.Unmarshal(rpc.lastCall(t, "turn/interrupt").params, &interrupt)
	if interrupt["turnId"] != "turn_1" {
		t.Fatalf("interrupt=%v", interrupt)
	}

	if err := backend.Resume(context.Background(), "thr_2"); err != nil {
		t.Fatal(err)
	}
	if call := rpc.lastCall(t, "thread/resume"); string(call.params) != `{"threadId":"thr_2"}` {
		t.Fatalf("resume params=%s", call.params)
	}
}

func TestCodexAppServerBackendStartsNewTurnWhenIdle(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	coord := newCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"turn_new","status":"inProgress","items":[]}}`)
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	if err := backend.Send(context.Background(), "thr_idle", "next"); err != nil {
		t.Fatal(err)
	}
	rpc.lastCall(t, "turn/start")
}

func TestCodexAppServerBackendAppliesCurrentPermissionToNextTurn(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	coord := newCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"turn_new","status":"inProgress","items":[]}}`)
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	sm.sessions["thr_idle"] = &ProcessState{
		SessionID: "thr_idle", Agent: "codex", Cwd: "/repo", Model: "gpt-5",
		Permission: &protocol.PermissionConfig{Agent: "codex", ApprovalPolicy: "on-request", SandboxMode: "workspace-write"},
	}

	if err := backend.Send(context.Background(), "thr_idle", "next"); err != nil {
		t.Fatal(err)
	}
	var params map[string]any
	if err := json.Unmarshal(rpc.lastCall(t, "turn/start").params, &params); err != nil {
		t.Fatal(err)
	}
	if params["cwd"] != "/repo" || params["model"] != "gpt-5" || params["approvalPolicy"] != "on-request" || params["sandbox"] != "workspace-write" {
		t.Fatalf("turn/start params=%v", params)
	}
}

func TestSendMessageManagedCodexWaitsForNativeUserItem(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 2)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"turn_new","status":"inProgress","items":[]}}`)
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	sm.sessions["thr_1"] = &ProcessState{SessionID: "thr_1", Agent: "codex", Source: "daemon", Status: protocol.StatusIdle, Backend: backend}
	if err := sm.SendMessage(context.Background(), "thr_1", "hello"); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-output:
		t.Fatalf("premature echo=%+v", event)
	default:
	}
}

func TestKillSessionClosesManagedCodexWithoutWaitingForProcess(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 2)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	backend := newCodexAppServerBackend(sm, coord, newFakeCodexRuntimeClient(), 1)
	cwd := t.TempDir()
	sm.sessions["thr_1"] = &ProcessState{SessionID: "thr_1", Agent: "codex", Source: "daemon", Cwd: cwd, Status: protocol.StatusIdle, Backend: backend}
	sm.registerCwd("thr_1", cwd)
	started := time.Now()
	if err := sm.KillSession("thr_1"); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("managed backend kill waited for a nonexistent process")
	}
	sm.mu.RLock()
	status := sm.sessions["thr_1"].Status
	sm.mu.RUnlock()
	if status != protocol.StatusKilled || sm.CwdSessionCount(cwd) != 0 {
		t.Fatalf("status=%q cwd sessions=%d", status, sm.CwdSessionCount(cwd))
	}
	if event := <-output; event.Type != "session_status" || event.Status != protocol.StatusKilled {
		t.Fatalf("event=%+v", event)
	}
}

func TestCodexAppServerBackendReturnsDisconnect(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	rpc := newFakeCodexRuntimeClient()
	rpc.errs["thread/start"] = errors.New("closed")
	backend := newCodexAppServerBackend(sm, newCodexCoordinator(sm), rpc, 1)
	if _, err := backend.Start(context.Background(), protocol.SessionConfig{Agent: "codex", Cwd: "/repo"}); err == nil {
		t.Fatal("expected app-server disconnect")
	}
}

func TestCreateSessionSelectsManagedCodexBackendWhenAvailable(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 2))
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) { return "/opt/codex", nil }
	called := false
	sm.createDeps.startCodexManaged = func(_ *SessionManager, _ context.Context, config protocol.SessionConfig, cliPath, cwd, model, worktreePath, worktreeBranch string) (string, bool, error) {
		called = true
		if config.Agent != "codex" || cliPath != "/opt/codex" || cwd == "" || model != "gpt-5" || worktreePath != "" || worktreeBranch != "" {
			t.Fatalf("managed args config=%+v cli=%q cwd=%q model=%q worktree=%q branch=%q", config, cliPath, cwd, model, worktreePath, worktreeBranch)
		}
		return "thr_managed", true, nil
	}
	sessionID, err := sm.CreateSession(context.Background(), protocol.SessionConfig{
		Agent: "codex", Cwd: t.TempDir(), Model: "gpt-5",
		Permission: &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "on-request", SandboxMode: "workspace-write"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called || sessionID != "thr_managed" {
		t.Fatalf("called=%t session=%q", called, sessionID)
	}
}

func TestCreateSessionDoesNotFallbackApprovalPromptToExecJSON(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) { return "/opt/codex", nil }
	sm.createDeps.startCodexManaged = func(*SessionManager, context.Context, protocol.SessionConfig, string, string, string, string, string) (string, bool, error) {
		return "", false, nil
	}
	_, err := sm.CreateSession(context.Background(), protocol.SessionConfig{
		Agent: "codex", Cwd: t.TempDir(),
		Permission: &protocol.PermissionConfig{Agent: "codex", Preset: "custom", ApprovalPolicy: "on-request", SandboxMode: "workspace-write"},
	})
	if err == nil || !strings.Contains(err.Error(), "managed app-server") {
		t.Fatalf("error=%v", err)
	}
}
