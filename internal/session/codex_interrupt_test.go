package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func chromeConfirmation(t *testing.T, id, threadID, turnID string) codexapp.Inbound {
	t.Helper()
	return codexServerRequest(t, id, "mcpServer/elicitation/request", fmt.Sprintf(`{
		"threadId":%q,"turnId":%q,"serverName":"cua_repl","mode":"form",
		"_meta":{"codex_approval_kind":"mcp_tool_call","riskLevel":"high"},
		"message":"Allow Computer Use to use Google Chrome?",
		"requestedSchema":{"type":"object","properties":{}}
	}`, threadID, turnID))
}

func TestCodexChromeConfirmationRequiresExplicitAnswer(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	broker := newCodexInteractions(sm, 1, client)
	broker.Handle(chromeConfirmation(t, `0`, "thread", "turn"))
	event := nextCodexEvent(t, output, "mcp_elicitation_request")
	if event.ElicitationMode != "form" || !broker.HasPending("thread") || len(client.responses) != 0 {
		t.Fatal("confirmation must be visible and pending, never automatically approved")
	}
	if err := broker.ResolveMcpElicitation(context.Background(), "thread", event.RequestID, "accept", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if len(client.responses) != 1 || client.responses[0].id != "n:0" || string(client.responses[0].result) != `{"action":"accept","content":{}}` {
		t.Fatalf("response=%+v", client.responses)
	}
}

func TestCodexInvalidElicitationAlwaysReplies(t *testing.T) {
	for _, params := range []string{
		`{"threadId":"t","mode":"form","requestedSchema":{"type":"object","properties":{"secret":{"type":"object"}}}}`,
		`{"threadId":"t","mode":"url","url":"javascript:alert(1)"}`,
		`{"threadId":"t","mode":"openai/form"}`,
		`{"mode":"form"}`,
		`{`,
	} {
		output := make(chan protocol.DaemonEvent, 8)
		client := newInteractionCodexClient()
		broker := newCodexInteractions(NewSessionManager(output), 1, client)
		broker.Handle(codexServerRequest(t, `0`, "mcpServer/elicitation/request", params))
		if len(client.responses) != 1 || client.responses[0].err == nil || client.responses[0].err.Code != -32602 || len(output) != 0 {
			t.Fatalf("invalid request must receive an error without a card: %s %+v", params, client.responses)
		}
	}
}

type interruptCodexClient struct {
	*interactionCodexClient
	beforeCall func(string)
	respondErr error
}

func (c *interruptCodexClient) Call(ctx context.Context, method string, params, result any) error {
	if c.beforeCall != nil {
		c.beforeCall(method)
	}
	return c.interactionCodexClient.Call(ctx, method, params, result)
}

func (c *interruptCodexClient) Respond(id codexapp.RequestID, result any, rpcErr *codexapp.RPCError) error {
	if c.respondErr != nil {
		return c.respondErr
	}
	return c.interactionCodexClient.Respond(id, result, rpcErr)
}

func interruptFixture(t *testing.T) (*CodexAppServerBackend, *interruptCodexClient, *codexInteractions, chan protocol.DaemonEvent) {
	t.Helper()
	output := make(chan protocol.DaemonEvent, 128)
	sm := NewSessionManager(output)
	coord := newVerifiedTestCodexCoordinator(sm)
	client := &interruptCodexClient{interactionCodexClient: newInteractionCodexClient()}
	broker := newCodexInteractions(sm, 1, client)
	coord.interactions = broker
	backend := newCodexAppServerBackend(sm, coord, client, 1)
	sm.sessions["thread"] = &ProcessState{SessionID: "thread", Agent: "codex", Source: "daemon", Status: protocol.StatusRunning, Backend: backend}
	coord.setActiveTurn("thread", "turn")
	backend.reserveNativeTurn("thread", "turn")
	return backend, client, broker, output
}

func TestCodexInterruptCancelsConfirmationBeforeRPC(t *testing.T) {
	b, client, broker, output := interruptFixture(t)
	broker.Handle(chromeConfirmation(t, `0`, "thread", "turn"))
	broker.Handle(chromeConfirmation(t, `1`, "other", "turn"))
	client.beforeCall = func(method string) {
		if method == "turn/interrupt" {
			if broker.HasPending("thread") || len(client.responses) != 1 || string(client.responses[0].result) != `{"action":"cancel"}` {
				t.Fatal("interrupt was sent before cancelling native confirmation")
			}
		}
	}
	client.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"turn","status":"interrupted"}]}`)
	if err := b.Interrupt("thread"); err != nil {
		t.Fatal(err)
	}
	if !broker.HasPending("other") {
		t.Fatal("cancelled another session's interaction")
	}
	if _, active := b.sm.ActiveTurn("thread"); active || b.coord.currentTurn("thread") != "" || b.sm.sessions["thread"].Status != protocol.StatusIdle {
		t.Fatal("confirmed native completion did not converge")
	}
	found := false
	for _, event := range drainEvents(output) {
		if event.Type == "mcp_elicitation_resolved" && event.SessionID == "thread" && event.Action == "cancel" {
			found = true
		}
	}
	if !found {
		t.Fatal("remote confirmation card was not resolved")
	}
}

func TestCodexInterruptCancelsLateRequestsButNotNextTurn(t *testing.T) {
	b, client, broker, output := interruptFixture(t)
	if err := broker.CancelTurn("thread", "turn"); err != nil {
		t.Fatal(err)
	}
	b.sm.sessions["thread"].Status = protocol.StatusIdle
	broker.Handle(chromeConfirmation(t, `0`, "thread", "turn"))
	broker.Handle(chromeConfirmation(t, `0`, "thread", "turn")) // duplicate replay
	if len(client.responses) != 1 || broker.HasPending("thread") || b.sm.sessions["thread"].Status != protocol.StatusIdle {
		t.Fatal("late/replayed cancelled request was not handled exactly once")
	}
	for _, event := range drainEvents(output) {
		if event.Type == "mcp_elicitation_request" {
			t.Fatal("late request reopened the card")
		}
	}
	broker.Handle(chromeConfirmation(t, `1`, "thread", "next"))
	if !broker.HasPending("thread") || len(client.responses) != 1 {
		t.Fatal("next turn was affected by previous cancellation")
	}
}

func TestCodexInterruptCancellationWriteFailureCanRetry(t *testing.T) {
	_, client, broker, _ := interruptFixture(t)
	broker.Handle(chromeConfirmation(t, `0`, "thread", "turn"))
	client.respondErr = errors.New("write failed")
	if err := broker.CancelTurn("thread", "turn"); err == nil || !broker.HasPending("thread") {
		t.Fatal("failed cancellation was lost")
	}
	client.respondErr = nil
	if err := broker.CancelTurn("thread", "turn"); err != nil || broker.HasPending("thread") || len(client.responses) != 1 {
		t.Fatal("failed cancellation was not retryable")
	}
}

func TestCodexInterruptTimeoutRequiresExactNativeTerminal(t *testing.T) {
	for _, tt := range []struct {
		name, response string
		done           bool
	}{
		{"lost_ack", `{"data":[{"id":"turn","status":"interrupted"}]}`, true},
		{"still_running", `{"data":[{"id":"turn","status":"inProgress"}]}`, false},
		{"other_turn", `{"data":[{"id":"other","status":"interrupted"}]}`, false},
		{"unknown", `{"data":[]}`, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			b, client, _, _ := interruptFixture(t)
			client.errs["turn/interrupt"] = context.DeadlineExceeded
			client.results["thread/turns/list"] = json.RawMessage(tt.response)
			err := b.Interrupt("thread")
			if (err == nil) != tt.done {
				t.Fatalf("err=%v done=%v", err, tt.done)
			}
			rec, active := b.sm.ActiveTurn("thread")
			if tt.done && active || !tt.done && (!active || rec.State != protocol.TurnStateInterruptRequested || b.sm.sessions["thread"].Status == protocol.StatusIdle) {
				t.Fatalf("incorrect terminal state: active=%v record=%+v", active, rec)
			}
		})
	}
}

func TestCodexInterruptUsesReconnectedClient(t *testing.T) {
	b, client, _, _ := interruptFixture(t)
	old := newFakeCodexRuntimeClient()
	old.errs["turn/interrupt"] = codexapp.ErrClosed
	b.client = old
	b.coord.runtime = &codexAppServerRuntime{Client: client}
	b.coord.generation = 1
	if err := b.Interrupt("thread"); err != nil {
		t.Fatal(err)
	}
	if len(old.calls) != 0 {
		t.Fatal("used obsolete backend connection")
	}
	client.lastCall(t, "turn/interrupt")
}

func TestCodexInterruptCancelsAllInteractionKindsWithoutGranting(t *testing.T) {
	_, client, broker, _ := interruptFixture(t)
	for i, request := range []struct{ method, extra string }{
		{"item/commandExecution/requestApproval", `"itemId":"cmd","availableDecisions":["accept","cancel"]`},
		{"item/fileChange/requestApproval", `"itemId":"file","availableDecisions":["accept","decline"]`},
		{"item/permissions/requestApproval", `"itemId":"perm","permissions":{"network":{"enabled":true}}`},
		{"item/tool/requestUserInput", `"itemId":"question","questions":[{"id":"q","header":"Q","question":"Continue?","options":[]}]`},
	} {
		broker.Handle(codexServerRequest(t, fmt.Sprint(i+1), request.method, `{"threadId":"thread","turnId":"turn",`+request.extra+`}`))
	}
	if err := broker.CancelTurn("thread", "turn"); err != nil {
		t.Fatal(err)
	}
	if len(client.responses) != 4 || broker.HasPending("thread") {
		t.Fatalf("pending waits left behind: replies=%+v", client.responses)
	}
	want := map[string]string{"n:1": `{"decision":"cancel"}`, "n:2": `{"decision":"decline"}`, "n:3": `{"permissions":{},"scope":"turn"}`}
	for _, response := range client.responses {
		if response.id == "n:4" {
			if response.err == nil || response.err.Code != -32800 {
				t.Fatalf("question not cancelled: %+v", response)
			}
		} else if string(response.result) != want[response.id] {
			t.Fatalf("approval granted or invalid cancellation: %+v", response)
		}
	}
}

func TestCodexInterruptAndUIAnswerRespondOnlyOnce(t *testing.T) {
	_, client, broker, output := interruptFixture(t)
	broker.Handle(chromeConfirmation(t, `0`, "thread", "turn"))
	request := nextCodexEvent(t, output, "mcp_elicitation_request")
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := broker.CancelTurn("thread", "turn"); err != nil {
			t.Error(err)
		}
	}()
	go func() {
		defer wg.Done()
		err := broker.ResolveMcpElicitation(context.Background(), "thread", request.RequestID, "decline", nil)
		var resolved *ResolvedElsewhereError
		if err != nil && !errors.As(err, &resolved) {
			t.Error(err)
		}
	}()
	wg.Wait()
	if len(client.responses) != 1 || broker.HasPending("thread") {
		t.Fatalf("concurrent replies=%+v", client.responses)
	}
}

func TestCodexInterruptOldConfirmationDoesNotIdleNewTurn(t *testing.T) {
	b, client, _, _ := interruptFixture(t)
	client.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"turn","status":"interrupted"}]}`)
	client.beforeCall = func(method string) {
		if method == "thread/turns/list" {
			b.coord.projectLive(newCodexProjection(1), codexNotification("turn/started", `{"threadId":"thread","turn":{"id":"new","status":"inProgress"}}`))
		}
	}
	if err := b.Interrupt("thread"); err != nil {
		t.Fatal(err)
	}
	if b.coord.currentTurn("thread") != "new" || b.sm.sessions["thread"].Status != protocol.StatusRunning {
		t.Fatal("old completion idled the new turn")
	}
}

func TestCodexInterruptStillAttemptsRPCWhenCancellationWriteFails(t *testing.T) {
	b, client, broker, _ := interruptFixture(t)
	broker.Handle(chromeConfirmation(t, `0`, "thread", "turn"))
	client.respondErr = errors.New("write failed")
	if err := b.Interrupt("thread"); err == nil {
		t.Fatal("lost cancellation error")
	}
	client.lastCall(t, "turn/interrupt")
	if !broker.HasPending("thread") {
		t.Fatal("lost retryable confirmation")
	}
}
