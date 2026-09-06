package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
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

func TestOpenCodeRuntimeAcquireNewCreatesAndRegistersSession(t *testing.T) {
	repo := t.TempDir()
	var createCalls atomic.Int32
	sm, _ := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/session":
			createCalls.Add(1)
			var body struct {
				Location struct {
					Directory string `json:"directory"`
				} `json:"location"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Location.Directory != normalizeCwd(repo) {
				t.Errorf("create directory=%q", body.Location.Directory)
			}
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"id": "ses_new"}})
		default:
			json.NewEncoder(w).Encode([]any{})
		}
	}), nil)

	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentNew, "", false, "new-op"))
	if err != nil || result.ResolvedSessionID != "ses_new" || result.Mode != string(agentcontrol.LaunchManaged) {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if createCalls.Load() != 1 {
		t.Fatalf("create calls=%d", createCalls.Load())
	}
	if cwd, ok := sm.GetSessionCwd("ses_new"); !ok || cwd != normalizeCwd(repo) {
		t.Fatalf("registered cwd=%q ok=%v", cwd, ok)
	}
	event := waitDaemonEvent(t, sm.outputCh, "session_discovered", "")
	if event.SessionID != "ses_new" || event.Cwd != normalizeCwd(repo) {
		t.Fatalf("event=%+v", event)
	}
}

func TestCreateOpenCodeSessionInitialDispatchFailureOrdersAttributedErrorBeforeTerminal(t *testing.T) {
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/session":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"id": "ses_initial_failure"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_initial_failure/message":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{
				"info": map[string]any{
					"id":        "msg_running",
					"sessionID": "ses_initial_failure",
					"role":      "assistant",
					"time":      map[string]int64{"created": 1},
				},
				"parts": []any{},
			}})
		default:
			_ = json.NewEncoder(w).Encode([]any{})
		}
	}), nil)
	defer coord.untrack("ses_initial_failure")

	sid, err := sm.createOpencodeSession(context.Background(), protocol.SessionConfig{
		Agent: "opencode", Cwd: repo, Model: "test/model", Prompt: "hello", Force: true,
	})
	if err != nil || sid != "ses_initial_failure" {
		t.Fatalf("session = %q, err = %v", sid, err)
	}

	events := drainEvents(sm.outputCh)
	errorIndex, failedIndex, errorCount := -1, -1, 0
	var errorEvent, failedEvent protocol.DaemonEvent
	for i, event := range events {
		switch {
		case event.Type == "error":
			errorIndex, errorEvent = i, event
			errorCount++
		case event.Type == protocol.EventTypeTurnStatus && event.TurnStatus == protocol.TurnStateFailed:
			failedIndex, failedEvent = i, event
		}
	}
	if errorCount != 1 || errorIndex < 0 || failedIndex < 0 {
		t.Fatalf("initial dispatch events = %+v, want one error and one failed terminal", events)
	}
	if errorIndex >= failedIndex {
		t.Fatalf("initial dispatch order = error:%d failed:%d", errorIndex, failedIndex)
	}
	if errorEvent.TurnID == "" || errorEvent.TurnID != failedEvent.TurnID {
		t.Fatalf("initial dispatch identity = error:%q failed:%q", errorEvent.TurnID, failedEvent.TurnID)
	}
}

func TestCreateOpenCodeSessionInitialDispatchFailureReportsErrorWithTurnEnrichmentOff(t *testing.T) {
	t.Setenv("POCKETCTL_TURN_ENRICHMENT", "off")
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/session":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"id": "ses_initial_failure_off"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_initial_failure_off/message":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{
				"info": map[string]any{
					"id":        "msg_running",
					"sessionID": "ses_initial_failure_off",
					"role":      "assistant",
					"time":      map[string]int64{"created": 1},
				},
				"parts": []any{},
			}})
		default:
			_ = json.NewEncoder(w).Encode([]any{})
		}
	}), nil)
	defer coord.untrack("ses_initial_failure_off")

	sid, err := sm.createOpencodeSession(context.Background(), protocol.SessionConfig{
		Agent: "opencode", Cwd: repo, Model: "test/model", Prompt: "hello", Force: true,
	})
	if err != nil || sid != "ses_initial_failure_off" {
		t.Fatalf("session = %q, err = %v", sid, err)
	}

	events := drainEvents(sm.outputCh)
	errorCount, turnStatusCount := 0, 0
	var errorEvent protocol.DaemonEvent
	for _, event := range events {
		switch event.Type {
		case "error":
			errorCount++
			errorEvent = event
		case protocol.EventTypeTurnStatus:
			turnStatusCount++
		}
	}
	if errorCount != 1 {
		t.Fatalf("off-mode initial dispatch events = %+v, want one client-visible error", events)
	}
	if errorEvent.TurnID != "" || errorEvent.SourceTurnID != "" {
		t.Fatalf("off-mode error unexpectedly carries turn identity: %+v", errorEvent)
	}
	if turnStatusCount != 0 {
		t.Fatalf("off mode emitted %d turn_status events: %+v", turnStatusCount, events)
	}
}

func TestOpenCodeRuntimeAcquireRunCreatesAndRegistersExactSession(t *testing.T) {
	repo := t.TempDir()
	var createCalls atomic.Int32
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/session" {
			createCalls.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"id": "ses_run"}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)

	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentRun, "", false, "run-op"))
	if err != nil || result.ResolvedSessionID != "ses_run" || result.Mode != string(agentcontrol.LaunchManaged) {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if createCalls.Load() != 1 {
		t.Fatalf("create calls=%d", createCalls.Load())
	}
	if !coord.isManagedSession("ses_run") || sm.SessionControlMode("ses_run") != protocol.ControlManaged {
		t.Fatal("run session was not registered as managed")
	}
}

func TestOpenCodeRuntimeAcquireDoesNotBlockOnRelayBackpressure(t *testing.T) {
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/session" {
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"id": "ses_offline"}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	for len(sm.outputCh) < cap(sm.outputCh) {
		sm.outputCh <- protocol.DaemonEvent{Type: "offline_backlog"}
	}

	type acquireOutcome struct {
		result agentcontrol.AcquireResult
		err    error
	}
	done := make(chan acquireOutcome, 1)
	go func() {
		result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentNew, "", false, "offline-op"))
		done <- acquireOutcome{result: result, err: err}
	}()

	select {
	case outcome := <-done:
		if outcome.err != nil || outcome.result.ResolvedSessionID != "ses_offline" || outcome.result.LeaseID == "" {
			t.Fatalf("result=%+v err=%v", outcome.result, outcome.err)
		}
		if !sm.hasActiveOpenCodeLeases(coord.generation) {
			t.Fatal("acquire returned without registering its terminal lease")
		}
		deadline := time.After(5 * time.Second)
		for {
			select {
			case event := <-sm.outputCh:
				if event.Type == "session_discovered" && event.SessionID == "ses_offline" {
					return
				}
			case <-deadline:
				t.Fatal("managed session discovery was lost after relay backpressure cleared")
			}
		}
	// The invariant is causal, not a sub-second latency target: outputCh
	// remains full until this branch, so a synchronous enqueue cannot finish
	// at any speed. Leave enough headroom for the race-enabled full gate to
	// schedule the fake HTTP server and persist the lease handoff.
	case <-time.After(5 * time.Second):
		<-sm.outputCh // unblock the old synchronous implementation before failing
		<-done
		t.Fatal("runtime acquire blocked behind relay event backpressure")
	}
}

func TestOpenCodeRuntimeAcquireRegistersLeaseAndShutdownPolicy(t *testing.T) {
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/session" {
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"id": "ses_lease"}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)

	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentNew, "", false, "lease-op"))
	if err != nil {
		t.Fatal(err)
	}
	if result.LeaseID == "" || !sm.hasActiveOpenCodeLeases(coord.generation) {
		t.Fatalf("lease not registered: result=%+v", result)
	}
	if err := sm.Release(context.Background(), agentcontrol.ReleaseRequest{Payload: agentcontrol.ReleasePayload{LeaseID: result.LeaseID}}); err != nil {
		t.Fatal(err)
	}
	if sm.hasActiveOpenCodeLeases(coord.generation) {
		t.Fatal("released lease still preserves runtime")
	}
}

func TestOpenCodeLeaseReaperPersistsTerminalExit(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	terminal := sleepCommand(t, 30)
	if err := terminal.Start(); err != nil {
		t.Fatal(err)
	}
	const sessionID = "ses_lease_exit"
	sm.mu.Lock()
	sm.sessions[sessionID] = &ProcessState{
		SessionID: sessionID, Agent: adapter.AgentOpencode, Source: "terminal", Status: protocol.StatusIdle,
	}
	sm.mu.Unlock()
	var stateChanges atomic.Int32
	sm.OnStateChanged = func() { stateChanges.Add(1) }
	if err := sm.leases.Register(agentcontrol.Lease{
		ID: "lease-exit", Agent: agentcontrol.AgentOpenCode, SessionID: sessionID,
		PID: terminal.Process.Pid, Generation: coord.generation,
	}); err != nil {
		_ = terminal.Process.Kill()
		t.Fatal(err)
	}
	if err := coord.persistLeaseHandoff(); err != nil {
		_ = terminal.Process.Kill()
		t.Fatal(err)
	}
	if err := terminal.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = terminal.Wait()

	if err := coord.reapTerminalLeases(); err != nil {
		t.Fatal(err)
	}
	handoff, err := daemon.ReadOpenCodeServeState()
	if err != nil {
		t.Fatal(err)
	}
	if len(handoff.Leases) != 0 {
		t.Fatalf("dead terminal lease remained in handoff: %+v", handoff.Leases)
	}
	sm.mu.RLock()
	status, exitReason := sm.sessions[sessionID].Status, sm.sessions[sessionID].ExitReason
	sm.mu.RUnlock()
	if status != protocol.StatusExited || exitReason != protocol.ExitReasonNormalExit {
		t.Fatalf("session status=%q reason=%q, want exited normal_exit", status, exitReason)
	}
	if stateChanges.Load() == 0 {
		t.Fatal("terminal exit did not mark daemon state dirty")
	}
	select {
	case event := <-sm.outputCh:
		if event.Type != "session_status" || event.SessionID != sessionID || event.Status != protocol.StatusExited {
			t.Fatalf("exit event=%+v", event)
		}
	default:
		t.Fatal("terminal exit event was not emitted")
	}
}

func TestOpenCodeLeaseReaperKeepsSessionLiveWithAnotherTerminalLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	first, second := sleepCommand(t, 30), sleepCommand(t, 30)
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	if err := second.Start(); err != nil {
		_ = first.Process.Kill()
		t.Fatal(err)
	}
	defer func() {
		_ = first.Process.Kill()
		_ = second.Process.Kill()
		_ = first.Wait()
		_ = second.Wait()
	}()

	const sessionID = "ses_shared_lease"
	sm.mu.Lock()
	sm.sessions[sessionID] = &ProcessState{
		SessionID: sessionID, Agent: adapter.AgentOpencode, Source: "terminal", Status: protocol.StatusIdle,
	}
	sm.mu.Unlock()
	for id, pid := range map[string]int{"lease-first": first.Process.Pid, "lease-second": second.Process.Pid} {
		if err := sm.leases.Register(agentcontrol.Lease{
			ID: id, Agent: agentcontrol.AgentOpenCode, SessionID: sessionID, PID: pid, Generation: coord.generation,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()
	if err := coord.reapTerminalLeases(); err != nil {
		t.Fatal(err)
	}

	sm.mu.RLock()
	status := sm.sessions[sessionID].Status
	sm.mu.RUnlock()
	if status != protocol.StatusIdle {
		t.Fatalf("status=%q, want idle while another terminal lease is live", status)
	}
	select {
	case event := <-sm.outputCh:
		t.Fatalf("unexpected lifecycle event while lease remains: %+v", event)
	default:
	}
}

func TestOpenCodeShutdownPreservesServeForActiveLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	coord.mu.Lock()
	pid := coord.server.PID()
	state := coord.openCodeHandoffState(coord.server, coord.generation)
	coord.mu.Unlock()
	if err := daemon.WriteOpenCodeServeState(state); err != nil {
		t.Fatal(err)
	}
	if err := sm.leases.Register(agentcontrol.Lease{ID: "lease-live", Agent: agentcontrol.AgentOpenCode, PID: os.Getpid(), Generation: coord.generation}); err != nil {
		t.Fatal(err)
	}
	coord.Shutdown()
	if !platform.NewProcessController().IsAlive(pid) {
		t.Fatal("active terminal lease did not preserve OpenCode serve")
	}
	handoff, err := daemon.ReadOpenCodeServeState()
	if err != nil || handoff.OwnerPID != 0 || len(handoff.Leases) != 1 {
		t.Fatalf("handoff=%+v err=%v", handoff, err)
	}
}

func TestOpenCodeShutdownDoesNotKillActiveTerminalWhenHandoffWriteFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	coord.mu.Lock()
	pid := coord.server.PID()
	generation := coord.generation
	coord.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(daemon.OpenCodeServeStatePath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(daemon.OpenCodeServeStatePath(), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := sm.leases.Register(agentcontrol.Lease{ID: "lease-live", Agent: agentcontrol.AgentOpenCode, PID: os.Getpid(), Generation: generation}); err != nil {
		t.Fatal(err)
	}
	coord.Shutdown()
	time.Sleep(100 * time.Millisecond)
	if !platform.NewProcessController().IsAlive(pid) {
		t.Fatal("serve was killed because handoff metadata could not be updated")
	}
}

func TestOpenCodeRuntimeAcquireContinueSelectsNewestSessionInDirectory(t *testing.T) {
	repo := t.TempDir()
	other := t.TempDir()
	sm, _ := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/session":
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
				{"id": "ses_other", "time": map[string]int64{"updated": 999}, "location": map[string]string{"directory": other}},
				{"id": "ses_old", "time": map[string]int64{"updated": 10}, "location": map[string]string{"directory": repo}},
				{"id": "ses_latest", "time": map[string]int64{"updated": 20}, "location": map[string]string{"directory": filepath.Join(repo, ".")}},
			}})
		default:
			json.NewEncoder(w).Encode([]any{})
		}
	}), nil)

	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentContinue, "", false, "continue-op"))
	if err != nil || result.ResolvedSessionID != "ses_latest" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestOpenCodeRuntimeAcquireResumeValidatesDirectory(t *testing.T) {
	repo := t.TempDir()
	other := t.TempDir()
	sm, _ := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/session/ses_123" {
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_123", "directory": other}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)

	_, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentResume, "ses_123", false, "resume-op"))
	var protocolErr *agentcontrol.ProtocolError
	if !errors.As(err, &protocolErr) || protocolErr.Code != agentcontrol.ErrInvalidRequest {
		t.Fatalf("error=%v", err)
	}
}

func TestOpenCodeRuntimeAcquireForkDefersManagedChildUntilDiscovery(t *testing.T) {
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/session/ses_parent":
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_parent", "directory": repo}})
		case "/api/session":
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{
				"id": "ses_child", "parentID": "ses_parent", "time": map[string]int64{"updated": time.Now().UnixMilli()}, "location": map[string]string{"directory": repo},
			}}})
		default:
			json.NewEncoder(w).Encode([]any{})
		}
	}), nil)

	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentResume, "ses_parent", true, "fork-op"))
	if err != nil || result.ResolvedSessionID != "ses_parent" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if coord.isManagedSession("ses_parent") {
		t.Fatal("fork parent must not be promoted as the managed child")
	}
	coord.discoverOnce(context.Background())
	if !coord.isManagedSession("ses_child") {
		t.Fatal("discovered fork child was not marked managed")
	}
}

func TestOpenCodeRuntimeAcquireTracksConcurrentForkChildren(t *testing.T) {
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/session/ses_parent":
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_parent", "directory": repo}})
		case "/api/session":
			now := time.Now().UnixMilli()
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
				{"id": "ses_child_1", "parentID": "ses_parent", "time": map[string]int64{"updated": now}, "location": map[string]string{"directory": repo}},
				{"id": "ses_child_2", "parentID": "ses_parent", "time": map[string]int64{"updated": now}, "location": map[string]string{"directory": repo}},
			}})
		default:
			json.NewEncoder(w).Encode([]any{})
		}
	}), nil)
	for _, operationID := range []string{"fork-1", "fork-2"} {
		if _, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentResume, "ses_parent", true, operationID)); err != nil {
			t.Fatal(err)
		}
	}
	coord.discoverOnce(context.Background())
	if !coord.isManagedSession("ses_child_1") || !coord.isManagedSession("ses_child_2") {
		t.Fatalf("managed child1=%v child2=%v", coord.isManagedSession("ses_child_1"), coord.isManagedSession("ses_child_2"))
	}
}

func TestOpenCodeRuntimeAcquireUnhealthyServeFallsBack(t *testing.T) {
	repo := t.TempDir()
	var healthy atomic.Bool
	healthy.Store(true)
	sm, _ := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]any{})
	}), healthy.Load)
	var recorded []bool
	sm.SetOpenCodeRuntimeHealthRecorder(func(value bool) { recorded = append(recorded, value) })
	healthy.Store(false)
	_, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentNew, "", false, "health-op"))
	var protocolErr *agentcontrol.ProtocolError
	if !errors.As(err, &protocolErr) || protocolErr.Code != agentcontrol.ErrRuntimeUnavailable {
		t.Fatalf("error=%v", err)
	}
	if len(recorded) != 1 || recorded[0] {
		t.Fatalf("runtime health observations=%v", recorded)
	}
}

func TestOpenCodeRuntimeAcquireUnsupportedVersionReturnsNative(t *testing.T) {
	repo := t.TempDir()
	var createCalls atomic.Int32
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/session" {
			createCalls.Add(1)
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	coord.mu.Lock()
	coord.realVersion = "1.17.10"
	coord.mu.Unlock()
	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentNew, "", false, "old-version-op"))
	if err != nil || result.Mode != string(agentcontrol.LaunchNative) || result.RealBinary == "" || result.Reason == "" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if createCalls.Load() != 0 {
		t.Fatalf("create calls=%d", createCalls.Load())
	}
}

func TestOpenCodeRuntimeAcquireDuplicateOperationCreatesOnce(t *testing.T) {
	repo := t.TempDir()
	var createCalls atomic.Int32
	sm, _ := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/session" {
			createCalls.Add(1)
			time.Sleep(30 * time.Millisecond)
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"id": "ses_once"}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	endpoint := platform.NewIPCListener().DefaultPath("agent-control-runtime-duplicate-test")
	server := agentcontrol.NewServer(endpoint, map[string]agentcontrol.RuntimeProvider{agentcontrol.AgentOpenCode: sm})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client := agentcontrol.NewClient(endpoint)
	payload := agentcontrol.AcquirePayload{CWD: repo, Intent: agentcontrol.IntentNew, OperationID: "same-operation"}

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result, err := client.Acquire(ctx, payload)
			if err == nil && result.ResolvedSessionID != "ses_once" {
				err = errors.New("unexpected resolved session")
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := createCalls.Load(); got != 1 {
		t.Fatalf("create calls=%d, want 1", got)
	}
}

func newOpenCodeRuntimeTestManagerWithHealth(t *testing.T, handler http.Handler, health func() bool) (*SessionManager, *opencodeCoordinator) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	realBinary := filepath.Join(home, "real-opencode")
	realBinary = writeFakeCommandFixture(t, realBinary,
		"#!/bin/sh\nexit 0\n",
		"@echo off\nexit /B 0\n",
	)
	cfg := agentcontrol.DefaultConfig()
	cfg.OpenCode.State = agentcontrol.StateEnabled
	cfg.OpenCode.RealBinary = realBinary
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	server := startFakeOpenCodeServerWithHealth(t, handler, health)
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	coord := newOpencodeCoordinator(sm)
	coord.mu.Lock()
	coord.server, coord.started, coord.generation, coord.realBinary = server, true, 7, realBinary
	coord.mu.Unlock()
	coord.recoverSession = nil
	sm.opencode = coord
	return sm, coord
}

func runtimeAcquireRequest(cwd, intent, sessionID string, fork bool, operationID string) agentcontrol.AcquireRequest {
	return agentcontrol.AcquireRequest{Agent: agentcontrol.AgentOpenCode, ClientPID: os.Getpid(), Payload: agentcontrol.AcquirePayload{
		CWD: cwd, Intent: intent, SessionID: sessionID, Fork: fork, OperationID: operationID,
	}}
}
