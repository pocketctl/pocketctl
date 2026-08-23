package turn

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func newTestRegistry(t *testing.T) *Registry {
	t.Helper()
	return NewRegistry(nil, nil)
}

func startInput(session, requestID string) StartInput {
	return StartInput{
		Actor:    ActorKey{SessionID: session},
		Identity: Identity{Agent: "codex", RequestID: requestID},
	}
}

func TestStartDerivesDeterministicTurnAndIdempotentRetry(t *testing.T) {
	r := newTestRegistry(t)
	rec1, err := r.Start(startInput("sess-1", "req-1"))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if rec1.State != protocol.TurnStateRunning || rec1.TurnID == "" {
		t.Fatalf("record = %+v", rec1)
	}
	if rec1.Origin != protocol.TurnOriginRequest || rec1.Confidence != protocol.TurnConfidenceDerived {
		t.Errorf("origin/confidence = %s/%s", rec1.Origin, rec1.Confidence)
	}
	// Same (session, actor, request) retry → same id, idempotent.
	rec2, err := r.Start(startInput("sess-1", "req-1"))
	if err != nil {
		t.Fatalf("retry start: %v", err)
	}
	if rec2.TurnID != rec1.TurnID {
		t.Errorf("retry derived %q, want %q", rec2.TurnID, rec1.TurnID)
	}
	if !r.ClaimEmission(rec1.TurnID, protocol.TurnStateRunning) {
		t.Error("first running emission must be claimable")
	}
	if r.ClaimEmission(rec1.TurnID, protocol.TurnStateRunning) {
		t.Error("duplicate running emission must be rejected")
	}
}

func TestStartNativeIdentityWins(t *testing.T) {
	r := newTestRegistry(t)
	in := StartInput{
		Actor:    ActorKey{SessionID: "sess-1"},
		Identity: Identity{Agent: "codex", RequestID: "req-1", SourceTurnID: "native-1"},
	}
	rec, err := r.Start(in)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if rec.SourceTurnID != "native-1" || rec.Origin != protocol.TurnOriginNative || rec.Confidence != protocol.TurnConfidenceNative {
		t.Errorf("native identity not preferred: %+v", rec)
	}
}

func TestBindSourceIsFirstWriterWins(t *testing.T) {
	r := newTestRegistry(t)
	rec, err := r.Start(startInput("sess-bind", "req-bind"))
	if err != nil {
		t.Fatal(err)
	}
	bound, err := r.BindSource(rec.Actor, rec.TurnID, "native-source-1")
	if err != nil || bound.SourceTurnID != "native-source-1" {
		t.Fatalf("first source binding = %+v, %v", bound, err)
	}
	if _, err := r.BindSource(rec.Actor, rec.TurnID, "native-source-1"); err != nil {
		t.Fatalf("matching source binding must be idempotent: %v", err)
	}
	if got, err := r.BindSource(rec.Actor, rec.TurnID, "native-source-2"); !errors.Is(err, ErrStaleTurn) || got.SourceTurnID != "native-source-1" {
		t.Fatalf("conflicting source rewrote binding: %+v, %v", got, err)
	}
}

func TestExpectedSourceRejectsCompetitorAndConfirmsExactSource(t *testing.T) {
	r := newTestRegistry(t)
	rec, err := r.Start(startInput("sess-expected-source", "req-expected-source"))
	if err != nil {
		t.Fatal(err)
	}
	expected, err := r.ExpectSource(rec.Actor, rec.TurnID, "native-source-expected")
	if err != nil || expected.SourceTurnID != "" || expected.ExpectedSourceTurnID != "native-source-expected" {
		t.Fatalf("expected source reservation = %+v, %v", expected, err)
	}
	if got, err := r.BindSource(rec.Actor, rec.TurnID, "native-source-competitor"); !errors.Is(err, ErrStaleTurn) || got.SourceTurnID != "" {
		t.Fatalf("competitor source was not rejected: %+v, %v", got, err)
	}
	bound, err := r.BindSource(rec.Actor, rec.TurnID, "native-source-expected")
	if err != nil || bound.SourceTurnID != "native-source-expected" || bound.ExpectedSourceTurnID != "" {
		t.Fatalf("expected source confirmation = %+v, %v", bound, err)
	}
}

func TestStartWithoutAnchorFailsClosed(t *testing.T) {
	r := newTestRegistry(t)
	_, err := r.Start(StartInput{Actor: ActorKey{SessionID: "sess-1"}, Identity: Identity{Agent: "codex"}})
	if !errors.Is(err, ErrNoIdentityAnchor) {
		t.Fatalf("err = %v, want ErrNoIdentityAnchor", err)
	}
	if _, ok := r.Active(ActorKey{SessionID: "sess-1"}); ok {
		t.Error("no record may be created without an anchor")
	}
}

func TestStartWhileDifferentActiveTurnRunning(t *testing.T) {
	r := newTestRegistry(t)
	if _, err := r.Start(startInput("sess-1", "req-1")); err != nil {
		t.Fatal(err)
	}
	_, err := r.Start(startInput("sess-1", "req-2"))
	var active *ActiveTurnError
	if !errors.As(err, &active) {
		t.Fatalf("err = %v, want ActiveTurnError", err)
	}
}

func TestAddendumBindsRunningTurn(t *testing.T) {
	r := newTestRegistry(t)
	rec, _ := r.Start(startInput("sess-1", "req-1"))
	add, err := r.Addendum(ActorKey{SessionID: "sess-1"}, "req-2")
	if err != nil {
		t.Fatalf("addendum: %v", err)
	}
	if add.TurnID != rec.TurnID {
		t.Errorf("addendum created/used turn %q, want %q", add.TurnID, rec.TurnID)
	}
	if add.State != protocol.TurnStateRunning {
		t.Errorf("addendum must not change state, got %s", add.State)
	}
	if _, ok := r.Active(ActorKey{SessionID: "sess-1"}); !ok {
		t.Error("still exactly one active turn expected")
	}
	if _, err := r.Addendum(ActorKey{SessionID: "sess-none"}, "req-3"); !errors.Is(err, ErrNoActiveTurn) {
		t.Errorf("addendum without active turn: %v", err)
	}
}

func TestRequestInterruptLifecycle(t *testing.T) {
	r := newTestRegistry(t)
	key := ActorKey{SessionID: "sess-1"}
	rec, _ := r.Start(startInput("sess-1", "req-1"))

	if _, err := r.RequestInterrupt(key, "user_requested"); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
	got, _ := r.Active(key)
	if got.State != protocol.TurnStateInterruptRequested {
		t.Fatalf("state = %s", got.State)
	}
	// Idempotent re-request.
	if _, err := r.RequestInterrupt(key, "user_requested"); err != nil {
		t.Fatalf("re-interrupt must be idempotent: %v", err)
	}
	// Input during interrupt pending is a typed retryable nack.
	_, err := r.Addendum(key, "req-2")
	var pending *InterruptPendingError
	if !errors.As(err, &pending) || pending.TurnID != rec.TurnID {
		t.Fatalf("err = %v, want InterruptPendingError", err)
	}
	_, err = r.Start(startInput("sess-1", "req-2"))
	if !errors.As(err, &pending) {
		t.Fatalf("start during pending: %v, want InterruptPendingError", err)
	}
	// No active turn → typed error, never a guess.
	if _, err := r.RequestInterrupt(ActorKey{SessionID: "sess-other"}, "x"); !errors.Is(err, ErrNoActiveTurn) {
		t.Errorf("interrupt without active: %v", err)
	}
}

func TestTerminalizeValidatesTransitionsAndIsIdempotent(t *testing.T) {
	r := newTestRegistry(t)
	key := ActorKey{SessionID: "sess-1"}
	rec, _ := r.Start(startInput("sess-1", "req-1"))

	// Illegal: running -> interrupted (must pass interrupt_requested first).
	_, err := r.Terminalize(key, rec.TurnID, protocol.TurnStateInterrupted, "x", "")
	var te *TransitionError
	if !errors.As(err, &te) {
		t.Fatalf("err = %v, want TransitionError", err)
	}

	r.RequestInterrupt(key, "user_requested")
	done, err := r.Terminalize(key, rec.TurnID, protocol.TurnStateInterrupted, "turn_interrupt_confirmed", protocol.TurnConfidenceNative)
	if err != nil {
		t.Fatalf("terminalize: %v", err)
	}
	if done.State != protocol.TurnStateInterrupted {
		t.Errorf("state = %s", done.State)
	}
	if _, ok := r.Active(key); ok {
		t.Error("terminal turn must leave the active slot")
	}
	// Idempotent same-state repeat (late duplicate source event).
	if _, err := r.Terminalize(key, rec.TurnID, protocol.TurnStateInterrupted, "dup", ""); err != nil {
		t.Fatalf("duplicate terminal must be idempotent: %v", err)
	}
	// Terminal immutability: no path back to running.
	if _, err := r.Terminalize(key, rec.TurnID, protocol.TurnStateRunning, "", ""); !errors.As(err, &te) {
		t.Errorf("reopen: %v, want TransitionError", err)
	}
	// Re-starting the same derived id after terminal must fail (no reopen).
	if _, err := r.Start(startInput("sess-1", "req-1")); !errors.As(err, &te) {
		t.Errorf("restart same id: %v, want TransitionError", err)
	}
}

func TestTerminalizeStaleTurnReferenceIsRejected(t *testing.T) {
	r := newTestRegistry(t)
	key := ActorKey{SessionID: "sess-1"}
	rec, _ := r.Start(startInput("sess-1", "req-1"))
	// A late completion for an unknown turn must not close the active turn.
	if _, err := r.Terminalize(key, "turn:v1:codex:unknown", protocol.TurnStateCompleted, "", ""); !errors.Is(err, ErrStaleTurn) {
		t.Fatalf("err = %v, want ErrStaleTurn", err)
	}
	got, _ := r.Active(key)
	if got.State != protocol.TurnStateRunning || got.TurnID != rec.TurnID {
		t.Errorf("active turn must be untouched: %+v", got)
	}
}

func TestTerminalizeAllLegalPaths(t *testing.T) {
	cases := []struct {
		name  string
		path  []string
		final string
	}{
		{"running->completed", []string{protocol.TurnStateCompleted}, protocol.TurnStateCompleted},
		{"running->failed", []string{protocol.TurnStateFailed}, protocol.TurnStateFailed},
		{"running->abandoned", []string{protocol.TurnStateAbandoned}, protocol.TurnStateAbandoned},
		{"running->irq->interrupted", []string{protocol.TurnStateInterruptRequested, protocol.TurnStateInterrupted}, protocol.TurnStateInterrupted},
		{"running->irq->failed", []string{protocol.TurnStateInterruptRequested, protocol.TurnStateFailed}, protocol.TurnStateFailed},
		{"running->irq->abandoned", []string{protocol.TurnStateInterruptRequested, protocol.TurnStateAbandoned}, protocol.TurnStateAbandoned},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newTestRegistry(t)
			key := ActorKey{SessionID: "sess-" + c.name}
			rec, err := r.Start(StartInput{Actor: key, Identity: Identity{Agent: "codex", RequestID: "req-" + c.name}})
			if err != nil {
				t.Fatal(err)
			}
			for _, state := range c.path {
				if _, err := r.Terminalize(key, rec.TurnID, state, "reason", ""); err != nil {
					t.Fatalf("transition to %s: %v", state, err)
				}
			}
			_, ok := r.Active(key)
			if ok {
				t.Fatalf("turn must be terminal (%s)", c.final)
			}
		})
	}
}

func TestTerminalAfterInterruptStartsNewTurnWithLink(t *testing.T) {
	r := newTestRegistry(t)
	key := ActorKey{SessionID: "sess-1"}
	old, _ := r.Start(startInput("sess-1", "req-1"))
	r.RequestInterrupt(key, "user_requested")
	r.Terminalize(key, old.TurnID, protocol.TurnStateInterrupted, "confirmed", "")

	next, err := r.Start(StartInput{
		Actor:              key,
		Identity:           Identity{Agent: "codex", RequestID: "req-2"},
		PreviousTurnID:     old.TurnID,
		ContinuationReason: protocol.ContinuationReasonAfterInterrupt,
	})
	if err != nil {
		t.Fatalf("new turn after interrupt: %v", err)
	}
	if next.TurnID == old.TurnID {
		t.Error("new input must create a distinct turn id")
	}
	if next.PreviousTurnID != old.TurnID || next.ContinuationReason != protocol.ContinuationReasonAfterInterrupt {
		t.Errorf("continuation metadata missing: %+v", next)
	}
}

func TestActorIsolationAndConcurrentStarts(t *testing.T) {
	r := newTestRegistry(t)
	root := ActorKey{SessionID: "sess-1"}
	sub := ActorKey{SessionID: "sess-1", AgentID: "agent-1"}
	recRoot, err := r.Start(StartInput{Actor: root, Identity: Identity{Agent: "codex", RequestID: "req-r"}})
	if err != nil {
		t.Fatal(err)
	}
	recSub, err := r.Start(StartInput{Actor: sub, Identity: Identity{Agent: "codex", SourceTurnID: "native-sub"}})
	if err != nil {
		t.Fatalf("subagent must hold its own active turn: %v", err)
	}
	if recRoot.TurnID == recSub.TurnID {
		t.Error("root and subagent turns must not collide")
	}
	// Interrupting the root turn leaves the subagent turn untouched.
	r.RequestInterrupt(root, "user_requested")
	r.Terminalize(root, recRoot.TurnID, protocol.TurnStateInterrupted, "confirmed", "")
	if got, ok := r.Active(sub); !ok || got.TurnID != recSub.TurnID {
		t.Errorf("subagent turn must survive root interruption: %+v", got)
	}

	// Same-named agent in different sessions never shares state.
	other := ActorKey{SessionID: "sess-2", AgentID: "agent-1"}
	if _, err := r.Start(StartInput{Actor: other, Identity: Identity{Agent: "codex", SourceTurnID: "native-sub"}}); err != nil {
		t.Fatalf("same agent id in another session must start its own turn: %v", err)
	}

	// Concurrent starts on many actors under -race.
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := ActorKey{SessionID: "sess-c", AgentID: string(rune('a' + i%26))}
			for j := 0; j < 8; j++ {
				rec, err := r.Start(StartInput{Actor: key, Identity: Identity{Agent: "codex", RequestID: "req"}})
				if err == nil {
					r.RequestInterrupt(key, "x")
					r.Terminalize(key, rec.TurnID, protocol.TurnStateCompleted, "", "")
				}
				r.Active(key)
				r.ClaimEmission(rec.TurnID, protocol.TurnStateRunning)
			}
		}(i)
	}
	wg.Wait()
}

func TestReconcileAdoptsObservesAndIgnoresStale(t *testing.T) {
	r := newTestRegistry(t)
	key := ActorKey{SessionID: "sess-1"}

	// Observer direction: adopt an unknown running turn.
	observed := TurnRecord{
		Actor:      key,
		Agent:      "zcode",
		TurnID:     "turn:v1:zcode:observed",
		State:      protocol.TurnStateRunning,
		Origin:     protocol.TurnOriginSourceMessage,
		Confidence: protocol.TurnConfidenceDerived,
		StartedAt:  time.Now(),
	}
	if _, err := r.Reconcile(observed); err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if got, ok := r.Active(key); !ok || got.TurnID != observed.TurnID {
		t.Fatalf("observed turn not adopted: %+v", got)
	}

	// Provider direction: terminal fact closes it.
	fact := observed
	fact.State = protocol.TurnStateCompleted
	fact.LastReason = "assistant_finish"
	if _, err := r.Reconcile(fact); err != nil {
		t.Fatalf("terminal fact: %v", err)
	}
	if _, ok := r.Active(key); ok {
		t.Error("turn must be terminal after reconciled fact")
	}

	// Late terminal fact about an unknown turn is stale, not an error state.
	late := TurnRecord{Actor: key, TurnID: "turn:v1:zcode:old", State: protocol.TurnStateCompleted}
	if _, err := r.Reconcile(late); !errors.Is(err, ErrStaleTurn) {
		t.Errorf("late fact: %v, want ErrStaleTurn", err)
	}

	// Running fact colliding with a different active turn never replaces it.
	cur, _ := r.Start(startInput("sess-1", "req-9"))
	collide := TurnRecord{Actor: key, TurnID: "turn:v1:codex:other", State: protocol.TurnStateRunning}
	if _, err := r.Reconcile(collide); !errors.Is(err, ErrStaleTurn) {
		t.Errorf("colliding fact: %v, want ErrStaleTurn", err)
	}
	if got, _ := r.Active(key); got.TurnID != cur.TurnID {
		t.Error("active turn must not be replaced by a colliding fact")
	}
}

func TestRestoreFromJournalEntries(t *testing.T) {
	r := newTestRegistry(t)
	key := ActorKey{SessionID: "sess-1"}
	// Pre-existing active record must not be overwritten.
	existing, _ := r.Start(startInput("sess-1", "req-live"))
	r.Restore([]JournalEntry{
		{SessionID: "sess-1", TurnID: "turn:v1:codex:from-journal", State: protocol.TurnStateRunning},
		{SessionID: "sess-2", TurnID: "turn:v1:codex:terminal-leftover", State: protocol.TurnStateCompleted}, // dropped
		{SessionID: "sess-3", TurnID: "turn:v1:codex:pending", State: protocol.TurnStateInterruptRequested},
	})
	if got, _ := r.Active(key); got.TurnID != existing.TurnID {
		t.Errorf("restore overwrote live turn: %+v", got)
	}
	if got, ok := r.Active(ActorKey{SessionID: "sess-3"}); !ok || got.State != protocol.TurnStateInterruptRequested {
		t.Errorf("interrupt_requested entry not restored: %+v", got)
	}
	if _, ok := r.Active(ActorKey{SessionID: "sess-2"}); ok {
		t.Error("terminal entries must not be restored")
	}
}

func TestRegistryPersistsActiveSetToJournal(t *testing.T) {
	dir := t.TempDir()
	journal, err := OpenJournal(filepath.Join(dir, "turn-state-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	r := NewRegistry(journal, nil)
	key := ActorKey{SessionID: "sess-1"}
	rec, _ := r.Start(startInput("sess-1", "req-1"))

	loaded, err := journal.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 1 || loaded[0].TurnID != rec.TurnID || loaded[0].State != protocol.TurnStateRunning {
		t.Fatalf("journal = %+v", loaded)
	}
	r.Terminalize(key, rec.TurnID, protocol.TurnStateCompleted, "", "")
	loaded, _ = journal.Load()
	if len(loaded) != 0 {
		t.Errorf("journal must only hold active turns, got %+v", loaded)
	}
}

func TestRegistryMetricsHook(t *testing.T) {
	var invalid, inferred int
	metrics := MetricsFuncs{
		OnInvalidTransition: func(_, _, _ string) { invalid++ },
		OnInferredTerminal:  func(_, _, _ string) { inferred++ },
	}
	r := NewRegistry(nil, metrics)
	key := ActorKey{SessionID: "sess-1"}
	rec, _ := r.Start(startInput("sess-1", "req-1"))
	r.Terminalize(key, rec.TurnID, protocol.TurnStateInterrupted, "", "") // illegal
	if invalid != 1 {
		t.Errorf("invalid transition metric = %d", invalid)
	}
	r.Terminalize(key, rec.TurnID, protocol.TurnStateCompleted, "", protocol.TurnConfidenceInferred)
	if inferred != 1 {
		t.Errorf("inferred terminal metric = %d", inferred)
	}
}
