package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/daemon"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func lifecycleBackend(t *testing.T) (*CodexAppServerBackend, *fakeCodexRuntimeClient) {
	t.Helper()
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	c := newVerifiedTestCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	c.runtime = &codexAppServerRuntime{PID: os.Getpid(), Client: rpc}
	c.generation = 1
	c.statePath = filepath.Join(t.TempDir(), "runtime.state")
	b := newCodexAppServerBackend(sm, c, rpc, 1)
	sm.sessions["a"] = &ProcessState{SessionID: "a", Agent: "codex", Source: "terminal", Status: protocol.StatusIdle, ControlMode: protocol.ControlManaged, Backend: b}
	c.markSubscribed("a")
	rpc.results["thread/unsubscribe"] = json.RawMessage(`{"status":"unsubscribed"}`)
	rpc.results["thread/resume"] = json.RawMessage(`{"thread":{"id":"a","status":{"type":"idle"}}}`)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"next"}}`)
	return b, rpc
}

func TestCodexIdleReaperProtectsUsersAndActiveWork(t *testing.T) {
	for _, reason := range []string{"lease", "unknown_thread_lease", "turn", "approval", "question", "operation", "none", "dead_lease"} {
		t.Run(reason, func(t *testing.T) {
			b, rpc := lifecycleBackend(t)
			c := b.coord
			switch reason {
			case "lease", "unknown_thread_lease":
				id := "a"
				if reason == "unknown_thread_lease" {
					id = ""
				}
				if err := b.sm.leases.Register(agentcontrol.Lease{ID: "cli", Agent: "codex", SessionID: id, PID: os.Getpid(), Generation: 1}); err != nil {
					t.Fatal(err)
				}
			case "dead_lease":
				b.sm.leases.Restore(map[string]agentcontrol.Lease{"dead": {ID: "dead", Agent: "codex", SessionID: "a", PID: 99999999, Generation: 1}})
			case "turn":
				c.setActiveTurn("a", "native-turn")
			case "approval":
				b.sm.sessions["a"].Status = protocol.StatusWaitingApproval
			case "question":
				c.interactions = newCodexInteractions(b.sm, 1, rpc)
				var requestID codexapp.RequestID
				if err := json.Unmarshal([]byte(`1`), &requestID); err != nil {
					t.Fatal(err)
				}
				c.interactions.addPending(&codexPendingInteraction{threadID: "a", kind: codexQuestion, requestID: requestID})
			case "operation":
				lock := c.threadOperationLock("a")
				lock.Lock()
				defer lock.Unlock()
			}
			now := time.Now()
			c.reapIdleThreads(context.Background(), now)
			c.reapIdleThreads(context.Background(), now.Add(65*time.Second))
			wantRelease := reason == "none" || reason == "dead_lease"
			if c.threadDetached("a") != wantRelease {
				t.Fatalf("detached=%v want=%v", c.threadDetached("a"), wantRelease)
			}
			if wantRelease {
				rpc.lastCall(t, "thread/unsubscribe")
			} else if len(rpc.calls) != 0 {
				t.Fatalf("protected session RPCs=%v", rpc.calls)
			}
		})
	}
}

func TestCodexCLIReleasePreservesRunningRemoteTaskThenReaps(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	p := &CodexRuntimeProvider{sm: b.sm, coordinator: b.coord}
	if err := b.sm.leases.Register(agentcontrol.Lease{ID: "cli", Agent: "codex", SessionID: "a", PID: os.Getpid(), Generation: 1}); err != nil {
		t.Fatal(err)
	}
	b.coord.setActiveTurn("a", "remote-task")
	if err := p.Release(context.Background(), agentcontrol.ReleaseRequest{Payload: agentcontrol.ReleasePayload{LeaseID: "cli"}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	b.coord.reapIdleThreads(context.Background(), now)
	b.coord.reapIdleThreads(context.Background(), now.Add(65*time.Second))
	if b.coord.threadDetached("a") {
		t.Fatal("released running task after CLI exit")
	}
	b.coord.setActiveTurn("a", "")
	b.coord.reapIdleThreads(context.Background(), now.Add(70*time.Second))
	b.coord.reapIdleThreads(context.Background(), now.Add(135*time.Second))
	rpc.lastCall(t, "thread/unsubscribe")
	if err := b.Send(context.Background(), "a", "continue remotely"); err != nil {
		t.Fatal(err)
	}
	rpc.lastCall(t, "thread/resume")
	rpc.lastCall(t, "turn/start")
}

func TestCodexDetachedThreadSurvivesRecoveryWithoutResume(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	if err := b.Close("a"); err != nil {
		t.Fatal(err)
	}
	state, err := daemon.ReadCodexAppServerStateAt(b.coord.statePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.DetachedThreads) != 1 || state.DetachedThreads[0] != "a" {
		t.Fatalf("state=%+v", state)
	}
	rpc.results["thread/read"] = json.RawMessage(`{"thread":{"id":"a","cwd":"/repo","status":{"type":"notLoaded"}}}`)
	c := newVerifiedTestCodexCoordinator(b.sm)
	c.runtime = &codexAppServerRuntime{PID: os.Getpid(), Client: rpc}
	c.generation = 1
	c.statePath = b.coord.statePath
	c.restoreManagedThreads(state.Threads)
	c.restoreDetachedThreads(state.DetachedThreads)
	c.mu.Lock()
	c.startEventPumpLocked()
	c.mu.Unlock()
	t.Cleanup(func() { c.mu.Lock(); c.stopEventPumpLocked(); c.mu.Unlock(); c.pumpWG.Wait() })
	c.subscriptionWG.Wait()
	rpc.lastCall(t, "thread/read")
	for _, call := range rpc.calls {
		if call.method == "thread/resume" {
			t.Fatal("recovery resumed idle thread")
		}
	}
	backend, ok := b.sm.sessions["a"].Backend.(*CodexAppServerBackend)
	if !ok || backend.coord != c {
		t.Fatal("recovery did not restore remote backend")
	}
	if err := backend.Send(context.Background(), "a", "continue"); err != nil {
		t.Fatal(err)
	}
	rpc.lastCall(t, "thread/resume")
}

func TestCodexUnloadNotificationDoesNotReacquireWriter(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	if err := b.Close("a"); err != nil {
		t.Fatal(err)
	}
	message := codexapp.Inbound{Method: "thread/status/changed", Params: json.RawMessage(`{"threadId":"a","status":{"type":"notLoaded"}}`)}
	p := newCodexProjection(1)
	b.coord.projectLive(p, message)
	b.coord.maybeSubscribeTerminalThread(context.Background(), message, p)
	b.coord.subscriptionWG.Wait()
	for _, call := range rpc.calls {
		if call.method == "thread/resume" {
			t.Fatal("unload notification reacquired writer")
		}
	}
	if b.sm.sessions["a"].Status == protocol.StatusDisconnected {
		t.Fatal("idle unload disabled remote session")
	}
}

func TestCodexLateUnloadDoesNotUndoExplicitClose(t *testing.T) {
	b, _ := lifecycleBackend(t)
	if err := b.sm.KillSession("a"); err != nil {
		t.Fatal(err)
	}
	b.coord.projectLive(newCodexProjection(1), codexapp.Inbound{Method: "thread/status/changed", Params: json.RawMessage(`{"threadId":"a","status":{"type":"notLoaded"}}`)})
	if b.sm.sessions["a"].Status != protocol.StatusKilled {
		t.Fatalf("closed session resurrected as %s", b.sm.sessions["a"].Status)
	}
}

func TestCodexDetachedPersistenceFailureIsRetried(t *testing.T) {
	b, _ := lifecycleBackend(t)
	path := b.coord.statePath
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	b.coord.statePath = filepath.Join(blocker, "state")
	if err := b.Close("a"); err == nil {
		t.Fatal("expected persistence error")
	}
	b.coord.statePath = path
	b.coord.reapIdleThreads(context.Background(), time.Now())
	state, err := daemon.ReadCodexAppServerStateAt(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.DetachedThreads) != 1 {
		t.Fatalf("failed persistence was not retried: %+v", state)
	}
}

func TestCodexInvocationResumeTracksReacquiredThread(t *testing.T) {
	sm, c, rpc, _ := invocationFixture(t)
	b := sm.sessions["s"].Backend.(*CodexAppServerBackend)
	c.markSubscribed("s")
	if err := b.Close("s"); err != nil {
		t.Fatal(err)
	}
	if _, err := sm.invokeCodexCommand(context.Background(), "s", "/resume s", "command:resume", false); err != nil {
		t.Fatal(err)
	}
	rpc.lastCall(t, "thread/resume")
	if c.threadDetached("s") {
		t.Fatal("resume command left thread detached; reaper can no longer release its subscription")
	}
}

func TestCodexThreadActivityRestartsIdleGrace(t *testing.T) {
	b, _ := lifecycleBackend(t)
	c := b.coord
	now := time.Now()
	c.reapIdleThreads(context.Background(), now)
	c.projectLive(newCodexProjection(1), codexapp.Inbound{Method: "turn/completed", Params: json.RawMessage(`{"threadId":"a","turn":{"id":"finished","status":"completed","items":[]}}`)})
	c.reapIdleThreads(context.Background(), now.Add(65*time.Second))
	if c.threadDetached("a") {
		t.Fatal("released immediately after intervening task activity")
	}
}

func TestCodexRecoveryResubscribesThreadActivatedWhileDaemonOffline(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	if err := b.Close("a"); err != nil {
		t.Fatal(err)
	}
	rpc.results["thread/read"] = json.RawMessage(`{"thread":{"id":"a","status":{"type":"active"}}}`)
	rpc.results["thread/resume"] = json.RawMessage(`{"thread":{"id":"a","status":{"type":"active"}}}`)
	rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"terminal-turn","status":"inProgress","items":[]}]}`)
	b.coord.subscribeThread(context.Background(), rpc, 1, "a", newCodexProjection(1), true)
	if b.coord.threadDetached("a") {
		t.Fatal("active native thread remained detached after recovery")
	}
	if b.coord.currentTurn("a") != "terminal-turn" {
		t.Fatal("recovery lost native active turn")
	}
	rpc.lastCall(t, "thread/resume")
}

type lifecycleBlockingClient struct {
	*fakeCodexRuntimeClient
	entered chan struct{}
	finish  chan struct{}
}

func (c *lifecycleBlockingClient) Call(ctx context.Context, method string, params, result any) error {
	if method == "thread/unsubscribe" {
		close(c.entered)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.finish:
		}
	}
	return c.fakeCodexRuntimeClient.Call(ctx, method, params, result)
}

func TestCodexRemoteSendWaitsForConcurrentRelease(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	client := &lifecycleBlockingClient{fakeCodexRuntimeClient: rpc, entered: make(chan struct{}), finish: make(chan struct{})}
	b.coord.runtime.Client = client
	closed := make(chan error, 1)
	go func() { closed <- b.Close("a") }()
	<-client.entered
	sent := make(chan error, 1)
	go func() { sent <- b.Send(context.Background(), "a", "continue") }()
	close(client.finish)
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	rpc.mu.Lock()
	defer rpc.mu.Unlock()
	if len(rpc.calls) != 3 || rpc.calls[0].method != "thread/unsubscribe" || rpc.calls[1].method != "thread/resume" || rpc.calls[2].method != "turn/start" {
		t.Fatalf("RPC order=%v", rpc.calls)
	}
}

func TestCodexRemoteSendResumesBeforeReconnectHydration(t *testing.T) {
	b, _ := lifecycleBackend(t)
	next := newFakeCodexRuntimeClient()
	next.results["turn/start"] = json.RawMessage(`{"turn":{"id":"next"}}`)
	b.coord.runtime.Client = next
	b.coord.resetSubscriptionsForNewClient()
	if err := b.Send(context.Background(), "a", "continue"); err != nil {
		t.Fatal(err)
	}
	if len(next.calls) != 2 || next.calls[0].method != "thread/resume" || next.calls[1].method != "turn/start" {
		t.Fatalf("new connection RPCs=%v", next.calls)
	}
}

func TestCodexCloseUnsubscribesOnlyTargetThread(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	b.coord.markSubscribed("b")
	if err := b.Close("a"); err != nil {
		t.Fatal(err)
	}
	call := rpc.lastCall(t, "thread/unsubscribe")
	if string(call.params) != `{"threadId":"a"}` {
		t.Fatalf("unsubscribe=%s", call.params)
	}
	b.coord.subscribeMu.Lock()
	_, kept := b.coord.subscribed["b"]
	_, released := b.coord.subscribed["a"]
	b.coord.subscribeMu.Unlock()
	if !kept || released {
		t.Fatalf("other subscribed=%v target subscribed=%v", kept, released)
	}
}

func TestCodexRemoteSendResumesReleasedThread(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	if err := b.Close("a"); err != nil {
		t.Fatal(err)
	}
	if err := b.Send(context.Background(), "a", "continue"); err != nil {
		t.Fatal(err)
	}
	rpc.mu.Lock()
	defer rpc.mu.Unlock()
	var methods []string
	for _, call := range rpc.calls {
		methods = append(methods, call.method)
	}
	if len(methods) != 3 || methods[0] != "thread/unsubscribe" || methods[1] != "thread/resume" || methods[2] != "turn/start" {
		t.Fatalf("release then remote send RPCs=%v", methods)
	}
}

func TestCodexCloseDoesNotDiscardRunningTurn(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	b.coord.setActiveTurn("a", "running")
	if err := b.Close("a"); err == nil {
		t.Fatal("close must refuse an active turn")
	}
	if b.coord.currentTurn("a") != "running" {
		t.Fatal("close discarded native active turn")
	}
	if len(rpc.calls) != 0 {
		t.Fatalf("unexpected RPCs: %v", rpc.calls)
	}
}

func TestCodexReleaseFailureKeepsSubscriptionRetryable(t *testing.T) {
	b, rpc := lifecycleBackend(t)
	rpc.errs["thread/unsubscribe"] = errors.New("connection lost")
	if err := b.Close("a"); err == nil {
		t.Fatal("close must report unsubscribe failure")
	}
	if _, ok := b.coord.subscribed["a"]; !ok {
		t.Fatal("failed unsubscribe discarded subscription")
	}
	delete(rpc.errs, "thread/unsubscribe")
	if err := b.Close("a"); err != nil {
		t.Fatal(err)
	}
	rpc.errs["thread/resume"] = errors.New("writer lock held by another app")
	if err := b.Send(context.Background(), "a", "continue"); err == nil {
		t.Fatal("remote send must report resume conflict")
	}
	for _, call := range rpc.calls {
		if call.method == "turn/start" {
			t.Fatal("sent a turn after failed resume")
		}
	}
}

func TestCodexShutdownPreservesDetachedOwnership(t *testing.T) {
	b, _ := lifecycleBackend(t)
	if err := b.Close("a"); err != nil {
		t.Fatal(err)
	}
	stopped := false
	b.coord.runtime.Stop = func() error { stopped = true; return nil }
	if err := b.coord.shutdown(); err != nil {
		t.Fatal(err)
	}
	if !stopped {
		t.Fatal("idle runtime was not stopped")
	}
	state, err := daemon.ReadCodexAppServerStateAt(b.coord.statePath)
	if err != nil {
		t.Fatal(err)
	}
	if state.OwnerPID != 0 || len(state.Threads) != 1 || len(state.DetachedThreads) != 1 || state.DetachedThreads[0] != "a" {
		t.Fatalf("lost detached ownership on shutdown: %+v", state)
	}
}
