package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// Native status mapping: running/completed/cancelled/failed project onto the
// frozen vocabulary with the native id preserved as source_turn_id.
func TestCodexNativeTurnStatusMapping(t *testing.T) {
	cases := []struct {
		native string
		want   string
	}{
		{"inProgress", protocol.TurnStateRunning},
		{"completed", protocol.TurnStateCompleted},
		{"interrupted", protocol.TurnStateInterrupted},
		{"cancelled", protocol.TurnStateInterrupted},
		{"failed", protocol.TurnStateFailed},
	}
	for i, c := range cases {
		p := newCodexProjection(uint64(i + 1))
		method := "turn/completed"
		if c.native == "inProgress" {
			method = "turn/started"
		}
		events := p.Project(codexNotification(method,
			`{"threadId":"thr_m","turn":{"id":"turn_m","status":"`+c.native+`","items":[]}}`))
		if len(events) == 0 || events[0].Type != protocol.EventTypeTurnStatus {
			t.Fatalf("native %s: events=%+v", c.native, events)
		}
		ev := events[0]
		if ev.TurnStatus != c.want {
			t.Errorf("native %s -> %s, want %s", c.native, ev.TurnStatus, c.want)
		}
		if ev.SourceTurnID != "turn_m" || ev.TurnID != logicalCodexTurnID("thr_m", "turn_m") {
			t.Errorf("native %s identity: %+v", c.native, ev)
		}
		if ev.TurnOrigin != protocol.TurnOriginNative || ev.TurnConfidence != protocol.TurnConfidenceNative {
			t.Errorf("native %s origin/confidence: %s/%s", c.native, ev.TurnOrigin, ev.TurnConfidence)
		}
		if ev.EventID != turn.StatusEventID(ev.TurnID, c.want) {
			t.Errorf("native %s event id not forced-stable", c.native)
		}
	}
}

// The turn id must be identical across live, replay and history hydration —
// one derivation everywhere.
func TestCodexTurnIDStableAcrossLiveReplayAndHistory(t *testing.T) {
	p := newCodexProjection(41)
	live := p.Project(codexNotification("turn/started",
		`{"threadId":"thr_s","turn":{"id":"turn_s","status":"inProgress","items":[]}}`))
	// Same notification replayed through a fresh projector (reconnect path).
	p2 := newCodexProjection(41)
	replay := p2.Project(codexNotification("turn/started",
		`{"threadId":"thr_s","turn":{"id":"turn_s","status":"inProgress","items":[]}}`))
	if live[0].TurnID != replay[0].TurnID || live[0].EventID != replay[0].EventID {
		t.Fatalf("live/replay ids drifted: %+v vs %+v", live[0], replay[0])
	}
	// Historical hydration emits no lifecycle events at all.
	p3 := newCodexProjection(41)
	if got := p3.ProjectHistorical(codexNotification("turn/started",
		`{"threadId":"thr_s","turn":{"id":"turn_s","status":"inProgress","items":[]}}`)); len(got) != 0 {
		t.Fatalf("historical turn/started must not emit: %+v", got)
	}
	// Content items still stamp the same identity in both modes.
	liveItem := p.Project(codexNotification("item/completed",
		`{"threadId":"thr_s","turnId":"turn_s","item":{"id":"i1","type":"agentMessage","text":"hello"}}`))
	histItem := p2.ProjectHistorical(codexNotification("item/completed",
		`{"threadId":"thr_s","turnId":"turn_s","item":{"id":"i1","type":"agentMessage","text":"hello"}}`))
	if len(liveItem) == 0 || len(histItem) == 0 {
		t.Fatalf("items missing: live=%d hist=%d", len(liveItem), len(histItem))
	}
	if liveItem[len(liveItem)-1].TurnID != live[0].TurnID || histItem[len(histItem)-1].TurnID != live[0].TurnID {
		t.Fatal("content items must carry the same logical turn id")
	}
}

// A late completion for an old turn must never close the new active turn
// (stale facts are dropped, not guessed).
func TestCodexLateCompletionDoesNotCloseNewTurn(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	projector := newCodexProjection(51)

	coord.publishProjected(projector.Project(codexNotification("turn/started",
		`{"threadId":"thr_l","turn":{"id":"old_turn","status":"inProgress","items":[]}}`)))
	coord.publishProjected(projector.Project(codexNotification("turn/completed",
		`{"threadId":"thr_l","turn":{"id":"old_turn","status":"completed","items":[]}}`)))
	coord.publishProjected(projector.Project(codexNotification("turn/started",
		`{"threadId":"thr_l","turn":{"id":"new_turn","status":"inProgress","items":[]}}`)))
	// Late completion for the old turn arriving after the new turn started.
	coord.publishProjected(projector.Project(codexNotification("turn/completed",
		`{"threadId":"thr_l","turn":{"id":"old_turn","status":"completed","items":[]}}`)))

	active, ok := sm.ActiveTurn("thr_l")
	if !ok || active.SourceTurnID != "new_turn" {
		t.Fatalf("active turn = %+v ok=%v, want new_turn still running", active, ok)
	}
	// Exactly one completed emission for the old turn.
	completed := 0
	for {
		select {
		case ev := <-output:
			if ev.Type == protocol.EventTypeTurnStatus && ev.TurnStatus == protocol.TurnStateCompleted {
				completed++
			}
		default:
			goto done
		}
	}
done:
	if completed != 1 {
		t.Errorf("old-turn completed emitted %d times, want 1", completed)
	}
}

// Interrupt uses the current native id; without an active turn it fails typed
// and non-retryable instead of guessing the most recent one.
func TestCodexBackendInterruptRequiresActiveTurn(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	coord := newCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)

	if err := backend.Interrupt("thr_none"); !errors.Is(err, ErrNoActiveCodexTurn) {
		t.Fatalf("err = %v, want ErrNoActiveCodexTurn", err)
	}

	// With an active turn the RPC carries the current native id and the
	// registry moves to interrupt_requested.
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"turn_i","status":"inProgress","items":[]}}`)
	sm.sessions["thr_i"] = &ProcessState{SessionID: "thr_i", Agent: "codex", Source: "daemon", Status: protocol.StatusIdle, Backend: backend, ControlMode: protocol.ControlManaged}
	if err := backend.Send(context.Background(), "thr_i", "hello"); err != nil {
		t.Fatal(err)
	}
	if active, ok := sm.ActiveTurn("thr_i"); !ok || active.SourceTurnID != "turn_i" {
		t.Fatalf("native turn not reserved: %+v", active)
	}
	if err := backend.Interrupt("thr_i"); err != nil {
		t.Fatal(err)
	}
	call := rpc.lastCall(t, "turn/interrupt")
	if string(call.params) != `{"threadId":"thr_i","turnId":"turn_i"}` {
		t.Fatalf("interrupt params = %s", call.params)
	}
	active, _ := sm.ActiveTurn("thr_i")
	if active.State != protocol.TurnStateInterruptRequested {
		t.Fatalf("state = %s, want interrupt_requested", active.State)
	}
}

// turn/start reserves the native-anchored turn before native content events
// arrive; steer stays in the same turn.
func TestCodexBackendReserveAndSteer(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	coord := newCodexCoordinator(sm)
	rpc := newFakeCodexRuntimeClient()
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"turn_r","status":"inProgress","items":[]}}`)
	backend := newCodexAppServerBackend(sm, coord, rpc, 1)

	if err := backend.Send(context.Background(), "thr_r", "first"); err != nil {
		t.Fatal(err)
	}
	rec, ok := sm.ActiveTurn("thr_r")
	if !ok || rec.TurnID != logicalCodexTurnID("thr_r", "turn_r") || rec.State != protocol.TurnStateRunning {
		t.Fatalf("reserve = %+v", rec)
	}

	// Steer path: activeTurn is set, so Send goes through turn/steer and the
	// input binds to the same turn.
	if err := backend.Send(context.Background(), "thr_r", "and also"); err != nil {
		t.Fatal(err)
	}
	rpc.lastCall(t, "turn/steer")
	rec2, _ := sm.ActiveTurn("thr_r")
	if rec2.TurnID != rec.TurnID {
		t.Fatalf("steer changed turn id: %q -> %q", rec.TurnID, rec2.TurnID)
	}
}

// Child threads keep their own registry key: the same native turn id text in
// two threads derives different logical ids, and a child completion never
// touches the root session or root turn.
func TestCodexChildTurnIsolation(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	projector := newCodexProjection(61)

	coord.publishProjected(projector.Project(codexNotification("turn/started",
		`{"threadId":"thr_root","turn":{"id":"turn_c","status":"inProgress","items":[]}}`)))
	coord.publishProjected(projector.Project(codexNotification("turn/started",
		`{"threadId":"thr_child","turn":{"id":"turn_c","status":"inProgress","items":[]}}`)))

	rootTurn, _ := sm.ActiveTurn("thr_root")
	childTurn, _ := sm.ActiveTurn("thr_child")
	if rootTurn.TurnID == childTurn.TurnID {
		t.Fatal("same native id in different threads must derive different logical ids")
	}

	// Child completion closes only the child turn.
	coord.publishProjected(projector.Project(codexNotification("turn/completed",
		`{"threadId":"thr_child","turn":{"id":"turn_c","status":"completed","items":[]}}`)))
	if _, stillActive := sm.ActiveTurn("thr_child"); stillActive {
		t.Fatal("child turn must be terminal")
	}
	if root, ok := sm.ActiveTurn("thr_root"); !ok || root.TurnID != rootTurn.TurnID {
		t.Fatal("root turn must be untouched by child completion")
	}
}

// Duplicate native notifications (reconnect replay of the same turn/started)
// publish exactly one turn_status event but keep the registry consistent.
func TestCodexDuplicateNotificationSingleEmission(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	coord := newCodexCoordinator(sm)
	projector := newCodexProjection(71)
	notification := codexapp.Inbound{Method: "turn/started", Params: json.RawMessage(
		`{"threadId":"thr_d","turn":{"id":"turn_d","status":"inProgress","items":[]}}`)}

	coord.publishProjected(projector.Project(notification))
	coord.publishProjected(projector.Project(notification)) // reconnect replay

	seen := 0
	for {
		select {
		case ev := <-output:
			if ev.Type == protocol.EventTypeTurnStatus && ev.TurnStatus == protocol.TurnStateRunning {
				seen++
			}
		default:
			goto done
		}
	}
done:
	if seen != 1 {
		t.Fatalf("running turn_status emitted %d times, want 1", seen)
	}
	if rec, ok := sm.ActiveTurn("thr_d"); !ok || rec.State != protocol.TurnStateRunning {
		t.Fatalf("registry = %+v", rec)
	}
}
