package session

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// A final assistant text queues a title without implying turn completion.
func TestCodexTitleFlushesOnTurnCompletion(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.sessions["thr_title"] = &ProcessState{SessionID: "thr_title", Agent: "codex", Source: "terminal", Status: protocol.StatusIdle}
	coord := newCodexCoordinator(sm)
	projector := newCodexProjection(91)

	publish := func(method, params string) {
		coord.publishProjected(projector.Project(codexapp.Inbound{Method: method, Params: json.RawMessage(params)}))
	}

	// User message + final assistant text: the pair accumulates, no title yet.
	publish("turn/started", `{"threadId":"thr_title","turn":{"id":"t1","status":"inProgress","items":[]}}`)
	publish("item/completed", `{"threadId":"thr_title","turnId":"t1","item":{"id":"i1","type":"userMessage","content":[{"type":"text","text":"fixture question"}]}}`)
	publish("item/completed", `{"threadId":"thr_title","turnId":"t1","item":{"id":"i2","type":"agentMessage","text":"fixture answer"}}`)
	drainEvents(output)
	if sm.turnAllowsCompletionSideEffects("thr_title") {
		t.Fatal("in-flight turn must block completion side effects")
	}
	if sm.sessions["thr_title"].TitleUser != "fixture question" {
		t.Fatal("final text must queue a task title before turn completion")
	}

	// Completion must not lose the queued pair; maintenance emits it later.
	publish("turn/completed", `{"threadId":"thr_title","turn":{"id":"t1","status":"completed","items":[]}}`)
	drainEvents(output)
	events := sm.pendingTitleEvents(time.Now().Add(time.Minute))
	var title *protocol.DaemonEvent
	for i, ev := range events {
		if ev.Type == "generate_title_request" {
			title = &events[i]
			break
		}
	}
	if title == nil {
		t.Fatalf("no generate_title_request after turn completion: %+v", events)
	}
	if title.UserMessage != "fixture question" || title.AssistantMessage != "fixture answer" {
		t.Fatalf("title pair = %q/%q", title.UserMessage, title.AssistantMessage)
	}
}

// Interrupted tasks still have meaningful labels, without counting as success.
func TestCodexTitleQueuedForInterruptedTurn(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.sessions["thr_int"] = &ProcessState{SessionID: "thr_int", Agent: "codex", Source: "terminal", Status: protocol.StatusIdle}
	coord := newCodexCoordinator(sm)
	projector := newCodexProjection(92)

	publish := func(method, params string) {
		coord.publishProjected(projector.Project(codexapp.Inbound{Method: method, Params: json.RawMessage(params)}))
	}
	publish("turn/started", `{"threadId":"thr_int","turn":{"id":"t1","status":"inProgress","items":[]}}`)
	publish("item/completed", `{"threadId":"thr_int","turnId":"t1","item":{"id":"i1","type":"userMessage","content":[{"type":"text","text":"fixture q"}]}}`)
	publish("item/completed", `{"threadId":"thr_int","turnId":"t1","item":{"id":"i2","type":"agentMessage","text":"fixture a"}}`)
	publish("turn/completed", `{"threadId":"thr_int","turn":{"id":"t1","status":"interrupted","items":[]}}`)
	for _, ev := range drainEvents(output) {
		if ev.Type == "generate_title_request" {
			t.Fatal("interrupted turn must not generate a title")
		}
	}
	events := sm.pendingTitleEvents(time.Now().Add(time.Minute))
	if len(events) != 1 || events[0].UserMessage != "fixture q" || events[0].AssistantMessage != "fixture a" {
		t.Fatalf("interrupted task title missing: %+v", events)
	}
	if sm.turnAllowsCompletionSideEffects("thr_int") {
		t.Fatal("title must not turn interruption into completion")
	}
	// A later assistant-only turn must not replace the original task label.
	publish("turn/started", `{"threadId":"thr_int","turn":{"id":"t2","status":"inProgress","items":[]}}`)
	publish("item/completed", `{"threadId":"thr_int","turnId":"t2","item":{"id":"i3","type":"agentMessage","text":"fixture only-assistant"}}`)
	publish("turn/completed", `{"threadId":"thr_int","turn":{"id":"t2","status":"completed","items":[]}}`)
	for _, ev := range drainEvents(output) {
		if ev.Type == "generate_title_request" && ev.AssistantMessage == "fixture a" {
			t.Fatal("stale interrupted pair leaked into a later title")
		}
	}
}
