package session

import (
	"context"
	"encoding/json"
	"os"
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
	coord.mu.Lock()
	coord.stopEventPumpLocked()
	coord.mu.Unlock()
}

func TestCodexCoordinatorStartsOneRuntimeForConcurrentAcquire(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var starts atomic.Int32
	coord := newCodexCoordinator(nil)
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
	rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[]}`)
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
		calls := len(rpc.calls)
		rpc.mu.Unlock()
		sm.mu.RLock()
		ps := sm.sessions["thr_recover"]
		ready := ps != nil && ps.Backend != nil && ps.ControlMode == protocol.ControlManaged
		sm.mu.RUnlock()
		if calls >= 2 && ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("persisted thread was not resumed: calls=%d ready=%t", calls, ready)
		}
		time.Sleep(10 * time.Millisecond)
	}
	coord.mu.Lock()
	coord.stopEventPumpLocked()
	coord.mu.Unlock()
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
