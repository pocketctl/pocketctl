package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type fakeCodexResponse struct {
	id     string
	result json.RawMessage
	err    *codexapp.RPCError
}

type interactionCodexClient struct {
	*fakeCodexRuntimeClient
	responseMu sync.Mutex
	responses  []fakeCodexResponse
}

func newInteractionCodexClient() *interactionCodexClient {
	return &interactionCodexClient{fakeCodexRuntimeClient: newFakeCodexRuntimeClient()}
}

func (f *interactionCodexClient) Respond(id codexapp.RequestID, result any, rpcErr *codexapp.RPCError) error {
	raw, _ := json.Marshal(result)
	f.responseMu.Lock()
	f.responses = append(f.responses, fakeCodexResponse{id: id.Key(), result: raw, err: rpcErr})
	f.responseMu.Unlock()
	return nil
}

func codexServerRequest(t *testing.T, rawID, method, params string) codexapp.Inbound {
	t.Helper()
	var id codexapp.RequestID
	if err := json.Unmarshal([]byte(rawID), &id); err != nil {
		t.Fatal(err)
	}
	return codexapp.Inbound{ID: &id, Method: method, Params: json.RawMessage(params)}
}

func nextCodexEvent(t *testing.T, events <-chan protocol.DaemonEvent, eventType string) protocol.DaemonEvent {
	t.Helper()
	for i := 0; i < 8; i++ {
		event := <-events
		if event.Type == eventType {
			return event
		}
	}
	t.Fatalf("missing event type %s", eventType)
	return protocol.DaemonEvent{}
}

func TestCodexInteractionsApprovalIDsAndAvailableDecisionValidation(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 7, client)

	numeric := codexServerRequest(t, `1`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","startedAtMs":1,
		"command":"rm a","cwd":"/repo","reason":"needs write",
		"availableDecisions":["accept","decline"]
	}`)
	stringID := codexServerRequest(t, `"1"`, "item/fileChange/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"patch_1","startedAtMs":2,"reason":"edit"
	}`)
	interactions.Handle(numeric)
	first := nextCodexEvent(t, output, "approval_request")
	interactions.Handle(stringID)
	second := nextCodexEvent(t, output, "approval_request")
	if first.Type != "approval_request" || first.SessionID != "thr_1" || first.RequestID == "" || first.Tool != "commandExecution" || first.Command != "rm a" || first.Cwd != "/repo" {
		t.Fatalf("command approval=%+v", first)
	}
	if second.Type != "approval_request" || second.RequestID == first.RequestID || second.Tool != "fileChange" {
		t.Fatalf("file approval=%+v", second)
	}
	if err := interactions.ResolveApproval(context.Background(), "thr_1", first.RequestID, "always"); err == nil {
		t.Fatal("acceptForSession must be rejected when unavailable")
	}
	if err := interactions.ResolveApproval(context.Background(), "thr_1", first.RequestID, "once"); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	response := client.responses[len(client.responses)-1]
	client.responseMu.Unlock()
	if response.id != "n:1" || string(response.result) != `{"decision":"accept"}` {
		t.Fatalf("response=%+v", response)
	}
}

func TestCodexInteractionsRemoteResolutionWins(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 2, client)
	request := codexServerRequest(t, `99`, "item/fileChange/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"patch_1","startedAtMs":1
	}`)
	interactions.Handle(request)
	asked := nextCodexEvent(t, output, "approval_request")
	interactions.Handle(codexNotification("serverRequest/resolved", `{"threadId":"thr_1","requestId":99}`))
	resolved := nextCodexEvent(t, output, "approval_resolved")
	if resolved.Type != "approval_resolved" || resolved.RequestID != asked.RequestID || resolved.Reason != protocol.InteractionResolvedElsewhere {
		t.Fatalf("resolved=%+v", resolved)
	}
	err := interactions.ResolveApproval(context.Background(), "thr_1", asked.RequestID, "once")
	var resolvedElsewhere *ResolvedElsewhereError
	if !errors.As(err, &resolvedElsewhere) {
		t.Fatalf("resolve error=%v", err)
	}
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	if len(client.responses) != 0 {
		t.Fatalf("losing client wrote response=%+v", client.responses)
	}
}

func TestCodexInteractionsBackToBackRequestAndRemoteResolutionPublishInOrder(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	interactions := newCodexInteractions(sm, 22, newInteractionCodexClient())
	interactions.Handle(codexServerRequest(t, `1`, "item/fileChange/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"patch_1"
	}`))
	interactions.Handle(codexNotification("serverRequest/resolved", `{"threadId":"thr_1","requestId":1}`))
	events := []protocol.DaemonEvent{<-output, <-output, <-output, <-output}
	if events[0].Type != "approval_request" || events[1].Type != "session_status" || events[1].Status != protocol.StatusWaitingApproval || events[2].Type != "approval_resolved" || events[3].Type != "session_status" {
		t.Fatalf("publication order=%+v", events)
	}
}

func TestCodexInteractionsLocalResolutionPublishesAfterRequestAndWaiting(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	interactions := newCodexInteractions(sm, 23, newInteractionCodexClient())
	interactions.Handle(codexServerRequest(t, `1`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","availableDecisions":["accept"]
	}`))
	interactions.mu.Lock()
	publicID := ""
	for _, pending := range interactions.pendingByNative {
		publicID = pending.publicID
	}
	interactions.mu.Unlock()
	if err := interactions.ResolveApproval(context.Background(), "thr_1", publicID, "once"); err != nil {
		t.Fatal(err)
	}
	events := []protocol.DaemonEvent{<-output, <-output, <-output, <-output}
	if events[0].Type != "approval_request" || events[1].Type != "session_status" || events[1].Status != protocol.StatusWaitingApproval || events[2].Type != "approval_resolved" || events[3].Type != "session_status" {
		t.Fatalf("publication order=%+v", events)
	}
}

func TestCodexInteractionsFinalResolutionReconcilesDeferredTerminalStatus(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 3, client)
	coord.interactions = interactions

	interactions.Handle(codexServerRequest(t, `99`, "item/fileChange/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"patch_1","startedAtMs":1
	}`))
	asked := nextCodexEvent(t, output, "approval_request")
	projector := newCodexProjection(3)
	coord.publishProjected(projector.Project(codexNotification("turn/completed", `{"threadId":"thr_1","turn":{"id":"turn_1","status":"completed"}}`)))
	coord.publishProjected(projector.Project(codexNotification("thread/status/changed", `{"threadId":"thr_1","status":{"type":"idle"}}`)))

	interactions.Handle(codexNotification("serverRequest/resolved", `{"threadId":"thr_1","requestId":99}`))
	resolved := nextCodexEvent(t, output, "approval_resolved")
	if resolved.RequestID != asked.RequestID {
		t.Fatalf("resolved=%+v, want request %q", resolved, asked.RequestID)
	}
	status := nextCodexEvent(t, output, "session_status")
	if status.Status != protocol.StatusIdle {
		t.Fatalf("final status=%+v, want deferred idle", status)
	}
	sm.mu.RLock()
	got := sm.sessions["thr_1"].Status
	sm.mu.RUnlock()
	if got != protocol.StatusIdle {
		t.Fatalf("session status=%q, want idle", got)
	}
}

type blockingInteractionClient struct {
	*interactionCodexClient
	started chan struct{}
	release chan struct{}
}

func (f *blockingInteractionClient) Respond(id codexapp.RequestID, result any, rpcErr *codexapp.RPCError) error {
	f.started <- struct{}{}
	<-f.release
	return f.interactionCodexClient.Respond(id, result, rpcErr)
}

func TestCodexInteractionsDelayedFinalResolutionRestoresDeferredIdle(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	client := &blockingInteractionClient{interactionCodexClient: newInteractionCodexClient(), started: make(chan struct{}, 1), release: make(chan struct{})}
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 13, client)
	coord.interactions = interactions
	interactions.Handle(codexServerRequest(t, `1`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","availableDecisions":["accept"]
	}`))
	asked := nextCodexEvent(t, output, "approval_request")
	_ = nextCodexEvent(t, output, "session_status")
	errCh := make(chan error, 1)
	go func() { errCh <- interactions.ResolveApproval(context.Background(), "thr_1", asked.RequestID, "once") }()
	<-client.started
	statusDone := make(chan struct{})
	go func() {
		coord.publishProjected([]protocol.DaemonEvent{{Type: "session_status", SessionID: "thr_1", Status: protocol.StatusIdle}})
		close(statusDone)
	}()
	close(client.release)
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	<-statusDone
	statuses := []string{nextCodexEvent(t, output, "session_status").Status, nextCodexEvent(t, output, "session_status").Status}
	if statuses[0] != protocol.StatusRunning || statuses[1] != protocol.StatusIdle {
		t.Fatalf("status order=%v, want restored running then newer idle", statuses)
	}
}

func TestCodexInteractionsTicketedFinalizersAndLaterStatusPublishFIFO(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 64)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 14, client)
	coord.interactions = interactions
	requestIDs := make([]string, 0, 2)
	for i := 1; i <= 2; i++ {
		interactions.Handle(codexServerRequest(t, fmt.Sprint(i), "item/commandExecution/requestApproval", `{
			"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_`+fmt.Sprint(i)+`","availableDecisions":["accept"]
		}`))
		requestIDs = append(requestIDs, nextCodexEvent(t, output, "approval_request").RequestID)
		_ = nextCodexEvent(t, output, "session_status")
	}
	blockerRelease, open := interactions.beginLifecycle("thr_1")
	if !open {
		t.Fatal("broker unexpectedly closed")
	}
	waitForTickets := func(want uint64) {
		t.Helper()
		deadline := time.Now().Add(time.Second)
		for {
			interactions.sequencerMu.Lock()
			sequencer := interactions.sequencers["thr_1"]
			interactions.sequencerMu.Unlock()
			sequencer.mu.Lock()
			next := sequencer.next
			sequencer.mu.Unlock()
			if next == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("ticket count=%d, want %d", next, want)
			}
			time.Sleep(time.Millisecond)
		}
	}
	errs := make(chan error, 2)
	go func() { errs <- interactions.ResolveApproval(context.Background(), "thr_1", requestIDs[0], "once") }()
	waitForTickets(4)
	go func() { errs <- interactions.ResolveApproval(context.Background(), "thr_1", requestIDs[1], "once") }()
	waitForTickets(5)
	statusDone := make(chan struct{})
	go func() {
		coord.publishProjected([]protocol.DaemonEvent{{Type: "session_status", SessionID: "thr_1", Status: protocol.StatusIdle}})
		close(statusDone)
	}()
	waitForTickets(6)
	blockerRelease()
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	<-statusDone
	events := []protocol.DaemonEvent{<-output, <-output, <-output, <-output}
	if events[0].Type != "approval_resolved" || events[0].RequestID != requestIDs[0] || events[1].Type != "approval_resolved" || events[1].RequestID != requestIDs[1] {
		t.Fatalf("resolution order=%+v", events)
	}
	if events[2].Type != "session_status" || events[2].Status != protocol.StatusRunning || events[3].Type != "session_status" || events[3].Status != protocol.StatusIdle {
		t.Fatalf("lifecycle order=%+v, want running then idle", events)
	}
}

func TestCodexInteractionsCloseDoesNotWaitForResponseAndDropsStaleResult(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := &blockingInteractionClient{interactionCodexClient: newInteractionCodexClient(), started: make(chan struct{}, 1), release: make(chan struct{})}
	interactions := newCodexInteractions(sm, 26, client)
	interactions.Handle(codexServerRequest(t, `1`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","availableDecisions":["accept"]
	}`))
	asked := nextCodexEvent(t, output, "approval_request")
	_ = nextCodexEvent(t, output, "session_status")
	errCh := make(chan error, 1)
	go func() { errCh <- interactions.ResolveApproval(context.Background(), "thr_1", asked.RequestID, "once") }()
	<-client.started
	closed := make(chan struct{})
	go func() {
		interactions.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close waited for blocked Respond")
	}
	close(client.release)
	if err := <-errCh; err == nil {
		t.Fatal("response completing after Close unexpectedly succeeded")
	}
	select {
	case event := <-output:
		t.Fatalf("closed broker published stale event %+v", event)
	default:
	}
}

func TestCodexInteractionsCloseBetweenCheckAndSendDropsStaleEvent(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 1)
	output <- protocol.DaemonEvent{Type: "sentinel"}
	interactions := newCodexInteractions(NewSessionManager(output), 29, newInteractionCodexClient())
	checked := make(chan struct{})
	release := make(chan struct{})
	interactions.beforeLifecycleEmit = func(protocol.DaemonEvent) {
		close(checked)
		<-release
	}
	published := make(chan bool, 1)
	go func() {
		published <- interactions.publishEvent(protocol.DaemonEvent{Type: "session_status", SessionID: "thr_1", Status: protocol.StatusIdle})
	}()
	<-checked
	interactions.Close()
	<-output
	close(release)
	if <-published {
		t.Fatal("event was published after Close won the pre-send window")
	}
	select {
	case event := <-output:
		t.Fatalf("closed broker sent stale event %+v", event)
	default:
	}
}

func TestCodexInteractionsCloseDoesNotWaitForBlockedOutput(t *testing.T) {
	output := make(chan protocol.DaemonEvent)
	interactions := newCodexInteractions(NewSessionManager(output), 30, newInteractionCodexClient())
	blocked := make(chan struct{})
	var once sync.Once
	interactions.afterSendBlocked = func() {
		once.Do(func() { close(blocked) })
	}
	published := make(chan bool, 1)
	go func() {
		published <- interactions.publishEvent(protocol.DaemonEvent{Type: "session_status", SessionID: "thr_1", Status: protocol.StatusIdle})
	}()
	<-blocked
	closed := make(chan struct{})
	go func() {
		interactions.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close waited for output channel backpressure")
	}
	if <-published {
		t.Fatal("blocked event published after Close")
	}
}

func TestCodexInteractionsCloseWakesTicketWaiter(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent))
	interactions := newCodexInteractions(sm, 27, newInteractionCodexClient())
	release, open := interactions.beginLifecycle("thr_1")
	if !open {
		t.Fatal("broker unexpectedly closed")
	}
	waiter := make(chan bool, 1)
	go func() {
		_, acquired := interactions.beginLifecycle("thr_1")
		waiter <- acquired
	}()
	deadline := time.Now().Add(time.Second)
	for {
		interactions.sequencerMu.Lock()
		sequencer := interactions.sequencers["thr_1"]
		interactions.sequencerMu.Unlock()
		sequencer.mu.Lock()
		next := sequencer.next
		sequencer.mu.Unlock()
		if next == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("waiter did not allocate a ticket")
		}
		time.Sleep(time.Millisecond)
	}
	interactions.Close()
	select {
	case acquired := <-waiter:
		if acquired {
			t.Fatal("closed waiter acquired lifecycle ticket")
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not wake ticket waiter")
	}
	release()
}

func TestCodexInteractionsNewerStatusWinsPostSelectionRace(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 18, client)
	coord.interactions = interactions
	selected := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	interactions.beforeLifecycleEmit = func(event protocol.DaemonEvent) {
		if event.Type == "session_status" && event.Status == protocol.StatusIdle {
			once.Do(func() {
				close(selected)
				<-release
			})
		}
	}
	interactions.Handle(codexServerRequest(t, `1`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","availableDecisions":["accept"]
	}`))
	asked := nextCodexEvent(t, output, "approval_request")
	_ = nextCodexEvent(t, output, "session_status")
	coord.publishProjected([]protocol.DaemonEvent{{Type: "session_status", SessionID: "thr_1", Status: protocol.StatusIdle}})
	errCh := make(chan error, 1)
	go func() { errCh <- interactions.ResolveApproval(context.Background(), "thr_1", asked.RequestID, "once") }()
	<-selected
	newerDone := make(chan struct{})
	go func() {
		coord.publishProjected([]protocol.DaemonEvent{{Type: "session_status", SessionID: "thr_1", Status: protocol.StatusError}})
		close(newerDone)
	}()
	close(release)
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	<-newerDone
	statuses := make([]string, 0, 2)
	for len(statuses) < 2 {
		event := <-output
		if event.Type == "session_status" {
			statuses = append(statuses, event.Status)
		}
	}
	if statuses[0] != protocol.StatusIdle || statuses[1] != protocol.StatusError {
		t.Fatalf("status output order=%v, want idle then newer error", statuses)
	}
}

func TestCodexInteractionsNewPendingWinsPostSelectionRace(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 48)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 19, client)
	coord.interactions = interactions
	selected := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	interactions.beforeLifecycleEmit = func(event protocol.DaemonEvent) {
		if event.Type == "session_status" && event.Status == protocol.StatusIdle {
			once.Do(func() {
				close(selected)
				<-release
			})
		}
	}
	interactions.Handle(codexServerRequest(t, `1`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","availableDecisions":["accept"]
	}`))
	first := nextCodexEvent(t, output, "approval_request")
	_ = nextCodexEvent(t, output, "session_status")
	coord.publishProjected([]protocol.DaemonEvent{{Type: "session_status", SessionID: "thr_1", Status: protocol.StatusIdle}})
	errCh := make(chan error, 1)
	go func() { errCh <- interactions.ResolveApproval(context.Background(), "thr_1", first.RequestID, "once") }()
	<-selected
	pendingDone := make(chan struct{})
	go func() {
		interactions.Handle(codexServerRequest(t, `2`, "item/fileChange/requestApproval", `{
			"threadId":"thr_1","turnId":"turn_1","itemId":"patch_2"
		}`))
		close(pendingDone)
	}()
	close(release)
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	<-pendingDone
	statuses := make([]string, 0, 2)
	secondRequestID := ""
	for len(statuses) < 2 || secondRequestID == "" {
		event := <-output
		if event.Type == "approval_request" {
			secondRequestID = event.RequestID
		}
		if event.Type == "session_status" {
			statuses = append(statuses, event.Status)
		}
	}
	if secondRequestID == first.RequestID {
		t.Fatal("new pending request reused resolved request id")
	}
	if statuses[0] != protocol.StatusIdle || statuses[1] != protocol.StatusWaitingApproval {
		t.Fatalf("status output order=%v, want idle then new waiting approval", statuses)
	}
}

func TestCodexInteractionsClosedBrokerCannotPublishAfterReplacement(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	oldBroker := newCodexInteractions(sm, 24, newInteractionCodexClient())
	newBroker := newCodexInteractions(sm, 25, newInteractionCodexClient())
	coord.interactions = oldBroker
	coord.replaceInteractionsLocked(newBroker)
	oldBroker.Handle(codexServerRequest(t, `1`, "item/fileChange/requestApproval", `{
		"threadId":"thr_old","turnId":"turn_1","itemId":"patch_old"
	}`))
	oldBroker.PublishProjectedStatus(protocol.DaemonEvent{Type: "session_status", SessionID: "thr_old", Status: protocol.StatusIdle}, func() []protocol.DaemonEvent {
		return []protocol.DaemonEvent{{Type: "session_status", SessionID: "thr_old", Status: protocol.StatusIdle}}
	})
	select {
	case event := <-output:
		t.Fatalf("closed old broker published %+v", event)
	default:
	}
	newBroker.Handle(codexServerRequest(t, `2`, "item/fileChange/requestApproval", `{
		"threadId":"thr_new","turnId":"turn_1","itemId":"patch_new"
	}`))
	if event := <-output; event.Type != "approval_request" || event.SessionID != "thr_new" {
		t.Fatalf("replacement broker event=%+v", event)
	}
}

func TestCodexCoordinatorReplaceInteractionsWithNilClosesBroker(t *testing.T) {
	coord := newCodexCoordinator(NewSessionManager(make(chan protocol.DaemonEvent, 1)))
	broker := newCodexInteractions(coord.sm, 28, newInteractionCodexClient())
	coord.interactions = broker
	coord.replaceInteractionsLocked(nil)
	if coord.interactions != nil {
		t.Fatal("interaction broker was not cleared")
	}
	if !broker.closed.Load() {
		t.Fatal("replaced interaction broker was not closed")
	}
}

func TestCodexInteractionsUserInputPreservesIDsAndRedactsSecrets(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 3, client)
	request := codexServerRequest(t, `"ask-1"`, "item/tool/requestUserInput", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"tool_1","autoResolutionMs":60000,
		"questions":[
			{"id":"mode","header":"Mode","question":"Choose","isOther":true,"options":[{"label":"A","description":"first"}]},
			{"id":"token","header":"Token","question":"Enter token","isSecret":true}
		]
	}`)
	interactions.Handle(request)
	asked := nextCodexEvent(t, output, "question_request")
	if asked.Type != "question_request" || asked.AutoResolutionMs != 60000 || len(asked.Questions) != 2 || asked.Questions[0].ID != "mode" || !asked.Questions[0].Custom || asked.Questions[1].ID != "token" || !asked.Questions[1].Secret {
		t.Fatalf("question=%+v", asked)
	}
	answers := [][]string{{"A"}, {"super-secret"}}
	if err := interactions.ResolveQuestion(context.Background(), "thr_1", asked.RequestID, answers); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	response := client.responses[len(client.responses)-1]
	client.responseMu.Unlock()
	var payload struct {
		Answers map[string]struct {
			Answers []string `json:"answers"`
		} `json:"answers"`
	}
	if err := json.Unmarshal(response.result, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Answers["mode"].Answers[0] != "A" || payload.Answers["token"].Answers[0] != "super-secret" {
		t.Fatalf("native answers=%v", payload.Answers)
	}
	resolved := nextCodexEvent(t, output, "question_resolved")
	if resolved.Type != "question_resolved" || resolved.RequestID != asked.RequestID || resolved.Answers != nil || !resolved.Redacted {
		t.Fatalf("resolved leaked secret=%+v", resolved)
	}
}

func TestSessionManagerRoutesCodexApprovalAndQuestionResponses(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 4, client)
	coord.interactions = interactions
	sm.codexProvider = &CodexRuntimeProvider{sm: sm, coordinator: coord}

	interactions.Handle(codexServerRequest(t, `10`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","startedAtMs":1,
		"availableDecisions":["cancel"]
	}`))
	approval := nextCodexEvent(t, output, "approval_request")
	if err := sm.ResolveApprovalAction("thr_1", approval.RequestID, "cancel"); err != nil {
		t.Fatal(err)
	}

	interactions.Handle(codexServerRequest(t, `11`, "item/tool/requestUserInput", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"tool_1",
		"questions":[{"id":"q","header":"Q","question":"Continue?","options":[{"label":"Yes","description":"continue"}]}]
	}`))
	question := nextCodexEvent(t, output, "question_request")
	if err := sm.RejectQuestion("thr_1", question.RequestID); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	if len(client.responses) != 2 || client.responses[0].err != nil || string(client.responses[0].result) != `{"decision":"cancel"}` || client.responses[1].err == nil || client.responses[1].err.Code != -32800 {
		t.Fatalf("responses=%+v", client.responses)
	}
}

func TestCodexInteractionsConcurrentApprovalHasOneWriter(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 64)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 8, client)
	interactions.Handle(codexServerRequest(t, `42`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","startedAtMs":1,
		"availableDecisions":["accept"]
	}`))
	asked := nextCodexEvent(t, output, "approval_request")
	const writers = 20
	var wg sync.WaitGroup
	results := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- interactions.ResolveApproval(context.Background(), "thr_1", asked.RequestID, "once")
		}()
	}
	wg.Wait()
	close(results)
	won := 0
	for err := range results {
		if err == nil {
			won++
			continue
		}
		var elsewhere *ResolvedElsewhereError
		if !errors.As(err, &elsewhere) {
			t.Fatalf("unexpected error=%v", err)
		}
	}
	client.responseMu.Lock()
	responses := len(client.responses)
	client.responseMu.Unlock()
	if won != 1 || responses != 1 {
		t.Fatalf("winners=%d responses=%d", won, responses)
	}
}

func TestCodexInteractionsMcpFormElicitationValidatesAndResponds(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 9, client)
	interactions.Handle(codexServerRequest(t, `77`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","turnId":"turn_1","serverName":"github","mode":"form",
		"message":"Configure request","requestedSchema":{"type":"object","required":["repo","retries"],"properties":{
			"repo":{"type":"string","minLength":2},
			"retries":{"type":"integer","minimum":1,"maximum":5},
			"dryRun":{"type":"boolean"},
			"regions":{"type":"array","items":{"type":"string","enum":["us","eu"]},"minItems":1}
		}}
	}`))
	asked := nextCodexEvent(t, output, "mcp_elicitation_request")
	if asked.MCPServer != "github" || asked.ElicitationMode != "form" || asked.Message != "Configure request" || len(asked.ElicitationSchema) == 0 {
		t.Fatalf("elicitation=%+v", asked)
	}
	if err := interactions.ResolveMcpElicitation(context.Background(), "thr_1", asked.RequestID, "accept", json.RawMessage(`{"repo":"x","retries":0,"regions":[]}`)); err == nil {
		t.Fatal("invalid form content was accepted")
	}
	content := json.RawMessage(`{"repo":"pocketctl","retries":2,"dryRun":true,"regions":["us"]}`)
	if err := interactions.ResolveMcpElicitation(context.Background(), "thr_1", asked.RequestID, "accept", content); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	response := client.responses[len(client.responses)-1]
	client.responseMu.Unlock()
	var payload struct {
		Action  string          `json:"action"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(response.result, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Action != "accept" || string(payload.Content) != string(content) {
		t.Fatalf("response=%s", response.result)
	}
	resolved := nextCodexEvent(t, output, "mcp_elicitation_resolved")
	if resolved.Action != "accept" || len(resolved.ElicitationContent) != 0 {
		t.Fatalf("resolved event persisted form content: %+v", resolved)
	}
}

func TestSessionManagerRoutesMcpElicitationDecline(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 10, client)
	coord.interactions = interactions
	sm.codexProvider = &CodexRuntimeProvider{sm: sm, coordinator: coord}
	interactions.Handle(codexServerRequest(t, `78`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","serverName":"github","mode":"url","message":"Authorize","elicitationId":"e1","url":"https://example.test/auth"
	}`))
	asked := nextCodexEvent(t, output, "mcp_elicitation_request")
	if asked.ElicitationMode != "url" || asked.URL != "https://example.test/auth" || asked.ElicitationID != "e1" {
		t.Fatalf("url elicitation=%+v", asked)
	}
	if err := sm.ResolveMcpElicitation("thr_1", asked.RequestID, "decline", nil); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	if len(client.responses) != 1 || string(client.responses[0].result) != `{"action":"decline"}` {
		t.Fatalf("responses=%+v", client.responses)
	}
}

func TestCodexInteractionsRejectsUnsafeMcpURLAndDoesNotClassifyElicitationAsApproval(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 12, client)
	interactions.Handle(codexServerRequest(t, `80`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","serverName":"unsafe","mode":"url","message":"Open","url":"javascript:alert(1)"
	}`))
	select {
	case event := <-output:
		t.Fatalf("unsafe URL was advertised remotely: %+v", event)
	default:
	}
	interactions.Handle(codexServerRequest(t, `81`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","serverName":"github","mode":"url","message":"Open","url":"https://example.test/auth"
	}`))
	asked := nextCodexEvent(t, output, "mcp_elicitation_request")
	if interactions.KnowsApproval("thr_1", asked.RequestID) {
		t.Fatal("MCP elicitation was classified as an approval")
	}
}

func TestCodexInteractionsLeavesUnsupportedOpenAIFormToOfficialTUI(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 2)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 11, client)
	interactions.Handle(codexServerRequest(t, `79`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","serverName":"custom","mode":"openai/form","message":"Unsupported","requestedSchema":{"providerSpecific":true}
	}`))
	select {
	case event := <-output:
		t.Fatalf("unsupported form was advertised remotely: %+v", event)
	default:
	}
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	if len(client.responses) != 0 {
		t.Fatalf("unsupported form was answered by daemon: %+v", client.responses)
	}
}
