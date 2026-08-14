package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexCoordinatorProjectsRuntimeEventsIntoSessionManager(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	events := make(chan codexapp.Inbound, 4)
	done := make(chan struct{})
	go func() {
		coord.consumeEvents(context.Background(), events, newCodexProjection(9))
		close(done)
	}()
	events <- codexapp.Inbound{Method: "thread/started", Params: json.RawMessage(`{"thread":{"id":"thr_terminal","cwd":"/repo","name":"Terminal","status":{"type":"idle"}}}`)}
	events <- codexapp.Inbound{Method: "turn/started", Params: json.RawMessage(`{"threadId":"thr_terminal","turn":{"id":"turn_1","status":"inProgress","items":[]}}`)}
	close(events)
	<-done

	sm.mu.RLock()
	ps, ok := sm.sessions["thr_terminal"]
	sm.mu.RUnlock()
	if !ok {
		t.Fatal("terminal thread was not registered")
	}
	if ps.Agent != "codex" || ps.Source != "terminal" || ps.ControlMode != protocol.ControlManaged || ps.Status != protocol.StatusRunning || ps.Cwd != "/repo" {
		t.Fatalf("session=%+v", ps)
	}
	first, second := <-output, <-output
	if first.Type != "session_discovered" || second.Type != "session_status" {
		t.Fatalf("events=%+v %+v", first, second)
	}
}

func TestCodexCoordinatorIdleAndTurnCompletionOrderAlwaysSettlesIdle(t *testing.T) {
	orders := [][]codexapp.Inbound{
		{
			codexNotification("thread/status/changed", `{"threadId":"thr_1","status":{"type":"idle"}}`),
			codexNotification("turn/completed", `{"threadId":"thr_1","turn":{"id":"turn_1","status":"completed"}}`),
		},
		{
			codexNotification("turn/completed", `{"threadId":"thr_1","turn":{"id":"turn_1","status":"completed"}}`),
			codexNotification("thread/status/changed", `{"threadId":"thr_1","status":{"type":"idle"}}`),
		},
	}

	for i, order := range orders {
		t.Run(fmt.Sprintf("order_%d", i+1), func(t *testing.T) {
			output := make(chan protocol.DaemonEvent, 8)
			sm := NewSessionManager(output)
			coord := newCodexCoordinator(sm)
			projector := newCodexProjection(uint64(i + 1))
			for _, notification := range order {
				coord.publishProjected(projector.Project(notification))
			}

			sm.mu.RLock()
			got := sm.sessions["thr_1"].Status
			sm.mu.RUnlock()
			if got != protocol.StatusIdle {
				t.Fatalf("status=%q, want idle managed thread", got)
			}
		})
	}
}

func TestCodexCoordinatorResumesAndHydratesTerminalThread(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/resume"] = json.RawMessage(`{"model":"gpt-5.6","cwd":"/repo","thread":{"id":"thr_terminal","cwd":"/repo","name":"Terminal","status":{"type":"active"},"turns":[]}}`)
	rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"turn_1","status":"inProgress","items":[{"id":"user_1","type":"userMessage","content":[{"type":"text","text":"hello"}]}]}]}`)
	coord.runtime = &codexAppServerRuntime{PID: 123, Endpoint: "/tmp/codex.sock", RemoteURI: "unix:///tmp/codex.sock", Client: rpc}
	coord.generation = 5
	coord.startEventPumpLocked()
	rpc.events <- codexapp.Inbound{Method: "thread/status/changed", Params: json.RawMessage(`{"threadId":"thr_terminal","status":{"type":"active","activeFlags":[]}}`)}

	deadline := time.Now().Add(2 * time.Second)
	for {
		rpc.mu.Lock()
		callCount := len(rpc.calls)
		rpc.mu.Unlock()
		sm.mu.RLock()
		ps := sm.sessions["thr_terminal"]
		ready := ps != nil && ps.Backend != nil && ps.Model == "gpt-5.6"
		sm.mu.RUnlock()
		if callCount >= 2 && ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("terminal subscription did not complete: calls=%d ready=%t", callCount, ready)
		}
		time.Sleep(10 * time.Millisecond)
	}
	resume := rpc.lastCall(t, "thread/resume")
	if string(resume.params) != `{"excludeTurns":true,"threadId":"thr_terminal"}` {
		t.Fatalf("resume=%s", resume.params)
	}
	turns := rpc.lastCall(t, "thread/turns/list")
	var turnsParams map[string]any
	_ = json.Unmarshal(turns.params, &turnsParams)
	if turnsParams["threadId"] != "thr_terminal" || turnsParams["itemsView"] != "full" {
		t.Fatalf("turns params=%v", turnsParams)
	}
	if turnsParams["sortDirection"] != "asc" {
		t.Fatalf("sort direction=%v, want Codex app-server enum asc", turnsParams["sortDirection"])
	}
	if coord.currentTurn("thr_terminal") != "turn_1" {
		t.Fatalf("active turn=%q", coord.currentTurn("thr_terminal"))
	}
	if sm.CwdSessionCount("/repo") != 1 {
		t.Fatalf("cwd sessions=%d", sm.CwdSessionCount("/repo"))
	}
	coord.mu.Lock()
	coord.stopEventPumpLocked()
	coord.mu.Unlock()
}

func TestCodexCoordinatorResumedThreadStatusWinsHistoricalHydration(t *testing.T) {
	tests := []struct {
		native string
		want   string
	}{
		{native: "active", want: protocol.StatusRunning},
		{native: "systemError", want: protocol.StatusError},
		{native: "notLoaded", want: protocol.StatusDisconnected},
		{native: "idle", want: protocol.StatusIdle},
	}

	for generation, tt := range tests {
		t.Run(tt.native, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			output := make(chan protocol.DaemonEvent, 32)
			sm := NewSessionManager(output)
			coord := newCodexCoordinator(sm)
			rpc := newFakeCodexRuntimeClient()
			rpc.results["thread/resume"] = json.RawMessage(`{"model":"gpt-5.6","cwd":"/repo","thread":{"id":"thr_terminal","cwd":"/repo","status":{"type":"` + tt.native + `"},"turns":[]}}`)
			rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"turn_active","status":"inProgress","items":[{"id":"agent_1","type":"agentMessage","text":"historical"}]}]}`)
			coord.runtime = &codexAppServerRuntime{PID: 123, Endpoint: "/tmp/codex.sock", RemoteURI: "unix:///tmp/codex.sock", Client: rpc}
			coord.generation = uint64(generation + 1)

			coord.subscribeTerminalThread(context.Background(), rpc, coord.generation, "thr_terminal", newCodexProjection(coord.generation))

			sm.mu.RLock()
			ps := sm.sessions["thr_terminal"]
			sm.mu.RUnlock()
			if ps == nil || ps.Status != tt.want {
				t.Fatalf("session=%+v, want resumed status %q", ps, tt.want)
			}
			wantTurn := ""
			if tt.native == "active" {
				wantTurn = "turn_active"
			}
			if got := coord.currentTurn("thr_terminal"); got != wantTurn {
				t.Fatalf("active turn=%q, want %q for resumed %s", got, wantTurn, tt.native)
			}
			for len(output) > 0 {
				if event := <-output; event.Type == "error" {
					t.Fatalf("historical failed turn emitted live error: %+v", event)
				}
			}
		})
	}
}

type blockingTurnsListClient struct {
	*fakeCodexRuntimeClient
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (f *blockingTurnsListClient) Call(ctx context.Context, method string, params any, result any) error {
	if method == "thread/turns/list" {
		f.once.Do(func() { close(f.entered) })
		select {
		case <-f.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return f.fakeCodexRuntimeClient.Call(ctx, method, params, result)
}

func TestCodexCoordinatorLiveStatusWinsBlockedHistoricalHydration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	base := newFakeCodexRuntimeClient()
	base.results["thread/resume"] = json.RawMessage(`{"thread":{"id":"thr_race","cwd":"/repo","status":{"type":"idle"}}}`)
	base.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"turn_stale","status":"inProgress","items":[]}]}`)
	client := &blockingTurnsListClient{fakeCodexRuntimeClient: base, entered: make(chan struct{}), release: make(chan struct{})}
	coord := newCodexCoordinator(sm)
	coord.runtime = &codexAppServerRuntime{PID: 123, Client: client}
	coord.generation = 9
	projector := newCodexProjection(9)
	done := make(chan struct{})
	go func() {
		coord.subscribeTerminalThread(context.Background(), client, 9, "thr_race", projector)
		close(done)
	}()
	<-client.entered
	coord.projectLive(projector, codexNotification("thread/status/changed", `{"threadId":"thr_race","status":{"type":"systemError"}}`))
	close(client.release)
	<-done

	if got := sessionStatus(sm, "thr_race"); got != protocol.StatusError {
		t.Fatalf("status=%q, want live systemError to win stale resume idle", got)
	}
	if got := coord.currentTurn("thr_race"); got != "" {
		t.Fatalf("active turn=%q, stale historical turn must be cleared", got)
	}
}

func TestCodexCoordinatorLiveTurnWinsBlockedHistoricalHydration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	base := newFakeCodexRuntimeClient()
	base.results["thread/resume"] = json.RawMessage(`{"thread":{"id":"thr_live_turn","cwd":"/repo","status":{"type":"idle"}}}`)
	base.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"turn_stale","status":"inProgress","items":[]}]}`)
	client := &blockingTurnsListClient{fakeCodexRuntimeClient: base, entered: make(chan struct{}), release: make(chan struct{})}
	coord := newCodexCoordinator(sm)
	coord.runtime = &codexAppServerRuntime{PID: 123, Client: client}
	coord.generation = 15
	projector := newCodexProjection(15)
	done := make(chan struct{})
	go func() {
		coord.subscribeTerminalThread(context.Background(), client, 15, "thr_live_turn", projector)
		close(done)
	}()
	<-client.entered
	coord.projectLive(projector, codexNotification("turn/started", `{"threadId":"thr_live_turn","turn":{"id":"turn_live","status":"inProgress"}}`))
	close(client.release)
	<-done
	if got := coord.currentTurn("thr_live_turn"); got != "turn_live" {
		t.Fatalf("active turn=%q, want live turn to win resumed idle", got)
	}
}

type blockingResumeClient struct {
	*fakeCodexRuntimeClient
	blockedThread string
	entered       chan struct{}
	release       chan struct{}
	responses     map[string]json.RawMessage
	once          sync.Once
}

func (f *blockingResumeClient) Call(ctx context.Context, method string, params any, result any) error {
	if method != "thread/resume" {
		return f.fakeCodexRuntimeClient.Call(ctx, method, params, result)
	}
	raw, _ := json.Marshal(params)
	var request map[string]any
	_ = json.Unmarshal(raw, &request)
	threadID, _ := request["threadId"].(string)
	f.mu.Lock()
	f.calls = append(f.calls, fakeCodexCall{method: method, params: raw})
	response := append(json.RawMessage(nil), f.responses[threadID]...)
	f.mu.Unlock()
	if threadID == f.blockedThread {
		f.once.Do(func() { close(f.entered) })
		select {
		case <-f.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return json.Unmarshal(response, result)
}

func TestCodexCoordinatorBlockedResumeDoesNotBlockOtherThreadProjectionOrSubscription(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	base := newFakeCodexRuntimeClient()
	base.results["thread/turns/list"] = json.RawMessage(`{"data":[]}`)
	client := &blockingResumeClient{
		fakeCodexRuntimeClient: base, blockedThread: "thr_slow", entered: make(chan struct{}), release: make(chan struct{}),
		responses: map[string]json.RawMessage{
			"thr_slow": json.RawMessage(`{"thread":{"id":"thr_slow","status":{"type":"idle"}}}`),
			"thr_fast": json.RawMessage(`{"thread":{"id":"thr_fast","status":{"type":"active"}}}`),
		},
	}
	coord := newCodexCoordinator(sm)
	coord.runtime = &codexAppServerRuntime{PID: 123, Client: client}
	coord.generation = 16
	projector := newCodexProjection(16)
	slowDone := make(chan struct{})
	go func() {
		coord.subscribeTerminalThread(context.Background(), client, 16, "thr_slow", projector)
		close(slowDone)
	}()
	<-client.entered
	liveDone := make(chan struct{})
	go func() {
		coord.projectLive(projector, codexNotification("thread/status/changed", `{"threadId":"thr_fast","status":{"type":"idle"}}`))
		close(liveDone)
	}()
	fastDone := make(chan struct{})
	go func() {
		coord.subscribeTerminalThread(context.Background(), client, 16, "thr_fast", projector)
		close(fastDone)
	}()
	select {
	case <-liveDone:
	case <-time.After(time.Second):
		t.Fatal("slow resume blocked another thread's live projection")
	}
	select {
	case <-fastDone:
	case <-time.After(time.Second):
		t.Fatal("slow resume blocked another thread subscription")
	}
	close(client.release)
	<-slowDone
}

func TestCodexCoordinatorLiveTurnDuringBlockedResumeWinsResumedIdle(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	base := newFakeCodexRuntimeClient()
	base.results["thread/turns/list"] = json.RawMessage(`{"data":[]}`)
	client := &blockingResumeClient{
		fakeCodexRuntimeClient: base, blockedThread: "thr_resume_turn", entered: make(chan struct{}), release: make(chan struct{}),
		responses: map[string]json.RawMessage{
			"thr_resume_turn": json.RawMessage(`{"thread":{"id":"thr_resume_turn","status":{"type":"idle"}}}`),
		},
	}
	coord := newCodexCoordinator(sm)
	coord.runtime = &codexAppServerRuntime{PID: 123, Client: client}
	coord.generation = 20
	projector := newCodexProjection(20)
	done := make(chan struct{})
	go func() {
		coord.subscribeTerminalThread(context.Background(), client, 20, "thr_resume_turn", projector)
		close(done)
	}()
	<-client.entered
	coord.projectLive(projector, codexNotification("turn/started", `{"threadId":"thr_resume_turn","turn":{"id":"turn_live_resume","status":"inProgress"}}`))
	close(client.release)
	<-done
	if got := coord.currentTurn("thr_resume_turn"); got != "turn_live_resume" {
		t.Fatalf("active turn=%q, want live turn started during resume", got)
	}
	if got := sessionStatus(sm, "thr_resume_turn"); got != protocol.StatusRunning {
		t.Fatalf("status=%q, want live turn running to override resumed idle", got)
	}
}

func TestCodexCoordinatorDuplicateLiveStatusDuringResumeOrdersSnapshotWithoutDuplicateOutput(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	base := newFakeCodexRuntimeClient()
	base.results["thread/turns/list"] = json.RawMessage(`{"data":[]}`)
	client := &blockingResumeClient{
		fakeCodexRuntimeClient: base, blockedThread: "thr_duplicate", entered: make(chan struct{}), release: make(chan struct{}),
		responses: map[string]json.RawMessage{
			"thr_duplicate": json.RawMessage(`{"thread":{"id":"thr_duplicate","status":{"type":"idle"}}}`),
		},
	}
	coord := newCodexCoordinator(sm)
	coord.runtime = &codexAppServerRuntime{PID: 123, Client: client}
	coord.generation = 21
	projector := newCodexProjection(21)
	coord.projectLive(projector, codexNotification("thread/status/changed", `{"threadId":"thr_duplicate","status":{"type":"active"}}`))
	done := make(chan struct{})
	go func() {
		coord.subscribeTerminalThread(context.Background(), client, 21, "thr_duplicate", projector)
		close(done)
	}()
	<-client.entered
	coord.projectLive(projector, codexNotification("thread/status/changed", `{"threadId":"thr_duplicate","status":{"type":"active"}}`))
	close(client.release)
	<-done
	if got := sessionStatus(sm, "thr_duplicate"); got != protocol.StatusRunning {
		t.Fatalf("status=%q, want duplicate live active to order ahead of resumed idle", got)
	}
	statusEvents := 0
	for len(output) > 0 {
		if event := <-output; event.Type == "session_status" {
			statusEvents++
		}
	}
	if statusEvents != 1 {
		t.Fatalf("session_status events=%d, want duplicate output deduplicated", statusEvents)
	}
}

type pagedTurnsListClient struct {
	*fakeCodexRuntimeClient
	pages map[string]json.RawMessage
}

func (f *pagedTurnsListClient) Call(ctx context.Context, method string, params any, result any) error {
	if method != "thread/turns/list" {
		return f.fakeCodexRuntimeClient.Call(ctx, method, params, result)
	}
	raw, _ := json.Marshal(params)
	var request map[string]any
	_ = json.Unmarshal(raw, &request)
	cursor, _ := request["cursor"].(string)
	f.mu.Lock()
	f.calls = append(f.calls, fakeCodexCall{method: method, params: raw})
	response := append(json.RawMessage(nil), f.pages[cursor]...)
	f.mu.Unlock()
	return json.Unmarshal(response, result)
}

func TestCodexCoordinatorHydratesAllTurnPagesAndLatestActiveTurn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	base := newFakeCodexRuntimeClient()
	base.results["thread/resume"] = json.RawMessage(`{"thread":{"id":"thr_pages","cwd":"/repo","status":{"type":"active"}}}`)
	client := &pagedTurnsListClient{fakeCodexRuntimeClient: base, pages: map[string]json.RawMessage{
		"":       json.RawMessage(`{"data":[{"id":"turn_1","status":"completed","items":[{"id":"agent_1","type":"agentMessage","text":"first page"}]}],"nextCursor":"page-2"}`),
		"page-2": json.RawMessage(`{"data":[{"id":"turn_2","status":"inProgress","items":[{"id":"agent_2","type":"agentMessage","text":"second page"}]}],"nextCursor":null}`),
	}}
	coord := newCodexCoordinator(sm)
	coord.runtime = &codexAppServerRuntime{PID: 123, Client: client}
	coord.generation = 10
	coord.subscribeTerminalThread(context.Background(), client, 10, "thr_pages", newCodexProjection(10))

	if got := coord.currentTurn("thr_pages"); got != "turn_2" {
		t.Fatalf("active turn=%q, want latest paginated turn", got)
	}
	client.mu.Lock()
	var listCalls []fakeCodexCall
	for _, call := range client.calls {
		if call.method == "thread/turns/list" {
			listCalls = append(listCalls, call)
		}
	}
	client.mu.Unlock()
	if len(listCalls) != 2 || !strings.Contains(string(listCalls[1].params), `"cursor":"page-2"`) {
		t.Fatalf("turn list calls=%+v", listCalls)
	}
	texts := map[string]bool{}
	for len(output) > 0 {
		event := <-output
		if event.Type == "agent_text" {
			texts[event.Text] = true
		}
	}
	if !texts["first page"] || !texts["second page"] {
		t.Fatalf("hydrated texts=%v, want both pages", texts)
	}
}

func TestCodexCoordinatorTurnPaginationStopsOnCursorCycle(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	base := newFakeCodexRuntimeClient()
	base.results["thread/resume"] = json.RawMessage(`{"thread":{"id":"thr_cycle","status":{"type":"idle"}}}`)
	client := &pagedTurnsListClient{fakeCodexRuntimeClient: base, pages: map[string]json.RawMessage{
		"":  json.RawMessage(`{"data":[],"nextCursor":"A"}`),
		"A": json.RawMessage(`{"data":[],"nextCursor":"B"}`),
		"B": json.RawMessage(`{"data":[],"nextCursor":"A"}`),
	}}
	coord := newCodexCoordinator(sm)
	coord.runtime = &codexAppServerRuntime{PID: 123, Client: client}
	coord.generation = 17
	coord.subscribeTerminalThread(context.Background(), client, 17, "thr_cycle", newCodexProjection(17))
	client.mu.Lock()
	listCalls := 0
	for _, call := range client.calls {
		if call.method == "thread/turns/list" {
			listCalls++
		}
	}
	client.mu.Unlock()
	if listCalls != 3 {
		t.Fatalf("turn list calls=%d, want safe termination after A->B->A", listCalls)
	}
}

func TestCodexCoordinatorEventPumpRoutesServerRequests(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	rpc := newInteractionCodexClient()
	coord.runtime = &codexAppServerRuntime{PID: 123, Endpoint: "/tmp/codex.sock", RemoteURI: "unix:///tmp/codex.sock", Client: rpc}
	coord.generation = 6
	coord.startEventPumpLocked()
	rpc.events <- codexServerRequest(t, `1`, "item/fileChange/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"patch_1","startedAtMs":1
	}`)
	event := nextCodexEvent(t, output, "approval_request")
	if event.SessionID != "thr_1" || event.ApprovalKind != "fileChange" {
		t.Fatalf("event=%+v", event)
	}
	coord.publishProjected([]protocol.DaemonEvent{{Type: "session_status", SessionID: "thr_1", Status: protocol.StatusRunning}})
	sm.mu.RLock()
	status := sm.sessions["thr_1"].Status
	sm.mu.RUnlock()
	if status != protocol.StatusWaitingApproval {
		t.Fatalf("active thread status overrode pending approval: %q", status)
	}
	coord.mu.Lock()
	coord.stopEventPumpLocked()
	coord.mu.Unlock()
}

func TestCodexCoordinatorReconnectsDaemonClientAfterSocketDisconnect(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	coord := newCodexCoordinator(sm)
	oldClient := newFakeCodexRuntimeClient()
	newClient := newFakeCodexRuntimeClient()
	newClient.results["thread/resume"] = json.RawMessage(`{"thread":{"id":"thr_reconnect","cwd":"/repo","status":{"type":"idle"},"turns":[]}}`)
	newClient.results["thread/turns/list"] = json.RawMessage(`{"data":[]}`)
	coord.runtime = &codexAppServerRuntime{PID: os.Getpid(), Endpoint: "/tmp/codex.sock", RemoteURI: "unix:///tmp/codex.sock", Client: oldClient}
	coord.binary, coord.version, coord.schemaHash, coord.generation = "/opt/codex", "0.144.1", "abc", 4
	coord.managedThreads["thr_reconnect"] = struct{}{}
	coord.subscribed["thr_reconnect"] = struct{}{}
	if err := coord.persist(); err != nil {
		t.Fatal(err)
	}
	var adopts atomic.Int32
	coord.adopt = func(context.Context, *daemon.CodexAppServerState) (*codexAppServerRuntime, error) {
		adopts.Add(1)
		return &codexAppServerRuntime{PID: os.Getpid(), Endpoint: "/tmp/codex.sock", RemoteURI: "unix:///tmp/codex.sock", Client: newClient}, nil
	}
	coord.mu.Lock()
	coord.startEventPumpLocked()
	coord.mu.Unlock()
	close(oldClient.events)
	deadline := time.Now().Add(3 * time.Second)
	for {
		client, generation, ok := coord.backendClient()
		newClient.mu.Lock()
		calls := len(newClient.calls)
		newClient.mu.Unlock()
		if ok && generation == 4 && client == newClient && adopts.Load() == 1 && calls >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("client was not reconnected and resumed: ok=%t generation=%d adopts=%d calls=%d", ok, generation, adopts.Load(), calls)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := coord.shutdown(); err != nil {
		t.Fatalf("shutdown reconnected coordinator: %v", err)
	}
}

func TestCodexCoordinatorStartsOneRuntimeForConcurrentAcquire(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var starts atomic.Int32
	coord := newCodexCoordinator(nil)
	coord.probe = func(context.Context, *codexAppServerRuntime) error { return nil }
	coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		starts.Add(1)
		return &codexAppServerRuntime{PID: 123, Endpoint: "/tmp/codex.sock", RemoteURI: "unix:///tmp/codex.sock"}, nil
	}
	const callers = 20
	var wg sync.WaitGroup
	results := make(chan codexRuntimeSnapshot, callers)
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			snapshot, err := coord.ensureStarted(context.Background(), "/opt/codex", "0.144.1", agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "abc"})
			if err != nil {
				t.Errorf("ensureStarted: %v", err)
				return
			}
			results <- snapshot
		}()
	}
	wg.Wait()
	close(results)
	if starts.Load() != 1 {
		t.Fatalf("starts=%d want 1", starts.Load())
	}
	for result := range results {
		if result.Generation != 1 || result.RemoteURI != "unix:///tmp/codex.sock" || result.Binary != "/opt/codex" {
			t.Fatalf("snapshot=%+v", result)
		}
	}
}

func TestCodexCoordinatorReplacesRuntimeWhenEndpointIsMissing(t *testing.T) {
	coord := newCodexCoordinator(nil)
	stopped := false
	coord.runtime = &codexAppServerRuntime{
		PID:       123,
		Endpoint:  t.TempDir() + "/missing.sock",
		RemoteURI: "unix:///missing.sock",
		Stop:      func() error { stopped = true; return nil },
	}
	coord.binary, coord.version, coord.schemaHash, coord.generation = "/opt/codex", "0.144.1", "abc", 4
	var startedGeneration uint64
	coord.start = func(_ context.Context, _, _ string, generation uint64) (*codexAppServerRuntime, error) {
		startedGeneration = generation
		return &codexAppServerRuntime{PID: 456, Endpoint: "/tmp/new-codex.sock", RemoteURI: "unix:///tmp/new-codex.sock"}, nil
	}

	snapshot, err := coord.ensureStarted(context.Background(), "/opt/codex", "0.144.1", agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "abc"})
	if err != nil {
		t.Fatal(err)
	}
	if !stopped {
		t.Fatal("missing endpoint did not stop the old runtime")
	}
	if startedGeneration != 5 || snapshot.Generation != 5 || snapshot.PID != 456 {
		t.Fatalf("started=%d snapshot=%+v", startedGeneration, snapshot)
	}
}

func TestCodexCoordinatorReplacesHealthyIncompatibleRuntimeWhenIdle(t *testing.T) {
	tests := []struct {
		name       string
		binary     string
		version    string
		schemaHash string
	}{
		{"binary changed", "/opt/codex-new", "0.146.1", "old-schema"},
		{"version changed", "/opt/codex", "0.147.0", "old-schema"},
		{"schema changed", "/opt/codex", "0.146.1", "new-schema"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			stopped := false
			coord := newCodexCoordinator(nil)
			coord.runtime = &codexAppServerRuntime{
				PID:       123,
				Endpoint:  "/tmp/codex-old.sock",
				RemoteURI: "unix:///tmp/codex-old.sock",
				Stop:      func() error { stopped = true; return nil },
			}
			coord.binary, coord.version, coord.schemaHash, coord.generation = "/opt/codex", "0.146.1", "old-schema", 4
			coord.restoreManagedThreads([]string{"thr_keep"})
			coord.probe = func(context.Context, *codexAppServerRuntime) error { return nil }
			var startedGeneration uint64
			coord.start = func(_ context.Context, binary, version string, generation uint64) (*codexAppServerRuntime, error) {
				if binary != tt.binary || version != tt.version {
					t.Fatalf("start identity=(%q, %q), want (%q, %q)", binary, version, tt.binary, tt.version)
				}
				startedGeneration = generation
				return &codexAppServerRuntime{PID: 456, Endpoint: "/tmp/codex-new.sock", RemoteURI: "unix:///tmp/codex-new.sock"}, nil
			}

			snapshot, err := coord.ensureStarted(context.Background(), tt.binary, tt.version, agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: tt.schemaHash})
			if err != nil {
				t.Fatal(err)
			}
			if !stopped {
				t.Fatal("idle incompatible runtime was not stopped")
			}
			if startedGeneration != 5 || snapshot.Generation != 5 || snapshot.PID != 456 || snapshot.Binary != tt.binary || snapshot.Version != tt.version || snapshot.SchemaHash != tt.schemaHash {
				t.Fatalf("started=%d snapshot=%+v", startedGeneration, snapshot)
			}
			if threads := coord.managedThreadSnapshot(); len(threads) != 1 || threads[0] != "thr_keep" {
				t.Fatalf("threads=%v want preserved managed thread", threads)
			}
		})
	}
}

func TestCodexCoordinatorDefersHealthyIncompatibleRuntimeWithActiveLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	coord := newCodexCoordinator(sm)
	stopped := false
	coord.runtime = &codexAppServerRuntime{
		PID:       123,
		Endpoint:  "/tmp/codex-old.sock",
		RemoteURI: "unix:///tmp/codex-old.sock",
		Stop:      func() error { stopped = true; return nil },
	}
	coord.binary, coord.version, coord.schemaHash, coord.generation = "/opt/codex", "0.146.1", "old-schema", 4
	coord.restoreManagedThreads([]string{"thr_keep"})
	coord.probe = func(context.Context, *codexAppServerRuntime) error { return nil }
	if err := sm.leases.Register(agentcontrol.Lease{ID: "active-terminal", Agent: agentcontrol.AgentCodex, PID: os.Getpid(), Generation: 4}); err != nil {
		t.Fatal(err)
	}
	coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		t.Fatal("active terminal allowed an incompatible runtime to restart")
		return nil, nil
	}

	snapshot, err := coord.ensureStarted(context.Background(), "/opt/codex", "0.147.0", agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "old-schema"})
	if !errors.Is(err, errCodexRuntimeUpgradeDeferred) {
		t.Fatalf("err=%v want deferred runtime upgrade", err)
	}
	if stopped {
		t.Fatal("active terminal did not preserve the old runtime")
	}
	if snapshot.Generation != 4 || snapshot.Version != "0.146.1" || snapshot.PID != 123 {
		t.Fatalf("snapshot=%+v want current active generation", snapshot)
	}
	if !hasActiveCodexLease(sm.leases.Snapshot(), 4) {
		t.Fatal("active Codex lease was not preserved")
	}
	if threads := coord.managedThreadSnapshot(); len(threads) != 1 || threads[0] != "thr_keep" {
		t.Fatalf("threads=%v want preserved managed thread", threads)
	}
}

func TestCodexCoordinatorKeepsRuntimeWhenEndpointIsMissingAndTerminalIsActive(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	coord := newCodexCoordinator(sm)
	stopped := false
	coord.runtime = &codexAppServerRuntime{
		PID:       123,
		Endpoint:  t.TempDir() + "/missing.sock",
		RemoteURI: "unix:///missing.sock",
		Stop:      func() error { stopped = true; return nil },
	}
	coord.binary, coord.version, coord.schemaHash, coord.generation = "/opt/codex", "0.144.1", "abc", 4
	if err := sm.leases.Register(agentcontrol.Lease{ID: "active-terminal", Agent: agentcontrol.AgentCodex, PID: os.Getpid(), Generation: 4}); err != nil {
		t.Fatal(err)
	}
	coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		t.Fatal("active terminal allowed an unavailable runtime to restart")
		return nil, nil
	}

	_, err := coord.ensureStarted(context.Background(), "/opt/codex", "0.144.1", agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "abc"})
	if err == nil || !strings.Contains(err.Error(), "managed terminal is active") {
		t.Fatalf("err=%v want active-terminal endpoint error", err)
	}
	if stopped {
		t.Fatal("active terminal did not preserve the old runtime")
	}
}

func TestCodexCoordinatorReplacesUnadoptableHandoffWithoutActiveTerminal(t *testing.T) {
	oldRuntime := exec.Command("sleep", "30")
	if err := oldRuntime.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = oldRuntime.Process.Kill()
		_, _ = oldRuntime.Process.Wait()
	})
	state := &daemon.CodexAppServerState{
		PID: oldRuntime.Process.Pid, OwnerPID: 0,
		Endpoint: t.TempDir() + "/missing.sock", RemoteURI: "unix:///missing.sock",
		Binary: "/opt/codex", Version: "0.144.1", SchemaHash: "abc", Generation: 7,
		Threads: []string{"thr_recover"},
	}
	if err := daemon.WriteCodexAppServerState(state); err != nil {
		t.Fatal(err)
	}
	coord := newCodexCoordinator(nil)
	coord.adopt = func(context.Context, *daemon.CodexAppServerState) (*codexAppServerRuntime, error) {
		return nil, errors.New("missing app-server socket")
	}
	var startedGeneration uint64
	coord.start = func(_ context.Context, _, _ string, generation uint64) (*codexAppServerRuntime, error) {
		startedGeneration = generation
		return &codexAppServerRuntime{PID: 456, Endpoint: "/tmp/new-codex.sock", RemoteURI: "unix:///tmp/new-codex.sock"}, nil
	}

	snapshot, err := coord.ensureStarted(context.Background(), state.Binary, state.Version, agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: state.SchemaHash})
	if err != nil {
		t.Fatal(err)
	}
	if startedGeneration != 8 || snapshot.Generation != 8 {
		t.Fatalf("started=%d snapshot=%+v", startedGeneration, snapshot)
	}
	threads := coord.managedThreadSnapshot()
	if len(threads) != 1 || threads[0] != "thr_recover" {
		t.Fatalf("threads=%v want persisted managed thread", threads)
	}
}

func TestCodexCoordinatorAdoptsHealthyHandoffWithoutCompetingStart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	state := &daemon.CodexAppServerState{
		PID: os.Getpid(), OwnerPID: os.Getpid(), Endpoint: "/tmp/existing.sock",
		RemoteURI: "unix:///tmp/existing.sock", Binary: "/opt/codex", Version: "0.144.1",
		SchemaHash: "abc", Generation: 7,
	}
	if err := daemon.WriteCodexAppServerState(state); err != nil {
		t.Fatal(err)
	}
	coord := newCodexCoordinator(nil)
	coord.adopt = func(context.Context, *daemon.CodexAppServerState) (*codexAppServerRuntime, error) {
		return &codexAppServerRuntime{PID: os.Getpid(), Endpoint: state.Endpoint, RemoteURI: state.RemoteURI}, nil
	}
	coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		t.Fatal("healthy handoff started a competing app-server")
		return nil, nil
	}
	snapshot, err := coord.ensureStarted(context.Background(), "/opt/codex", "0.144.1", agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "abc"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Generation != 7 || snapshot.RemoteURI != state.RemoteURI {
		t.Fatalf("snapshot=%+v", snapshot)
	}
}

func TestCodexCoordinatorAdoptionResumesPersistedManagedThreads(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["thread/resume"] = json.RawMessage(`{"model":"gpt-5.6","cwd":"/repo","thread":{"id":"thr_recover","cwd":"/repo","status":{"type":"idle"},"turns":[]}}`)
	rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"turn_historical","status":"completed","items":[]}]}`)
	state := &daemon.CodexAppServerState{
		PID: os.Getpid(), OwnerPID: 0, Endpoint: "/tmp/existing.sock", RemoteURI: "unix:///tmp/existing.sock",
		Binary: "/opt/codex", Version: "0.144.1", SchemaHash: "abc", Generation: 7, Threads: []string{"thr_recover"},
	}
	if err := daemon.WriteCodexAppServerState(state); err != nil {
		t.Fatal(err)
	}
	coord := newCodexCoordinator(sm)
	coord.adopt = func(context.Context, *daemon.CodexAppServerState) (*codexAppServerRuntime, error) {
		return &codexAppServerRuntime{PID: os.Getpid(), Endpoint: state.Endpoint, RemoteURI: state.RemoteURI, Client: rpc}, nil
	}
	if _, err := coord.ensureStarted(context.Background(), state.Binary, state.Version, agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: state.SchemaHash}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		rpc.mu.Lock()
		resumed := false
		turnsListed := false
		for _, call := range rpc.calls {
			switch call.method {
			case "thread/resume":
				resumed = true
			case "thread/turns/list":
				turnsListed = true
			}
		}
		rpc.mu.Unlock()
		sm.mu.RLock()
		ps := sm.sessions["thr_recover"]
		ready := ps != nil && ps.Backend != nil && ps.ControlMode == protocol.ControlManaged
		sm.mu.RUnlock()
		coord.subscribeMu.Lock()
		_, subscribed := coord.subscribed["thr_recover"]
		_, subscribing := coord.subscribing["thr_recover"]
		coord.subscribeMu.Unlock()
		hydrated := ready && subscribed && !subscribing
		if resumed && turnsListed && hydrated {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("persisted thread did not finish hydration: resumed=%t turns_listed=%t hydrated=%t", resumed, turnsListed, hydrated)
		}
		time.Sleep(10 * time.Millisecond)
	}
	resume := rpc.lastCall(t, "thread/resume")
	if string(resume.params) != `{"excludeTurns":true,"threadId":"thr_recover"}` {
		t.Fatalf("resume params=%s", resume.params)
	}
	turns := rpc.lastCall(t, "thread/turns/list")
	var turnsParams map[string]any
	if err := json.Unmarshal(turns.params, &turnsParams); err != nil {
		t.Fatal(err)
	}
	if turnsParams["threadId"] != "thr_recover" || turnsParams["itemsView"] != "full" {
		t.Fatalf("turns params=%v", turnsParams)
	}
	if got := sessionStatus(sm, "thr_recover"); got != protocol.StatusIdle {
		t.Fatalf("recovered status=%q, want idle", got)
	}
	for {
		select {
		case event := <-output:
			if event.Type == "session_status" && event.SessionID == "thr_recover" && event.Status == protocol.StatusCompleted {
				t.Fatalf("historical turn emitted completed session status: %+v", event)
			}
		default:
			goto drained
		}
	}
drained:
	coord.mu.Lock()
	coord.stopEventPumpLocked()
	coord.mu.Unlock()
}

func sessionStatus(sm *SessionManager, sessionID string) string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if ps := sm.sessions[sessionID]; ps != nil {
		return ps.Status
	}
	return ""
}

func TestCodexCoordinatorStaleHandoffAdvancesGeneration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	state := &daemon.CodexAppServerState{PID: 99999999, OwnerPID: 99999999, Endpoint: "/tmp/stale.sock", RemoteURI: "unix:///tmp/stale.sock", Binary: "/opt/codex", Version: "0.144.1", SchemaHash: "abc", Generation: 7}
	if err := daemon.WriteCodexAppServerState(state); err != nil {
		t.Fatal(err)
	}
	coord := newCodexCoordinator(nil)
	var startedGeneration uint64
	coord.start = func(_ context.Context, _, _ string, generation uint64) (*codexAppServerRuntime, error) {
		startedGeneration = generation
		return &codexAppServerRuntime{PID: 123, Endpoint: "/tmp/new.sock", RemoteURI: "unix:///tmp/new.sock"}, nil
	}
	if _, err := coord.ensureStarted(context.Background(), "/opt/codex", "0.144.1", agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "abc"}); err != nil {
		t.Fatal(err)
	}
	if startedGeneration != 8 {
		t.Fatalf("generation=%d want 8", startedGeneration)
	}
}

func TestCodexCoordinatorShutdownRelinquishesRuntimeWithActiveLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	coord := newCodexCoordinator(sm)
	stopped := false
	coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		return &codexAppServerRuntime{PID: os.Getpid(), Endpoint: "/tmp/live.sock", RemoteURI: "unix:///tmp/live.sock", Stop: func() error { stopped = true; return nil }}, nil
	}
	snapshot, err := coord.ensureStarted(context.Background(), "/opt/codex", "0.144.1", agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "abc"})
	if err != nil {
		t.Fatal(err)
	}
	if err := sm.leases.Register(agentcontrol.Lease{ID: "lease", Agent: agentcontrol.AgentCodex, PID: os.Getpid(), Generation: snapshot.Generation}); err != nil {
		t.Fatal(err)
	}
	if err := coord.persist(); err != nil {
		t.Fatal(err)
	}
	if err := coord.shutdown(); err != nil {
		t.Fatal(err)
	}
	if stopped {
		t.Fatal("active terminal lease was stopped")
	}
	state, err := daemon.ReadCodexAppServerState()
	if err != nil {
		t.Fatal(err)
	}
	if state.OwnerPID != 0 {
		t.Fatalf("owner_pid=%d want 0", state.OwnerPID)
	}
}

func TestCodexCoordinatorShutdownIgnoresActiveOpenCodeLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	coord := newCodexCoordinator(sm)
	stopped := false
	coord.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		return &codexAppServerRuntime{
			PID: os.Getpid(), Endpoint: "/tmp/live.sock", RemoteURI: "unix:///tmp/live.sock",
			Stop: func() error { stopped = true; return nil },
		}, nil
	}
	snapshot, err := coord.ensureStarted(context.Background(), "/opt/codex", "0.144.1", agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "abc"})
	if err != nil {
		t.Fatal(err)
	}
	if err := sm.leases.Register(agentcontrol.Lease{ID: "opencode-lease", Agent: agentcontrol.AgentOpenCode, PID: os.Getpid(), Generation: snapshot.Generation}); err != nil {
		t.Fatal(err)
	}
	if err := coord.shutdown(); err != nil {
		t.Fatal(err)
	}
	if !stopped {
		t.Fatal("OpenCode lease kept Codex app-server alive")
	}
	if _, err := daemon.ReadCodexAppServerState(); !os.IsNotExist(err) {
		t.Fatalf("Codex handoff survived shutdown with only an OpenCode lease: %v", err)
	}
}
