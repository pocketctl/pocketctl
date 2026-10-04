package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/dshapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Optional integration test against a real, isolated DSH Host, useful before
// the full Docker/Relay acceptance. Credentials stay out of test output.
func TestDSHNativeHost(t *testing.T) {
	raw := os.Getenv("POCKETCTL_DSH_TEST_URL")
	if raw == "" {
		t.Skip("requires isolated DSH Host")
	}
	t.Setenv("POCKETCTL_DSH_URL", raw)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, err := dshapp.Connect(ctx, dshapp.Config{URL: raw})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	out := make(chan protocol.DaemonEvent, 1024)
	sm := NewSessionManager(out)
	defer sm.ShutdownDSH()
	cwd := t.TempDir()
	policy, err := NewCwdPolicy([]string{cwd})
	if err != nil {
		t.Fatal(err)
	}
	sm.SetCwdPolicy(policy)
	var native struct {
		SessionID string `json:"sessionId"`
	}
	if err := client.Call(ctx, "session/create", dshapp.Request(map[string]any{"cwd": cwd}), &native); err != nil {
		t.Fatal(err)
	}
	sm.StartDSHDiscovery()
	wait := func(match func(protocol.DaemonEvent) bool) protocol.DaemonEvent {
		t.Helper()
		for {
			select {
			case e := <-out:
				if match(e) {
					return e
				}
			case <-ctx.Done():
				t.Fatal("native DSH integration timeout")
				return protocol.DaemonEvent{}
			}
		}
	}
	wait(func(e protocol.DaemonEvent) bool {
		return e.Type == "session_discovered" && e.SessionID == native.SessionID
	})
	if err := client.Call(ctx, "session/prompt", dshapp.Request(map[string]any{"sessionId": native.SessionID, "requestId": "native-input", "mode": "queue", "content": []any{map[string]any{"type": "text", "text": "NATIVE_GO_TEST"}}}), nil); err != nil {
		t.Fatal(err)
	}
	wait(func(e protocol.DaemonEvent) bool { return e.Type == "agent_text" && e.Final })
	// Reverse interactions traverse the native Host's global event stream.
	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: native.SessionID, Content: "DSH_APPROVAL_GO", RequestID: "approval-input"}); err != nil {
		t.Fatal(err)
	}
	approval := wait(func(e protocol.DaemonEvent) bool { return e.Type == "approval_request" })
	if err := sm.ResolveApprovalAction(native.SessionID, approval.RequestID, "reject"); err != nil {
		t.Fatal(err)
	}
	wait(func(e protocol.DaemonEvent) bool {
		return e.Type == "approval_resolved" && e.RequestID == approval.RequestID
	})
	wait(func(e protocol.DaemonEvent) bool { return e.Type == "tool_result" })
	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: native.SessionID, Content: "DSH_QUESTION_GO", RequestID: "question-input"}); err != nil {
		t.Fatal(err)
	}
	question := wait(func(e protocol.DaemonEvent) bool { return e.Type == "question_request" })
	if err := sm.ResolveQuestion(native.SessionID, question.RequestID, [][]string{{"Beta"}}); err != nil {
		t.Fatal(err)
	}
	wait(func(e protocol.DaemonEvent) bool {
		return e.Type == "question_resolved" && e.RequestID == question.RequestID
	})
	wait(func(e protocol.DaemonEvent) bool {
		return e.Type == "session_status" && e.Status == protocol.StatusIdle
	})
	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: native.SessionID, Content: "REMOTE_GO_TEST", RequestID: "remote-input", MsgID: "remote-msg"}); err != nil {
		t.Fatal(err)
	}
	user := wait(func(e protocol.DaemonEvent) bool { return e.Type == "user_text" && e.Text == "REMOTE_GO_TEST" })
	if user.MsgID != "remote-msg" {
		t.Fatal("native echo lost remote correlation")
	}
	wait(func(e protocol.DaemonEvent) bool { return e.Type == "agent_text" && e.Final })
}

func TestDSHCreateAuthorizesBeforeHostConnection(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) {
		t.Fatal("DSH must never use the subprocess fallback")
		return "", nil
	}
	_, err := sm.CreateSession(context.Background(), protocol.SessionConfig{Agent: adapter.AgentDSH, Cwd: t.TempDir()})
	if !errors.Is(err, ErrCwdNotAuthorized) {
		t.Fatalf("got %v", err)
	}
}

func TestDSHTranscriptIdentityAndHiddenContext(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(out)
	c := sm.ensureDSH()
	defer sm.ShutdownDSH()
	sm.sessions["native"] = &ProcessState{SessionID: "native", Agent: adapter.AgentDSH, Backend: &dshBackend{coord: c}, ControlMode: protocol.ControlManaged}
	current := 2
	c.durable("native", dshEvent{Type: "user/message", Seq: 10, Data: json.RawMessage(`{"id":"hidden","content":[{"type":"text","text":"private runtime context"}],"source":{"kind":"runtime-context"}}`)}, true, &current)
	if len(out) != 0 {
		t.Fatal("hidden context was published")
	}
	c.correlations["request"] = userMessageCorrelation{RequestID: "request", MsgID: "client-message"}
	c.durable("native", dshEvent{Type: "user/message", Seq: 11, Data: json.RawMessage(`{"id":"user","content":[{"type":"text","text":"hello"}],"source":{"kind":"user","rpcId":"request"}}`)}, false, &current)
	user := <-out
	if user.Type != "user_text" || user.MsgID != "client-message" || user.TurnID != dshTurnID("native", 2) {
		t.Fatalf("wrong user projection: %#v", user)
	}
	record := dshEvent{Type: "assistant/message", Seq: 14, Data: json.RawMessage(`{"turn":2,"step":1,"message":{"id":"assistant","content":[{"type":"reasoning","text":"think"},{"type":"text","text":"你好"}]}}`)}
	c.durable("native", record, false, &current)
	reasoning, live := <-out, <-out
	c.durable("native", record, true, &current)
	if len(out) != 0 {
		t.Fatal("native reconnect duplicated durable output")
	}
	c.mu.Lock()
	delete(c.seenEvents, "native")
	c.mu.Unlock()
	c.durable("native", record, true, &current)
	<-out
	replay := <-out
	if reasoning.Type != "agent_reasoning" || live.StreamID != dshStreamID("native", 2, 1, 1) || live.TotalBytes != 6 || !live.Final || !live.Streaming || live.ContentHash == "" {
		t.Fatalf("invalid streaming final: %#v", live)
	}
	if live.EventID != replay.EventID || live.StreamID != replay.StreamID {
		t.Fatal("reconnect changed durable identity")
	}
}

func TestDSHApprovalSharesNativeIdentityAndClearsOnPeerDecision(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(out)
	c := sm.ensureDSH()
	defer sm.ShutdownDSH()
	sm.sessions["native"] = &ProcessState{SessionID: "native", Agent: adapter.AgentDSH, Backend: &dshBackend{coord: c}, ControlMode: protocol.ControlManaged}
	c.hostEvent(json.RawMessage(`{"type":"waterfall","event":"approval/request","eventId":"shared-id","agentId":"native","request":{"toolName":"bash","callId":"call","reason":"confirm command"}}`))
	var card protocol.DaemonEvent
	for len(out) > 0 {
		e := <-out
		if e.Type == "approval_request" {
			card = e
		}
	}
	if card.RequestID != "shared-id" || len(c.pending) != 1 {
		t.Fatal("native pending identity was lost")
	}
	if len(card.AvailableDecisions) != 2 || card.AvailableDecisions[0] != "accept" || card.AvailableDecisions[1] != "decline" {
		t.Fatal("approval decisions must use the shared client wire vocabulary")
	}
	c.hostEvent(json.RawMessage(`{"type":"cancel","eventId":"shared-id"}`))
	if len(c.pending) != 0 {
		t.Fatal("peer decision remained pending")
	}
	e := <-out
	if e.Type != "approval_resolved" || e.RequestID != "shared-id" || e.Reason != "resolved_elsewhere" {
		t.Fatalf("wrong withdrawal: %#v", e)
	}
}

func TestDSHClientToolAndQuestionContracts(t *testing.T) {
	out := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(out)
	c := sm.ensureDSH()
	defer sm.ShutdownDSH()
	sm.sessions["native"] = &ProcessState{SessionID: "native", Agent: adapter.AgentDSH, Backend: &dshBackend{coord: c}, ControlMode: protocol.ControlManaged}
	current := 1
	c.durable("native", dshEvent{Type: "tool/call", Seq: 1, Data: json.RawMessage(`{"turn":1,"step":1,"callId":"bash-call","name":"bash","arguments":"{\"command\":\"printf marker\"}"}`)}, false, &current)
	call := <-out
	if call.Type != "tool_call" || call.CallID != "bash-call" || call.Tool != "bash" || !json.Valid(call.Input) {
		t.Fatalf("native tool must project to a client tool card: %#v", call)
	}
	c.hostEvent(json.RawMessage(`{"type":"waterfall","event":"user-questions/request","eventId":"question","agentId":"native","request":{"wait":{"callId":"question-call"},"questions":[{"id":"choice","question":"Choose","options":[{"label":"Alpha"},{"label":"Beta"}]}]}}`))
	status, question := <-out, <-out
	if status.Status != protocol.StatusWaitingQuestion || question.Type != "question_request" {
		t.Fatalf("question must keep the session waiting: %#v %#v", status, question)
	}
	c.startTurn("native", 1)
	for len(out) > 0 {
		e := <-out
		if e.Type == "session_status" && e.Status != protocol.StatusWaitingQuestion {
			t.Fatalf("late active snapshot overwrote pending question status: %#v", e)
		}
	}
}
