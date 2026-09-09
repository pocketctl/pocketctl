package session

import (
	"encoding/json"
	"fmt"
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
	coord := newVerifiedTestCodexCoordinator(sm)
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

func TestCodexTitleLateSubscriptionAndSupersededTurn(t *testing.T) {
	for _, historical := range []bool{false, true} {
		t.Run(fmt.Sprint(historical), func(t *testing.T) {
			output := make(chan protocol.DaemonEvent, 64)
			sm := NewSessionManager(output)
			sm.sessions["late"] = &ProcessState{SessionID: "late", Agent: "codex", Source: "terminal", Status: protocol.StatusRunning}
			coord := newVerifiedTestCodexCoordinator(sm)
			p := newCodexProjection(1)
			publish := func(method, body string) { coord.publishProjected(p.Project(codexNotification(method, body))) }
			user := `{"threadId":"late","turnId":"t1","item":{"id":"u1","type":"userMessage","content":[{"type":"text","text":"question"}]}}`
			if historical {
				coord.publishProjected(p.ProjectHistorical(codexNotification("item/completed", user)))
			}
			publish("item/completed", user)
			assistant := `{"threadId":"late","turnId":"t1","item":{"id":"a1","type":"agentMessage","text":"answer"}}`
			if historical {
				coord.publishProjected(p.ProjectHistorical(codexNotification("item/completed", assistant)))
			} else {
				publish("item/completed", assistant)
			}
			publish("turn/completed", `{"threadId":"late","turn":{"id":"t1","status":"completed"}}`)
			count := 0
			drainEvents(output)
			for _, ev := range sm.pendingTitleEvents(time.Now().Add(time.Minute)) {
				if ev.Type == "generate_title_request" {
					count++
				}
			}
			if count != 1 {
				t.Fatalf("late subscription title requests = %d", count)
			}
			publish("turn/started", `{"threadId":"late","turn":{"id":"t2","status":"inProgress"}}`)
			publish("turn/started", `{"threadId":"late","turn":{"id":"t3","status":"inProgress"}}`)
			active, ok := sm.ActiveTurn("late")
			if !ok || active.SourceTurnID != "t3" {
				t.Fatalf("new turn blocked: %+v", active)
			}
			publish("turn/completed", `{"threadId":"late","turn":{"id":"t2","status":"interrupted"}}`)
			active, ok = sm.ActiveTurn("late")
			if !ok || active.SourceTurnID != "t3" {
				t.Fatalf("late completion closed new turn: %+v", active)
			}
			publish("item/completed", `{"threadId":"late","turnId":"t3","item":{"id":"u3","type":"userMessage","content":[{"type":"text","text":"new question"}]}}`)
			publish("item/completed", `{"threadId":"late","turnId":"t3","item":{"id":"a3","type":"agentMessage","text":"new answer"}}`)
			publish("turn/completed", `{"threadId":"late","turn":{"id":"t3","status":"completed"}}`)
			count = 0
			drainEvents(output)
			// Preserve the migrated repository's first-task title and retry
			// backoff; a later turn must not replace the original title pair.
			for _, ev := range sm.pendingTitleEvents(sm.sessions["late"].TitleNextAttempt) {
				if ev.Type == "generate_title_request" {
					count++
					if ev.UserMessage != "question" {
						t.Fatal("later turn replaced original task title")
					}
				}
			}
			if count != 1 {
				t.Fatalf("next title requests = %d", count)
			}
		})
	}
}

// Interrupted tasks still have meaningful labels, without counting as success.
func TestCodexTitleQueuedForInterruptedTurn(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	sm.sessions["thr_int"] = &ProcessState{SessionID: "thr_int", Agent: "codex", Source: "terminal", Status: protocol.StatusIdle}
	coord := newVerifiedTestCodexCoordinator(sm)
	projector := newCodexProjection(92)

	publish := func(method, params string) {
		coord.publishProjected(projector.Project(codexapp.Inbound{Method: method, Params: json.RawMessage(params)}))
	}
	publish("turn/started", `{"threadId":"thr_int","turn":{"id":"t1","status":"inProgress","items":[]}}`)
	publish("item/completed", `{"threadId":"thr_int","turnId":"t1","item":{"id":"i1","type":"userMessage","content":[{"type":"text","text":"fixture q"}]}}`)
	publish("item/completed", `{"threadId":"thr_int","turnId":"t1","item":{"id":"i2","type":"agentMessage","text":"fixture a"}}`)
	publish("turn/completed", `{"threadId":"thr_int","turn":{"id":"t1","status":"interrupted","items":[]}}`)
	if active, ok := sm.ActiveTurn("thr_int"); ok {
		t.Fatalf("native interrupted turn still active: %+v", active)
	}
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
