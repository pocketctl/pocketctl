package session

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexEphemeralThreadsNeverBecomeSessions(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	inbound := make(chan codexapp.Inbound, 8)
	for _, raw := range []struct{ method, params string }{
		{"thread/started", `{"thread":{"id":"helper","ephemeral":true,"cwd":"/repo","status":{"type":"idle"}}}`},
		{"thread/status/changed", `{"threadId":"helper","status":{"type":"active"}}`},
		{"turn/started", `{"threadId":"helper","turn":{"id":"turn-helper","status":"inProgress"}}`},
		{"item/agentMessage/delta", `{"threadId":"helper","turnId":"turn-helper","itemId":"i","delta":"title"}`},
		{"thread/status/changed", `{"threadId":"helper","status":{"type":"idle"}}`},
		{"thread/status/changed", `{"threadId":"helper","status":{"type":"notLoaded"}}`},
		// A real thread is allowed even before its rollout exists.
		{"thread/started", `{"thread":{"id":"real-no-rollout","ephemeral":false,"cwd":"/repo","status":{"type":"idle"}}}`},
	} {
		inbound <- codexapp.Inbound{Method: raw.method, Params: json.RawMessage(raw.params)}
	}
	close(inbound)
	coord.consumeEvents(context.Background(), inbound, newCodexProjection(1))
	// Reconnecting the event pump must not forget a known helper and create
	// a synthetic user session from its next status notification.
	reconnected := make(chan codexapp.Inbound, 1)
	reconnected <- codexapp.Inbound{Method: "thread/status/changed", Params: json.RawMessage(`{"threadId":"helper","status":{"type":"idle"}}`)}
	close(reconnected)
	coord.consumeEvents(context.Background(), reconnected, newCodexProjection(2))
	if sm.sessions["helper"] != nil {
		t.Fatal("ephemeral helper registered as user session")
	}
	if sm.sessions["real-no-rollout"] == nil {
		t.Fatal("real thread without rollout was dropped")
	}
	close(output)
	for event := range output {
		if event.SessionID == "helper" {
			t.Fatalf("helper event escaped: %+v", event)
		}
	}
}

func TestCodexManagedRediscoveryPreservesNativeState(t *testing.T) {
	for _, status := range []string{protocol.StatusIdle, protocol.StatusDisconnected, protocol.StatusRunning} {
		t.Run(status, func(t *testing.T) {
			output := make(chan protocol.DaemonEvent, 8)
			sm := NewSessionManager(output)
			activity := time.Date(2026, 9, 8, 3, 0, 0, 0, time.UTC)
			ps := &ProcessState{SessionID: "native", Agent: adapter.AgentCodex, Source: "terminal", ControlMode: protocol.ControlManaged, Status: status, LastActivityAt: activity}
			sm.sessions[ps.SessionID] = ps
			if sm.RegisterTerminalSession("native", "/repo", 0, "", protocol.StatusBusy, adapter.AgentCodex) {
				t.Fatal("started duplicate tailer")
			}
			if sm.SyncRediscoveredTerminalStatus("native", protocol.StatusBusy) {
				t.Fatal("published guessed busy state")
			}
			if ps.Status != status || !ps.LastActivityAt.Equal(activity) {
				t.Fatalf("native state overwritten: %+v", ps)
			}
			if len(output) != 0 {
				t.Fatal("rediscovery emitted status")
			}
		})
	}
}
