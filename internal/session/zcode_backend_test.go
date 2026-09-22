package session

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/zcodeapp"
)

type fakeZcodeCall struct {
	method string
	params any
}

type fakeZcodeClient struct {
	mu        sync.Mutex
	calls     []fakeZcodeCall
	inbound   chan zcodeapp.Inbound
	done      chan struct{}
	responses []zcodeapp.RequestID
	closed    bool
}

func newFakeZcodeClient() *fakeZcodeClient {
	return &fakeZcodeClient{inbound: make(chan zcodeapp.Inbound, 16), done: make(chan struct{})}
}

func (f *fakeZcodeClient) Call(_ context.Context, method string, params any, result any) error {
	f.mu.Lock()
	f.calls = append(f.calls, fakeZcodeCall{method: method, params: params})
	f.mu.Unlock()
	switch method {
	case "runtime/capabilities":
		return json.Unmarshal([]byte(`{}`), result)
	case "session/create":
		return json.Unmarshal([]byte(`{
			"protocol":{"name":"ZCode Protocol","version":1},
			"session":{"sessionId":"zses_1","title":"New Session","status":"idle"},
			"settings":{},"projection":{},"runtime":{},"messages":[]
		}`), result)
	case "session/subscribe":
		return json.Unmarshal([]byte(`{"sessionId":"zses_1","eventSeq":0,"events":[]}`), result)
	case "session/send":
		return json.Unmarshal([]byte(`{"sessionId":"zses_1","accepted":true,"stateRevision":1}`), result)
	case "session/stop", "session/close":
		if result == nil {
			return nil
		}
		return json.Unmarshal([]byte(`{}`), result)
	default:
		return errors.New("unexpected call: " + method)
	}
}

func (f *fakeZcodeClient) Respond(id zcodeapp.RequestID, _ any, _ *zcodeapp.RPCError) error {
	f.mu.Lock()
	f.responses = append(f.responses, id)
	f.mu.Unlock()
	return nil
}

func (f *fakeZcodeClient) Inbound() <-chan zcodeapp.Inbound { return f.inbound }
func (f *fakeZcodeClient) Done() <-chan struct{}            { return f.done }
func (f *fakeZcodeClient) Err() error                       { return nil }
func (f *fakeZcodeClient) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.done)
	}
	return nil
}

func TestZcodeBackendCreatesSubscribesSendsStopsAndCloses(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	fake := newFakeZcodeClient()
	coord := newZcodeCoordinator(sm)
	coord.start = func(context.Context, string) (zcodeRuntimeClient, error) { return fake, nil }
	backend := &zcodeBackend{coord: coord, binary: "/opt/zcode"}

	sid, err := backend.Start(context.Background(), protocol.SessionConfig{Cwd: "/repo"})
	if err != nil {
		t.Fatal(err)
	}
	if sid != "zses_1" {
		t.Fatalf("session id = %q", sid)
	}
	if err := backend.Send(context.Background(), sid, "hello"); err != nil {
		t.Fatal(err)
	}
	if err := backend.Interrupt(sid); err != nil {
		t.Fatal(err)
	}
	if err := backend.Close(sid); err != nil {
		t.Fatal(err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	methods := make([]string, 0, len(fake.calls))
	for _, call := range fake.calls {
		methods = append(methods, call.method)
	}
	want := []string{"runtime/capabilities", "session/create", "session/subscribe", "session/send", "session/stop", "session/close"}
	if len(methods) != len(want) {
		t.Fatalf("methods = %#v, want %#v", methods, want)
	}
	for i := range want {
		if methods[i] != want[i] {
			t.Fatalf("methods = %#v, want %#v", methods, want)
		}
	}
}

func TestZcodeCoordinatorProjectsStreamingAndTerminalEvents(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	coord := newZcodeCoordinator(sm)
	sm.sessions["zses_1"] = &ProcessState{SessionID: "zses_1", Agent: "zcode-managed", Status: protocol.StatusIdle}

	coord.handleSessionEvent(json.RawMessage(`{"eventId":"ev1","sessionId":"zses_1","turnId":"turn_1","seq":1,"type":"turn.started","payload":{"input":"hi","turnNumber":1}}`))
	coord.handleSessionEvent(json.RawMessage(`{"eventId":"ev2","sessionId":"zses_1","turnId":"turn_1","seq":2,"type":"model.streaming","payload":{"kind":"text_delta","assistantMessageId":"msg_a","partId":"part_a","delta":"hello"}}`))
	coord.handleSessionEvent(json.RawMessage(`{"eventId":"ev3","sessionId":"zses_1","turnId":"turn_1","seq":3,"type":"model.streaming","payload":{"kind":"reasoning_delta","assistantMessageId":"msg_a","partId":"reason_a","delta":"think"}}`))
	coord.handleSessionEvent(json.RawMessage(`{"eventId":"ev4","sessionId":"zses_1","turnId":"turn_1","seq":4,"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":"call_1","toolName":"bash","input":{"command":"pwd"}}}`))
	coord.handleSessionEvent(json.RawMessage(`{"eventId":"ev5","sessionId":"zses_1","turnId":"turn_1","seq":5,"type":"tool.updated","payload":{"kind":"result","toolCallId":"call_1","toolName":"bash","duration":1,"result":{"output":"/repo"}}}`))
	coord.handleSessionEvent(json.RawMessage(`{"eventId":"ev6","sessionId":"zses_1","turnId":"turn_1","seq":6,"type":"turn.completed","payload":{"response":"hello","tokenCount":1,"toolCallCount":1,"duration":2,"resultType":"success"}}`))

	wantTypes := []string{"session_status", "agent_text", "agent_reasoning", "tool_use", "tool_result", "session_status"}
	for _, want := range wantTypes {
		select {
		case got := <-output:
			if got.Type != want {
				t.Fatalf("event type = %q, want %q (%+v)", got.Type, want, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for %s", want)
		}
	}
}

func TestZcodeCoordinatorMapsNativeTurnTerminalStates(t *testing.T) {
	tests := []struct {
		name       string
		eventType  string
		payload    string
		wantTurn   string
		wantStatus string
	}{
		{name: "success", eventType: "turn.completed", payload: `{"resultType":"success"}`, wantTurn: protocol.TurnStateCompleted, wantStatus: protocol.StatusIdle},
		{name: "cancelled", eventType: "turn.completed", payload: `{"resultType":"cancelled"}`, wantTurn: protocol.TurnStateInterrupted, wantStatus: protocol.StatusIdle},
		{name: "completed error", eventType: "turn.completed", payload: `{"resultType":"error_max_budget","response":"budget exhausted"}`, wantTurn: protocol.TurnStateFailed, wantStatus: protocol.StatusIdle},
		{name: "failed", eventType: "turn.failed", payload: `{"error":{"message":"provider failed","code":"provider_error"}}`, wantTurn: protocol.TurnStateFailed, wantStatus: protocol.StatusIdle},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			output := make(chan protocol.DaemonEvent, 16)
			sm := NewSessionManager(output)
			sm.turnMode = turnEnrichmentObserve
			sm.sessions["zses_1"] = &ProcessState{SessionID: "zses_1", Agent: "zcode-managed", Status: protocol.StatusRunning}
			if _, err := sm.reserveTurnForInitialPrompt("zses_1", "zcode-managed"); err != nil {
				t.Fatal(err)
			}
			coord := newZcodeCoordinator(sm)
			coord.handleSessionEvent(json.RawMessage(`{"eventId":"terminal","sessionId":"zses_1","turnId":"native-turn","type":"` + tt.eventType + `","payload":` + tt.payload + `}`))

			var gotTurn, gotStatus string
			for len(output) > 0 {
				event := <-output
				if event.Type == protocol.EventTypeTurnStatus {
					gotTurn = event.TurnStatus
				}
				if event.Type == "session_status" {
					gotStatus = event.Status
				}
			}
			if gotTurn != tt.wantTurn || gotStatus != tt.wantStatus {
				t.Fatalf("terminal projection = turn %q, status %q; want turn %q, status %q", gotTurn, gotStatus, tt.wantTurn, tt.wantStatus)
			}
		})
	}
}

func TestZcodeCoordinatorAnswersRuntimePreferencesAndRejectsUnknownReverseRequests(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	fake := newFakeZcodeClient()
	coord := newZcodeCoordinator(sm)
	coord.start = func(context.Context, string) (zcodeRuntimeClient, error) { return fake, nil }
	if _, err := coord.ensureStarted(context.Background(), "/opt/zcode"); err != nil {
		t.Fatal(err)
	}

	prefID := mustZcodeRequestID(t, `71`)
	unknownID := mustZcodeRequestID(t, `72`)
	fake.inbound <- zcodeapp.Inbound{ID: &prefID, Method: "session/requestRuntimePreferences", Params: json.RawMessage(`{"sessionId":"zses_1","scope":"user-execution"}`)}
	fake.inbound <- zcodeapp.Inbound{ID: &unknownID, Method: "interaction/requestPermission", Params: json.RawMessage(`{}`)}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		count := len(fake.responses)
		fake.mu.Unlock()
		if count == 2 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("reverse requests were not answered")
}

func mustZcodeRequestID(t *testing.T, raw string) zcodeapp.RequestID {
	t.Helper()
	var id zcodeapp.RequestID
	if err := json.Unmarshal([]byte(raw), &id); err != nil {
		t.Fatal(err)
	}
	return id
}
