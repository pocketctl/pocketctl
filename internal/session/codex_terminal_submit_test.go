package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexTerminalSubmitNativeOutcome(t *testing.T) {
	for _, tc := range []struct {
		name, source, invocation string
		busy, missingACK         bool
		wantCalls                int
		wantRoot                 bool
	}{
		{"direct", "terminal", "", false, false, 1, true},
		{"workflow", "terminal", "skill:x", false, false, 0, false},
		{"incorrect source", "observer", "", false, false, 0, false},
		{"steer", "terminal", "", true, false, 0, false},
		{"lost native id", "terminal", "", false, true, 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend, rpc := nativeMemoryCodexBackend(t)
			backend.coord.runtime.PrivateStdio = false
			backend.coord.runtime.RemoteURI = "unix:///test/codex.sock"
			sm := backend.sm
			sm.sessions["thread"] = &ProcessState{SessionID: "thread", Source: tc.source, Agent: adapter.AgentCodex, ControlMode: protocol.ControlManaged, Status: protocol.StatusIdle, Backend: backend}
			backend.coord.markSubscribed("thread")
			if tc.busy {
				backend.coord.setActiveTurn("thread", "other")
			}
			if tc.missingACK {
				rpc.results["turn/startIfIdle"] = json.RawMessage(`{"turn":{}}`)
			}
			err := sm.SendMessageWithInput(context.Background(), UserMessageInput{TerminalSubmit: true, SessionID: "thread", RequestID: "req", MsgID: "msg", Content: "typed", InvocationID: tc.invocation})
			if (err == nil) != tc.wantRoot || len(rpc.calls) != tc.wantCalls {
				t.Fatalf("err=%v calls=%v", err, rpc.calls)
			}
			if tc.missingACK && !errors.Is(err, errNativeSessionCreateUncertain) {
				t.Fatalf("lost ACK: %v", err)
			}
			if tc.wantCalls == 1 && rpc.calls[0].method != "turn/startIfIdle" {
				t.Fatalf("missed atomic admission: %v", rpc.calls)
			}
			events := findEvents(drainEvents(sm.outputCh), "user_text")
			if !tc.wantRoot {
				if len(events) != 0 {
					t.Fatal("issued an input echo without acceptance")
				}
				return
			}
			if len(events) != 1 {
				t.Fatalf("input event count %d", len(events))
			}
			event := events[0]
			if event.MemorySource == nil || !event.MemorySource.LineageComplete || event.MemorySource.SourceRole != "user" || event.SourceTurnID != "native-turn" || event.TurnID != logicalCodexTurnID("thread", "native-turn") {
				t.Fatalf("invalid accepted input: %+v", event)
			}
			other := protocol.DaemonEvent{Type: "agent_text", SessionID: "thread", TurnID: event.TurnID, MemoryNative: &protocol.MemoryNativeEvent{Producer: "codex", RecordID: "other-item", RootID: event.SourceTurnID}}
			sm.stampNativeMemorySource(&other)
			if other.MemorySource != nil {
				t.Fatal("output on multi-writer turn borrowed terminal input proof")
			}
		})
	}
}

func TestCodexTerminalSubmitAcknowledgesOnlyItsInputDuringConcurrentNativeStart(t *testing.T) {
	for _, atomic := range []bool{true, false} {
		b, rpc := nativeMemoryCodexBackend(t)
		b.coord.runtime.PrivateStdio = false
		b.coord.runtime.RemoteURI = "unix:///fixture.sock"
		b.coord.hiddenContextProof.IdleOnlyContext = atomic
		ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{TerminalSubmit: true, InputMode: protocol.InputModeNewTurn, RequestID: "req", MsgID: "msg"})
		if atomic {
			rpc.errs["turn/startIfIdle"] = &codexapp.RPCError{Code: -32600, Data: json.RawMessage(`{"reason":"threadBusy"}`)}
		} else {
			// Standard Core can accept another input into a concurrently started
			// native turn and return that existing ID.
			rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"racing-native"}}`)
		}
		err := b.startTurn(ctx, "thread", "direct input", protocol.SessionConfig{})
		echoes := findEvents(drainEvents(b.sm.outputCh), "user_text")
		if len(rpc.calls) != 1 {
			t.Fatalf("duplicate native input: %d calls", len(rpc.calls))
		}
		if atomic {
			if !errors.Is(err, ErrQueuedSessionBusy) || len(echoes) != 0 {
				t.Fatalf("busy native thread acquired root: %v %+v", err, echoes)
			}
			continue
		}
		if err != nil || len(echoes) != 1 || echoes[0].SourceTurnID != "racing-native" || echoes[0].MemorySource.EventID != protocol.MemoryInputEventID("thread", "req", "msg") {
			t.Fatalf("lost native accepted input: %v %+v", err, echoes)
		}
		if b.sm.memoryLedger().bindings["thread"] != nil {
			t.Fatal("multi-writer turn retained output binding")
		}
	}
}
