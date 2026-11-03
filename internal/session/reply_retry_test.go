package session

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestReplyRetryEchoPersistsAssociationAndRejectsWhileBusy(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	input := UserMessageInput{SessionID: "turn-sess", Content: "same question", RequestID: "retry-1", MsgID: "retry-1", RetryOfTurnID: "original-turn"}
	if err := sm.SendMessageWithInput(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	echoes := findEvents(drainEvents(sm.outputCh), "user_text")
	if len(echoes) != 1 || echoes[0].RetryOfTurnID != "original-turn" || echoes[0].TurnID == "" || echoes[0].TurnID == "original-turn" {
		t.Fatalf("echoes=%+v", echoes)
	}
	raw, err := json.Marshal(echoes[0])
	if err != nil {
		t.Fatal(err)
	}
	var replay protocol.DaemonEvent
	if err = json.Unmarshal(raw, &replay); err != nil || replay.RetryOfTurnID != "original-turn" {
		t.Fatalf("replay=%+v %v", replay, err)
	}
	input.RequestID = "retry-2"
	if err := sm.SendMessageWithInput(context.Background(), input); err == nil {
		t.Fatal("busy retry accepted as steer")
	}
	if len(findEvents(drainEvents(sm.outputCh), "user_text")) != 0 {
		t.Fatal("rejected retry emitted question")
	}
}

func TestCodexReplyRetryEchoCarriesExactNativeTurn(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native-retry"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{MsgID: "retry-request", RetryOfTurnID: "original-turn"})
	if err := b.startTurn(ctx, "thread", "same question", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	echoes := findEvents(drainEvents(b.sm.outputCh), "user_text")
	if len(echoes) != 1 || echoes[0].TurnID != logicalCodexTurnID("thread", "native-retry") || echoes[0].RetryOfTurnID != "original-turn" || echoes[0].MsgID != "retry-request" {
		t.Fatalf("echoes=%+v", echoes)
	}
}
