package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
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
	return &fakeCodexRuntimeClient{results: map[string]json.RawMessage{"thread/unsubscribe": json.RawMessage(`{"status":"unsubscribed"}`)}, errs: make(map[string]error), events: make(chan codexapp.Inbound)}
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

func TestCodexMemoryContextStaysShadowOnlyWithoutExactInjectionProbe(t *testing.T) {
	backend := newCodexAppServerBackend(nil, nil, newFakeCodexRuntimeClient(), 1)
	if backend.memoryContextNativeSupported(context.Background()) {
		t.Fatal("managed Codex must stay shadow-only until the exact hidden-item schema is probed")
	}
}

// These hand-checked shapes mirror the generated native ClientRequest schema.
const codexHiddenSchemaFixture = `{"title":"ClientRequest","description":"initialize thread/start thread/resume thread/turns/list turn/interrupt serverRequest/resolved","definitions":{"ThreadInjectItemsParams":{"type":"object","required":["threadId","items"],"properties":{"threadId":{"type":"string"},"items":{"type":"array","items":true}}},"TurnStartParams":{"type":"object","required":["threadId","input"],"properties":{"threadId":{"type":"string"},"input":{"type":"array","items":{"$ref":"#/definitions/UserInput"}}}},"UserInput":{"oneOf":[{"type":"object","required":["type","text"],"properties":{"type":{"type":"string","enum":["text"]},"text":{"type":"string"}}}]}},"oneOf":[{"type":"object","required":["id","method","params"],"properties":{"id":{"type":"string"},"method":{"type":"string","enum":["thread/inject_items"]},"params":{"$ref":"#/definitions/ThreadInjectItemsParams"}}},{"type":"object","required":["id","method","params"],"properties":{"id":{"type":"string"},"method":{"type":"string","enum":["turn/start"]},"params":{"$ref":"#/definitions/TurnStartParams"}}}]}{"title":"ThreadInjectItemsResponse","type":"object"}`

func nativeMemoryCodexBackend(t *testing.T) (*CodexAppServerBackend, *fakeCodexRuntimeClient) {
	t.Helper()
	probe := agentcontrol.CodexProbe{
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte("--remote --listen unix://"), nil
		},
		GenerateSchema: func(context.Context, string) ([]byte, error) { return []byte(codexHiddenSchemaFixture), nil },
	}
	caps, err := probe.Probe(context.Background(), "/test/codex", "0.154.0")
	if err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	coord := newVerifiedTestCodexCoordinator(sm)
	coord.statePath = t.TempDir() + "/state.json"
	rpc := newFakeCodexRuntimeClient()
	coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		return &codexAppServerRuntime{PID: 123456789, Endpoint: "/test/socket", RemoteURI: "unix:///test/socket", Client: rpc}, nil
	}
	coord.probe = func(context.Context, *codexAppServerRuntime) error { return nil }
	snapshot, err := coord.ensureStarted(context.Background(), "/test/codex", "0.154.0", caps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { coord.mu.Lock(); coord.stopEventPumpLocked(); coord.mu.Unlock(); coord.pumpWG.Wait() })
	return newCodexAppServerBackend(sm, coord, rpc, snapshot.Generation), rpc
}

func TestCodexHiddenContextUsesHistoryInjectionBeforeUnchangedTurn(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	if !b.memoryContextNativeSupported(context.Background()) {
		t.Fatal("fresh exact schema must enable native hidden context")
	}
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{MsgID: "user-1"})
	user := "literal <pocketctl_memory_context user text\nunchanged"
	if err := b.SendWithContext(ctx, "thread", user, &memorycontext.PreparedContext{PackID: "pack-1", StableText: "hidden fact", DynamicText: "dynamic fact"}); err != nil {
		t.Fatal(err)
	}
	if len(rpc.calls) != 2 || rpc.calls[0].method != "thread/inject_items" || rpc.calls[1].method != "turn/start" {
		t.Fatalf("native operations=%+v", rpc.calls)
	}
	var injected struct {
		ThreadID string `json:"threadId"`
		Items    []struct {
			Type, ID, Role string
			Content        []struct{ Type, Text string }
		}
	}
	if err := json.Unmarshal(rpc.calls[0].params, &injected); err != nil {
		t.Fatal(err)
	}
	if injected.ThreadID != "thread" || len(injected.Items) != 1 {
		t.Fatalf("injection=%+v", injected)
	}
	item := injected.Items[0]
	if item.Type != "message" || item.Role != "developer" || item.ID != "pocketctl-memory-context:pack-1" || len(item.Content) != 1 || item.Content[0].Type != "input_text" || item.Content[0].Text != "<pocketctl_memory_context schema=\"1\" pack_id=\"pack-1\">\n[stable]\nhidden fact\n[dynamic]\ndynamic fact\n</pocketctl_memory_context>" {
		t.Fatalf("hidden native item=%+v", item)
	}
	var turnParams map[string]any
	if err := json.Unmarshal(rpc.calls[1].params, &turnParams); err != nil {
		t.Fatal(err)
	}
	input := turnParams["input"].([]any)
	if len(input) != 1 || len(input[0].(map[string]any)) != 2 || input[0].(map[string]any)["text"] != user || turnParams["clientUserMessageId"] != "user-1" {
		t.Fatalf("user input mutated=%v", turnParams)
	}
}

func TestCodexHiddenContextRejectsUnprobedRuntimeBeforeSending(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	rpc := newFakeCodexRuntimeClient()
	b := newCodexAppServerBackend(sm, newVerifiedTestCodexCoordinator(sm), rpc, 1)
	if err := b.SendWithContext(context.Background(), "thread", "user", &memorycontext.PreparedContext{StableText: "hidden"}); err == nil {
		t.Fatal("unprobed runtime accepted hidden memory")
	}
	if len(rpc.calls) != 0 {
		t.Fatalf("unsupported runtime wrote native task: %+v", rpc.calls)
	}
}

func TestCodexHiddenContextInjectionErrorNeverStartsUserTurn(t *testing.T) {
	for _, err := range []error{&codexapp.RPCError{Code: -32602, Message: "invalid history"}, context.DeadlineExceeded} {
		t.Run(err.Error(), func(t *testing.T) {
			b, rpc := nativeMemoryCodexBackend(t)
			rpc.errs["thread/inject_items"] = err
			got := b.SendWithContext(context.Background(), "thread", "user", &memorycontext.PreparedContext{StableText: "hidden"})
			if !errors.Is(got, err) {
				t.Fatalf("injection error=%v", got)
			}
			if errors.Is(got, errNativeSessionCreateUncertain) != !codexCreateRejected(err) {
				t.Fatalf("wrong uncertainty fence: %v", got)
			}
			if len(rpc.calls) != 1 || rpc.calls[0].method != "thread/inject_items" {
				t.Fatalf("failed injection submitted user turn: %+v", rpc.calls)
			}
		})
	}
}

func TestCodexHiddenContextNilEmptyAndSteerNeverInject(t *testing.T) {
	for _, hidden := range []*memorycontext.PreparedContext{nil, {PackID: "empty"}, {StableText: "hidden"}} {
		b, rpc := nativeMemoryCodexBackend(t)
		if hidden != nil && hidden.StableText != "" {
			b.coord.setActiveTurn("thread", "active")
		}
		if err := b.SendWithContext(context.Background(), "thread", "user", hidden); err != nil {
			t.Fatal(err)
		}
		if len(rpc.calls) != 1 || (rpc.calls[0].method != "turn/start" && rpc.calls[0].method != "turn/steer") {
			t.Fatalf("unexpected hidden injection: %+v", rpc.calls)
		}
	}
}

func TestCodexHiddenContextCanceledBeforeInjectionDoesNotWrite(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := b.startTurnWithContext(ctx, "thread", "user", protocol.SessionConfig{}, &memorycontext.PreparedContext{StableText: "hidden"})
	if !errors.Is(err, context.Canceled) || errors.Is(err, errNativeSessionCreateUncertain) || len(rpc.calls) != 0 {
		t.Fatalf("canceled native injection=%v calls=%+v", err, rpc.calls)
	}
}

func TestCodexHiddenContextRuntimeIdentityChangeFailsClosed(t *testing.T) {
	for _, change := range []func(*CodexAppServerBackend){
		func(b *CodexAppServerBackend) { b.coord.schemaHash = "changed-schema" },
		func(b *CodexAppServerBackend) { b.coord.version = "0.155.0" },
		func(b *CodexAppServerBackend) { b.coord.binary = "/different/codex" },
		func(b *CodexAppServerBackend) { b.coord.generation++ },
		func(b *CodexAppServerBackend) { b.generation++ },
	} {
		b, rpc := nativeMemoryCodexBackend(t)
		b.coord.mu.Lock()
		change(b)
		b.coord.mu.Unlock()
		if b.memoryContextNativeSupported(context.Background()) {
			t.Fatal("stale runtime identity retained native hidden capability")
		}
		if err := b.startTurnWithContext(context.Background(), "thread", "user", protocol.SessionConfig{}, &memorycontext.PreparedContext{StableText: "hidden"}); err == nil || len(rpc.calls) != 0 {
			t.Fatalf("stale proof submitted hidden task: %v %+v", err, rpc.calls)
		}
	}
}

func TestCodexHiddenContextLostFirstInjectionKeepsCollaborationQuarantine(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	sm, created := collaborationCreateManager(t, &collaborationCreateBackend{})
	b.sm = sm
	rpc.errs["thread/inject_items"] = context.DeadlineExceeded
	start := sm.createDeps.startCodexManaged
	sm.createDeps.startCodexManaged = func(sm *SessionManager, ctx context.Context, cfg protocol.SessionConfig, cli, cwd, model, worktree, branch string) (string, bool, error) {
		id, handled, err := start(sm, ctx, cfg, cli, cwd, model, worktree, branch)
		sm.mu.Lock()
		sm.sessions[id].Backend = b
		sm.sessions[id].ControlMode = protocol.ControlManaged
		sm.mu.Unlock()
		b.coord.markSubscribed(id)
		return id, handled, err
	}
	text := "shared reference"
	digest := sha256.Sum256([]byte(text))
	teamContext := &protocol.CollaborationContext{SchemaVersion: 1, ContentHash: strings.Repeat("a", 64), PayloadHash: hex.EncodeToString(digest[:]), StableText: text}
	auth := collaborationAuth("create", "uncertain-hidden-first-turn")
	registered := false
	_, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, teamContext, adapter.AgentCodex, "user", func(context.Context, string) error { registered = true; return nil })
	if !registered || !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, errNativeSessionCreateUncertain) {
		t.Fatalf("first hidden injection did not retain uncertainty: registered=%t err=%v", registered, err)
	}
	if sm.sessions["created-1"] == nil || sm.collaborationBindings[auth.BindingID].NativeSessionID != "created-1" || sm.collaborationCalls[auth.CallID] != "created-1" {
		t.Fatal("lost hidden response lost exact native ownership")
	}
	if len(rpc.calls) != 1 || rpc.calls[0].method != "thread/inject_items" {
		t.Fatalf("lost hidden response wrote task or cleanup: %+v", rpc.calls)
	}
	auth.CallID = "retry-call"
	if _, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, teamContext, adapter.AgentCodex, "user", func(context.Context, string) error { return nil }); !errors.Is(err, ErrCollaborationBinding) || *created != 1 || len(rpc.calls) != 1 {
		t.Fatalf("uncertain hidden injection was replayed: %v attempts=%d calls=%d", err, *created, len(rpc.calls))
	}
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
	coord := newVerifiedTestCodexCoordinator(sm)
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
	var injected map[string]any
	if err := json.Unmarshal(rpc.lastCall(t, "thread/inject_items").params, &injected); err != nil {
		t.Fatal(err)
	}
	items := injected["items"].([]any)
	message := items[0].(map[string]any)
	content := message["content"].([]any)[0].(map[string]any)
	if injected["threadId"] != "thr_1" || message["role"] != "developer" || content["text"] != codexEmptySessionInitializer {
		t.Fatalf("empty session initializer=%v", injected)
	}
	var startIndex, injectIndex, turnIndex = -1, -1, -1
	for index, call := range rpc.calls {
		switch call.method {
		case "thread/start":
			startIndex = index
		case "thread/inject_items":
			injectIndex = index
		case "turn/start":
			turnIndex = index
		}
	}
	if !(startIndex >= 0 && startIndex < injectIndex && injectIndex < turnIndex) {
		t.Fatalf("initializer ordering start=%d inject=%d turn=%d", startIndex, injectIndex, turnIndex)
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

func TestCodexAppServerBackendDoesNotAnnounceUnpersistedEmptyThread(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	coord := newVerifiedTestCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/start"] = json.RawMessage(`{"thread":{"id":"thr_empty"}}`)
	rpc.errs["thread/inject_items"] = &codexapp.RPCError{Code: -32601, Message: "unsupported"}
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	if _, err := backend.Start(context.Background(), protocol.SessionConfig{Agent: "codex", Cwd: "/repo"}); err == nil || !strings.Contains(err.Error(), "persist empty Codex thread") {
		t.Fatalf("error=%v", err)
	}
	if coord.ownsInvocationThread("thr_empty") {
		t.Fatal("unpersisted empty thread was registered")
	}
	if call := rpc.lastCall(t, "thread/unsubscribe"); string(call.params) != `{"threadId":"thr_empty"}` {
		t.Fatalf("failed initializer did not release its exact native thread: %s", call.params)
	}
}

func TestCodexFailedInitializerDoesNotReleaseExistingForeignThread(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	coord := newVerifiedTestCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/start"] = json.RawMessage(`{"thread":{"id":"foreign"}}`)
	rpc.errs["thread/inject_items"] = errors.New("unsupported")
	foreign := &ProcessState{SessionID: "foreign", Agent: adapter.AgentCodex, Source: "terminal"}
	sm.sessions["foreign"] = foreign
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	if _, err := backend.Start(context.Background(), protocol.SessionConfig{Agent: "codex", Cwd: "/repo"}); err == nil {
		t.Fatal("expected initializer failure")
	}
	for _, call := range rpc.calls {
		if call.method == "thread/unsubscribe" {
			t.Fatal("initializer failure released an existing foreign thread")
		}
	}
	if sm.sessions["foreign"] != foreign {
		t.Fatal("initializer failure changed foreign session")
	}
}

func TestCodexFailedInitializerSurfacesNativeCleanupFailure(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/start"] = json.RawMessage(`{"thread":{"id":"unclosed"}}`)
	rpc.errs["thread/inject_items"] = &codexapp.RPCError{Code: -32602, Message: "initializer rejected"}
	rpc.errs["thread/unsubscribe"] = errors.New("unsubscribe unavailable")
	backend := newCodexAppServerBackend(sm, newVerifiedTestCodexCoordinator(sm), rpc, 1)
	id, err := backend.Start(context.Background(), protocol.SessionConfig{Agent: "codex", Cwd: "/repo"})
	if id != "unclosed" || err == nil || !strings.Contains(err.Error(), "unsubscribe unavailable") {
		t.Fatalf("native cleanup uncertainty was hidden: id=%q err=%v", id, err)
	}
}

func TestCreateCollaborationQuarantinesAmbiguousNativeCreation(t *testing.T) {
	sm, created := collaborationCreateManager(t, &collaborationCreateBackend{})
	sm.createDeps.startCodexManaged = func(_ *SessionManager, ctx context.Context, config protocol.SessionConfig, _, _, _, _, _ string) (string, bool, error) {
		*created++
		rpc := newFakeCodexRuntimeClient()
		rpc.errs["thread/start"] = context.DeadlineExceeded
		backend := newCodexAppServerBackend(sm, newVerifiedTestCodexCoordinator(sm), rpc, 1)
		id, err := backend.Start(ctx, config)
		return id, true, err
	}
	auth := collaborationAuth("create", "ambiguous-call")
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("missing native timeout: %v", err)
	}
	auth.CallID = "retry-call"
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); !errors.Is(err, ErrCollaborationBinding) || *created != 1 {
		t.Fatalf("ambiguous native create was duplicated: %v, attempts=%d", err, *created)
	}
}

func TestCodexStartCanceledBeforeSendDoesNotCreateOrQuarantine(t *testing.T) {
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/start"] = json.RawMessage(`{"thread":{"id":"should-not-create"}}`)
	backend := newCodexAppServerBackend(nil, newVerifiedTestCodexCoordinator(nil), rpc, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	id, err := backend.Start(ctx, protocol.SessionConfig{Agent: adapter.AgentCodex, Cwd: "/repo"})
	if id != "" || !errors.Is(err, context.Canceled) || errors.Is(err, errNativeSessionCreateUncertain) || len(rpc.calls) != 0 {
		t.Fatalf("pre-send cancellation = %q, %v; native calls=%d", id, err, len(rpc.calls))
	}
}

func TestCodexInitialTurnFailureDistinguishesRejectionFromUncertainty(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		t.Run(fmt.Sprint(uncertain), func(t *testing.T) {
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
			coord := newVerifiedTestCodexCoordinator(sm)
			rpc := newFakeCodexRuntimeClient()
			rpc.results["thread/start"] = json.RawMessage(`{"thread":{"id":"first-turn"}}`)
			rpc.errs["turn/start"] = &codexapp.RPCError{Code: -32602, Message: "invalid input"}
			if uncertain {
				rpc.errs["turn/start"] = context.DeadlineExceeded
			}
			backend := newCodexAppServerBackend(sm, coord, rpc, 1)
			id, err := backend.Start(context.Background(), protocol.SessionConfig{Agent: adapter.AgentCodex, Cwd: "/repo", Prompt: "review"})
			if err == nil || errors.Is(err, errNativeSessionCreateUncertain) != uncertain {
				t.Fatalf("initial turn error = %v, uncertain=%t", err, uncertain)
			}
			if uncertain {
				if id != "first-turn" {
					t.Fatalf("uncertain turn lost native ID: %q", id)
				}
				for _, call := range rpc.calls {
					if call.method == "thread/unsubscribe" {
						t.Fatal("ambiguous accepted turn was closed as a clean rollback")
					}
				}
			} else {
				if id != "" || len(coord.managedThreadSnapshot()) != 0 {
					t.Fatalf("rejected turn retained failed managed thread: %q %+v", id, coord.managedThreadSnapshot())
				}
				rpc.lastCall(t, "thread/unsubscribe")
			}
		})
	}
}

func TestCreateCollaborationQuarantinesLostInitializerResponse(t *testing.T) {
	sm, created := collaborationCreateManager(t, &collaborationCreateBackend{})
	coord := newVerifiedTestCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/start"] = json.RawMessage(`{"thread":{"id":"unconfirmed-initializer"}}`)
	rpc.errs["thread/inject_items"] = context.DeadlineExceeded
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	sm.createDeps.startCodexManaged = func(_ *SessionManager, ctx context.Context, config protocol.SessionConfig, _, _, _, _, _ string) (string, bool, error) {
		*created++
		id, err := backend.Start(ctx, config)
		return id, true, err
	}
	auth := collaborationAuth("create", "uncertain-initializer")
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, errNativeSessionCreateUncertain) {
		t.Fatalf("lost initializer response was treated as clean failure: %v", err)
	}
	if sm.collaborationBindings[auth.BindingID].NativeSessionID != "unconfirmed-initializer" {
		t.Fatal("lost initializer response lost known native identity")
	}
	for _, call := range rpc.calls {
		if call.method == "thread/unsubscribe" {
			t.Fatal("unknown initializer persistence was detached as clean rollback")
		}
	}
	auth.CallID = "retry-call"
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); !errors.Is(err, ErrCollaborationBinding) || *created != 1 {
		t.Fatalf("unknown initializer persistence was replayed: %v attempts=%d", err, *created)
	}
}

func TestCreateCollaborationRegisteredFirstTurnLostResponseKeepsQuarantine(t *testing.T) {
	sm, created := collaborationCreateManager(t, &collaborationCreateBackend{})
	coord := newVerifiedTestCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.errs["turn/start"] = context.DeadlineExceeded
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	start := sm.createDeps.startCodexManaged
	sm.createDeps.startCodexManaged = func(sm *SessionManager, ctx context.Context, cfg protocol.SessionConfig, cli, cwd, model, worktree, branch string) (string, bool, error) {
		id, handled, err := start(sm, ctx, cfg, cli, cwd, model, worktree, branch)
		sm.mu.Lock()
		sm.sessions[id].Backend = backend
		sm.sessions[id].ControlMode = protocol.ControlManaged
		sm.mu.Unlock()
		coord.markSubscribed(id)
		return id, handled, err
	}
	auth := collaborationAuth("create", "uncertain-first-turn")
	_, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, nil, adapter.AgentCodex, "review", func(context.Context, string) error { return nil })
	if !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, errNativeSessionCreateUncertain) {
		t.Fatalf("registered first-turn timeout treated as clean failure: %v", err)
	}
	if sm.sessions["created-1"] == nil || sm.collaborationBindings[auth.BindingID].NativeSessionID != "created-1" || sm.collaborationCalls[auth.CallID] != "created-1" {
		t.Fatal("uncertain registered first turn lost owned native identity or call quarantine")
	}
	for _, call := range rpc.calls {
		if call.method == "thread/unsubscribe" {
			t.Fatal("uncertain registered first turn was closed as clean rollback")
		}
	}
	auth.CallID = "retry-call"
	if _, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, nil, adapter.AgentCodex, "review", func(context.Context, string) error { return nil }); !errors.Is(err, ErrCollaborationBinding) || *created != 1 {
		t.Fatalf("uncertain first turn was replayed: %v attempts=%d", err, *created)
	}
}

func TestCodexAppServerBackendAdvertisesSessionHistoryDynamicTool(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.SetSessionHistoryReader(func(context.Context, string, string, string) (protocol.SessionHistoryReadResult, error) {
		return protocol.SessionHistoryReadResult{}, nil
	})
	coord := newVerifiedTestCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/start"] = json.RawMessage(`{"thread":{"id":"thr_tool"}}`)
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	if _, err := backend.Start(context.Background(), protocol.SessionConfig{Agent: "codex", Cwd: "/repo"}); err != nil {
		t.Fatal(err)
	}
	var params map[string]any
	if err := json.Unmarshal(rpc.lastCall(t, "thread/start").params, &params); err != nil {
		t.Fatal(err)
	}
	tools, ok := params["dynamicTools"].([]any)
	if !ok || len(tools) != 1 || tools[0].(map[string]any)["name"] != protocol.SessionHistoryToolName {
		t.Fatalf("dynamicTools=%#v", params["dynamicTools"])
	}
}

func TestCodexAppServerBackendForkDoesNotInjectInitializer(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	coord := newVerifiedTestCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/fork"] = json.RawMessage(`{"thread":{"id":"thr_fork"}}`)
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	sm.sessions["thr_source"] = &ProcessState{SessionID: "thr_source", Agent: adapter.AgentCodex, Backend: backend, ControlMode: protocol.ControlManaged}
	if _, err := backend.Start(context.Background(), protocol.SessionConfig{Agent: "codex", Cwd: "/repo", ForkFrom: "thr_source"}); err != nil {
		t.Fatal(err)
	}
	for _, call := range rpc.calls {
		if call.method == "thread/inject_items" {
			t.Fatal("fork received an empty-session initializer")
		}
	}
}

func TestCodexAppServerBackendStartsNewTurnWhenIdle(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	coord := newVerifiedTestCodexCoordinator(sm)
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
	coord := newVerifiedTestCodexCoordinator(sm)
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
	coord := newVerifiedTestCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"turn_new","status":"inProgress","items":[]}}`)
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)
	sm.sessions["thr_1"] = &ProcessState{SessionID: "thr_1", Agent: "codex", Source: "daemon", Status: protocol.StatusIdle, Backend: backend}
	if err := sm.SendMessage(context.Background(), "thr_1", "hello"); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-output:
		// The turn lifecycle may reserve the turn before the native user item
		// arrives (stage-2 contract: turn_status precedes attributable
		// content); a user_text echo before the native item stays forbidden.
		if event.Type != protocol.EventTypeTurnStatus {
			t.Fatalf("premature echo=%+v", event)
		}
	default:
	}
}

func TestKillSessionClosesManagedCodexWithoutWaitingForProcess(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 2)
	sm := NewSessionManager(output)
	coord := newVerifiedTestCodexCoordinator(sm)
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
	backend := newCodexAppServerBackend(sm, newVerifiedTestCodexCoordinator(sm), rpc, 1)
	if _, err := backend.Start(context.Background(), protocol.SessionConfig{Agent: "codex", Cwd: "/repo"}); err == nil {
		t.Fatal("expected app-server disconnect")
	}
}

func TestCreateSessionSelectsManagedCodexBackendWhenAvailable(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 2))
	allowCwdForTest(t, sm)
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
	allowCwdForTest(t, sm)
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
