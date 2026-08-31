package session

import (
	"bytes"
	"context"
	"errors"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// --- harness ---------------------------------------------------------------

type turnTestPTY struct {
	bytes.Buffer
	writeErr error
}

type contextCaptureBackend struct {
	sentContent string
	hidden      *memorycontext.PreparedContext
	native      bool
}

type sessionMemoryContextClient struct {
	compiles int
	receipts int
}

func (m *sessionMemoryContextClient) Compile(context.Context, string, string, memorycontext.CompileRequest) (*memorycontext.CompileResponse, error) {
	m.compiles++
	return &memorycontext.CompileResponse{
		Outcome: "ready", Pack: &memorycontext.WirePack{PackID: "pack-1"}, AdmissionRequired: true,
	}, nil
}
func (*sessionMemoryContextClient) ConsumePack(context.Context, string, string, string, string, string, string) (*memorycontext.PackText, error) {
	return &memorycontext.PackText{PackID: "pack-1", StableText: "stable"}, nil
}
func (*sessionMemoryContextClient) Admit(context.Context, string, string, string, memorycontext.AdmitRequest) (*memorycontext.AdmitResponse, error) {
	return &memorycontext.AdmitResponse{
		InjectionID: "inj-1", Nonce: "nonce-1", ExpiresAt: time.Now().Add(5 * time.Second),
	}, nil
}
func (m *sessionMemoryContextClient) Receipt(context.Context, string, string, string, memorycontext.ReceiptRequest) error {
	m.receipts++
	return nil
}

func (*contextCaptureBackend) Start(context.Context, protocol.SessionConfig) (string, error) {
	return "", nil
}
func (b *contextCaptureBackend) Send(_ context.Context, _ string, content string) error {
	b.sentContent = content
	b.hidden = nil
	return nil
}
func (b *contextCaptureBackend) SendWithContext(_ context.Context, _ string, content string, hidden *memorycontext.PreparedContext) error {
	b.sentContent = content
	b.hidden = hidden
	return nil
}
func (b *contextCaptureBackend) memoryContextNativeSupported(context.Context) bool { return b.native }
func (*contextCaptureBackend) Interrupt(string) error                              { return nil }
func (*contextCaptureBackend) Close(string) error                                  { return nil }

func (p *turnTestPTY) Close() error                    { return nil }
func (p *turnTestPTY) SetSize(rows, cols uint16) error { return nil }
func (p *turnTestPTY) Write(b []byte) (int, error) {
	if p.writeErr != nil {
		return 0, p.writeErr
	}
	return p.Buffer.Write(b)
}

func newTurnTestManager(t *testing.T) (*SessionManager, *turnTestPTY) {
	t.Helper()
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	sm.interruptGrace = 10 * time.Millisecond
	pty := &turnTestPTY{}
	sm.sessions["turn-sess"] = &ProcessState{
		SessionID: "turn-sess",
		Source:    "daemon",
		Status:    protocol.StatusIdle,
		Agent:     "claude-code",
		PTY:       pty,
		Pid:       os.Getpid(), // dispatch checks liveness via pid
	}
	return sm, pty
}

func drainEvents(ch chan protocol.DaemonEvent) []protocol.DaemonEvent {
	var out []protocol.DaemonEvent
	for {
		select {
		case ev := <-ch:
			out = append(out, ev)
		default:
			return out
		}
	}
}

func findEvents(evs []protocol.DaemonEvent, typ string) []protocol.DaemonEvent {
	var out []protocol.DaemonEvent
	for _, ev := range evs {
		if ev.Type == typ {
			out = append(out, ev)
		}
	}
	return out
}

// --- 1. idle input: running turn reserved before attributable content -------

func TestTurnIdleInputReservesRunningBeforeContent(t *testing.T) {
	sm, pty := newTurnTestManager(t)
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "turn-sess", Content: "hello", RequestID: "req-1",
	}); err != nil {
		t.Fatal(err)
	}
	if got := pty.String(); got != "hello\r" {
		t.Errorf("pty wrote %q, want the message + CR", got)
	}
	evs := drainEvents(sm.outputCh)
	statuses := findEvents(evs, protocol.EventTypeTurnStatus)
	if len(statuses) == 0 || statuses[0].TurnStatus != protocol.TurnStateRunning {
		t.Fatalf("no running turn_status, events = %+v", evs)
	}
	firstContent := -1
	for i, ev := range evs {
		if ev.Type == "user_text" {
			firstContent = i
			break
		}
	}
	if firstContent == -1 {
		t.Fatal("no user_text echoed")
	}
	for i, ev := range evs {
		if ev.Type == protocol.EventTypeTurnStatus && i > firstContent {
			t.Errorf("turn_status running (%d) must precede user_text (%d)", i, firstContent)
		}
	}
	if statuses[0].TurnID == "" || statuses[0].TurnOrigin != protocol.TurnOriginRequest {
		t.Errorf("turn_status = %+v", statuses[0])
	}
}

// --- 2. running input binds as addendum -------------------------------------

func TestTurnRunningInputIsAddendum(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	ctx := context.Background()
	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "one", RequestID: "req-1"}); err != nil {
		t.Fatal(err)
	}
	drainEvents(sm.outputCh)
	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "two", RequestID: "req-2"}); err != nil {
		t.Fatal(err)
	}
	evs := drainEvents(sm.outputCh)
	if n := len(findEvents(evs, protocol.EventTypeTurnStatus)); n != 0 {
		t.Errorf("addendum must not emit a new running status, got %d", n)
	}
	rec, ok := sm.ActiveTurn("turn-sess")
	if !ok || rec.State != protocol.TurnStateRunning {
		t.Fatalf("active turn = %+v", rec)
	}
}

// --- 3. input during interrupt pending --------------------------------------

func TestTurnInterruptPendingInputIsTypedNackWithoutWrite(t *testing.T) {
	sm, pty := newTurnTestManager(t)
	sm.turnMode = turnEnrichmentEnforce
	ctx := context.Background()
	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "one", RequestID: "req-1"}); err != nil {
		t.Fatal(err)
	}
	drainEvents(sm.outputCh)
	if err := sm.InterruptSession("turn-sess"); err != nil {
		t.Fatal(err)
	}
	drainEvents(sm.outputCh)

	written := pty.String()
	var pending *turn.InterruptPendingError
	err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "early", RequestID: "req-2"})
	if !errors.As(err, &pending) {
		t.Fatalf("err = %v, want InterruptPendingError", err)
	}
	if got := pty.String(); got != written {
		t.Error("interrupt-pending input must not reach the PTY")
	}
}

// --- 4. after interrupt confirmed: new turn with previous link --------------

func TestTurnInputAfterConfirmedInterruptStartsNewTurn(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	ctx := context.Background()
	sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "one", RequestID: "req-1"})
	drainEvents(sm.outputCh)
	sm.InterruptSession("turn-sess")
	// Wait for the bounded-grace inference to publish the interrupted status —
	// waiting on the event (not registry state) pins the wire-level contract.
	deadline := time.Now().Add(2 * time.Second)
	var interrupted protocol.DaemonEvent
	for interrupted.Type == "" {
		select {
		case ev := <-sm.outputCh:
			if ev.Type == protocol.EventTypeTurnStatus && ev.TurnStatus == protocol.TurnStateInterrupted {
				interrupted = ev
			}
		case <-time.After(time.Until(deadline)):
			t.Fatal("turn not terminalized after interrupt grace")
		}
	}
	drainEvents(sm.outputCh)

	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "next", RequestID: "req-3"}); err != nil {
		t.Fatal(err)
	}
	evs := drainEvents(sm.outputCh)
	running := findEvents(evs, protocol.EventTypeTurnStatus)
	if len(running) != 1 || running[0].TurnStatus != protocol.TurnStateRunning {
		t.Fatalf("new turn = %+v", running)
	}
	if running[0].PreviousTurnID != interrupted.TurnID {
		t.Errorf("previous_turn_id = %q, want %q", running[0].PreviousTurnID, interrupted.TurnID)
	}
	if running[0].ContinuationReason != protocol.ContinuationReasonAfterInterrupt {
		t.Errorf("continuation_reason = %q", running[0].ContinuationReason)
	}
	if running[0].TurnID == interrupted.TurnID {
		t.Error("new turn must have a distinct id")
	}
}

// The bounded PTY interrupt inference owns the idle transition for the turn it
// just closed. If a continuation reserves a successor before that cleanup
// publishes, the old inferred idle must not complete or overwrite the new turn.
func TestTurnInferredPTYIdleDoesNotCompleteSuccessor(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	ctx := context.Background()
	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "one", RequestID: "req-1"}); err != nil {
		t.Fatal(err)
	}
	drainEvents(sm.outputCh)

	key := turn.ActorKey{SessionID: "turn-sess"}
	interrupted, err := sm.turns.RequestInterrupt(key, protocol.TurnReasonUserRequested)
	if err != nil {
		t.Fatal(err)
	}
	sm.terminalizeTurn(key, interrupted, protocol.TurnStateInterrupted, "pty_ctrl_c_confirmed", protocol.TurnConfidenceInferred)
	drainEvents(sm.outputCh)

	if err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "next", RequestID: "req-2"}); err != nil {
		t.Fatal(err)
	}
	successor, ok := sm.ActiveTurn("turn-sess")
	if !ok || successor.State != protocol.TurnStateRunning {
		t.Fatalf("successor before inferred idle = %+v", successor)
	}

	// This is the exact late cleanup window from confirmPTYInterrupt.
	sm.publishInferredPTYIdle("turn-sess", interrupted.TurnID)

	active, ok := sm.ActiveTurn("turn-sess")
	if !ok || active.TurnID != successor.TurnID || active.State != protocol.TurnStateRunning {
		t.Fatalf("inferred idle changed successor = %+v", active)
	}
	sm.mu.RLock()
	status := sm.sessions["turn-sess"].Status
	sm.mu.RUnlock()
	if status != protocol.StatusRunning {
		t.Fatalf("session status = %q, want running", status)
	}
	for _, event := range drainEvents(sm.outputCh) {
		if event.Type == protocol.EventTypeTurnStatus && event.TurnStatus == protocol.TurnStateCompleted {
			t.Fatalf("inferred idle completed successor: %+v", event)
		}
		if event.Type == "session_status" && event.Status == protocol.StatusIdle {
			t.Fatalf("inferred idle overwrote successor status: %+v", event)
		}
	}
}

// --- 5. interrupt then exit ordering ----------------------------------------

func TestTurnInterruptThenExitOrdering(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	ctx := context.Background()
	sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "one", RequestID: "req-1"})
	drainEvents(sm.outputCh)
	sm.InterruptSession("turn-sess")
	// Race the exit against the interrupt confirmation goroutine — the turn
	// must still terminalize before the session exit status, exactly once.
	sm.SetSessionExited("turn-sess", protocol.ExitReasonUserInterrupt)
	evs := drainEvents(sm.outputCh)
	var irqReq, irqDone, exited = -1, -1, -1
	for i, ev := range evs {
		switch {
		case ev.Type == protocol.EventTypeTurnStatus && ev.TurnStatus == protocol.TurnStateInterruptRequested && irqReq == -1:
			irqReq = i
		case ev.Type == protocol.EventTypeTurnStatus && ev.TurnStatus == protocol.TurnStateInterrupted && irqDone == -1:
			irqDone = i
		case ev.Type == "session_status" && ev.Status == protocol.StatusExited && exited == -1:
			exited = i
		}
	}
	if irqReq == -1 || irqDone == -1 || exited == -1 {
		t.Fatalf("events = %+v", evs)
	}
	if !(irqReq < irqDone && irqDone < exited) {
		t.Errorf("order irqReq=%d irqDone=%d exited=%d", irqReq, irqDone, exited)
	}
}

// --- 6. crash / no-evidence exit / activity timeout ---------------------------

func TestTurnExitReasonMapping(t *testing.T) {
	t.Run("crash", func(t *testing.T) {
		sm, _ := newTurnTestManager(t)
		sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-c"})
		drainEvents(sm.outputCh)
		sm.SetSessionExited("turn-sess", protocol.ExitReasonProcessCrash)
		evs := drainEvents(sm.outputCh)
		last := findEvents(evs, protocol.EventTypeTurnStatus)
		if len(last) == 0 || last[len(last)-1].TurnStatus != protocol.TurnStateFailed || last[len(last)-1].TurnReason != protocol.TurnReasonProcessCrash {
			t.Fatalf("crash mapping = %+v", evs)
		}
	})
	t.Run("no-evidence-exit", func(t *testing.T) {
		sm, _ := newTurnTestManager(t)
		sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-n"})
		drainEvents(sm.outputCh)
		sm.SetSessionExited("turn-sess", protocol.ExitReasonNormalExit)
		evs := drainEvents(sm.outputCh)
		last := findEvents(evs, protocol.EventTypeTurnStatus)
		if len(last) == 0 || last[len(last)-1].TurnStatus != protocol.TurnStateAbandoned ||
			last[len(last)-1].TurnReason != protocol.TurnReasonSessionExitWithoutTurnTerminal {
			t.Fatalf("abandoned mapping = %+v", evs)
		}
	})
	t.Run("activity-timeout", func(t *testing.T) {
		sm, _ := newTurnTestManager(t)
		sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-t"})
		drainEvents(sm.outputCh)
		sm.abandonTurnOnActivityTimeout("turn-sess")
		evs := drainEvents(sm.outputCh)
		last := findEvents(evs, protocol.EventTypeTurnStatus)
		if len(last) == 0 || last[len(last)-1].TurnStatus != protocol.TurnStateAbandoned ||
			last[len(last)-1].TurnReason != protocol.TurnReasonActivityTimeout {
			t.Fatalf("activity timeout mapping = %+v", evs)
		}
	})
}

// --- 7. idempotency: duplicate interrupt / request / late completion / race --

func TestTurnIdempotencyAndRaces(t *testing.T) {
	t.Run("duplicate-interrupt", func(t *testing.T) {
		sm, _ := newTurnTestManager(t)
		sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-d"})
		drainEvents(sm.outputCh)
		if err := sm.InterruptSession("turn-sess"); err != nil {
			t.Fatal(err)
		}
		drainEvents(sm.outputCh)
		// Wait for the grace inference to terminalize, then drain its output.
		time.Sleep(30 * time.Millisecond)
		drainEvents(sm.outputCh)
		// Second interrupt: no active turn → no double emission, no error.
		if err := sm.InterruptSession("turn-sess"); err != nil {
			t.Fatalf("duplicate interrupt: %v", err)
		}
		evs := drainEvents(sm.outputCh)
		if n := len(findEvents(evs, protocol.EventTypeTurnStatus)); n != 0 {
			t.Errorf("duplicate interrupt emitted %d turn_status events", n)
		}
	})
	t.Run("duplicate-request-reuses-turn", func(t *testing.T) {
		sm, _ := newTurnTestManager(t)
		ctx := context.Background()
		sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-same"})
		first := drainEvents(sm.outputCh)
		sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-same"})
		second := drainEvents(sm.outputCh)
		if n := len(findEvents(second, protocol.EventTypeTurnStatus)); n != 0 {
			t.Errorf("retried request id created a second turn (%d events)", n)
		}
		firstID := findEvents(first, protocol.EventTypeTurnStatus)[0].TurnID
		rec, _ := sm.ActiveTurn("turn-sess")
		if rec.TurnID != firstID {
			t.Errorf("turn id drifted: %q vs %q", rec.TurnID, firstID)
		}
	})
	t.Run("late-completion-after-interrupt", func(t *testing.T) {
		sm, _ := newTurnTestManager(t)
		sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-l"})
		sm.InterruptSession("turn-sess")
		time.Sleep(30 * time.Millisecond) // interrupt inference landed
		drainEvents(sm.outputCh)
		// A late agent idle signal must not rewrite the terminal state.
		sm.observeAgentStatusForTurn("turn-sess", protocol.StatusIdle)
		evs := drainEvents(sm.outputCh)
		if n := len(findEvents(evs, protocol.EventTypeTurnStatus)); n != 0 {
			t.Errorf("late completion emitted %d events", n)
		}
		if last, ok := sm.turns.Last(turn.ActorKey{SessionID: "turn-sess"}); !ok || last.State != protocol.TurnStateInterrupted {
			t.Errorf("terminal state rewritten: %+v", last)
		}
	})
	t.Run("exit-vs-interrupt-race", func(t *testing.T) {
		sm, _ := newTurnTestManager(t)
		sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-r"})
		drainEvents(sm.outputCh)
		sm.InterruptSession("turn-sess")                                   // interrupt_requested…
		sm.SetSessionExited("turn-sess", protocol.ExitReasonUserInterrupt) // …raced by exit
		time.Sleep(50 * time.Millisecond)                                  // grace goroutine wakes afterwards
		last, ok := sm.turns.Last(turn.ActorKey{SessionID: "turn-sess"})
		if !ok || last.State != protocol.TurnStateInterrupted {
			t.Fatalf("race outcome = %+v, want interrupted exactly once", last)
		}
		evs := drainEvents(sm.outputCh)
		done := 0
		for _, ev := range evs {
			if ev.Type == protocol.EventTypeTurnStatus && ev.TurnStatus == protocol.TurnStateInterrupted {
				done++
			}
		}
		if done != 1 {
			t.Errorf("interrupted emitted %d times, want 1", done)
		}
	})
}

// --- 8. agent completion signal closes the turn ------------------------------

func TestTurnAgentIdleSignalCompletesTurn(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-ok"})
	drainEvents(sm.outputCh)
	// The tailer's session_status(idle) observation closes the turn.
	sm.observeAgentStatusForTurn("turn-sess", protocol.StatusIdle)
	last, ok := sm.turns.Last(turn.ActorKey{SessionID: "turn-sess"})
	if !ok || last.State != protocol.TurnStateCompleted {
		t.Fatalf("turn = %+v, want completed", last)
	}
	// And completion side effects are allowed again.
	if !sm.turnAllowsCompletionSideEffects("turn-sess") {
		t.Error("completed turn must allow title/notify side effects")
	}
}

func TestTurnCompletionSideEffectsBlockedForNonCompleted(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-i"})
	sm.InterruptSession("turn-sess")
	time.Sleep(30 * time.Millisecond)
	if sm.turnAllowsCompletionSideEffects("turn-sess") {
		t.Error("interrupted turn must block completion side effects")
	}
	// GenerateTitle is a no-op for the dead turn: only attempts matter, and
	// none should be consumed.
	if ps := sm.sessions["turn-sess"]; ps.TitleAttempts != 0 {
		t.Errorf("title attempts = %d, want 0", ps.TitleAttempts)
	}
}

// --- 9. interrupt never releases the session slot -----------------------------

func TestTurnInterruptKeepsSessionAndQuota(t *testing.T) {
	sm, _ := newTurnTestManager(t)
	sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-q"})
	drainEvents(sm.outputCh)
	sm.InterruptSession("turn-sess")
	time.Sleep(50 * time.Millisecond)
	sm.mu.RLock()
	ps, ok := sm.sessions["turn-sess"]
	status := ps.Status
	sm.mu.RUnlock()
	if !ok {
		t.Fatal("interrupt must not remove the session")
	}
	if status != protocol.StatusIdle {
		t.Errorf("status = %q, want idle", status)
	}
	if _, ok := sm.ActiveTurn("turn-sess"); ok {
		t.Error("turn must be terminal after interrupt grace")
	}
}

// --- 10. journal restore across daemon restart -------------------------------

func TestTurnJournalRestoresActiveTurns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "turn-state-v1.json")
	sm, _ := newTurnTestManager(t)
	if err := sm.EnableTurnJournal(path); err != nil {
		t.Fatal(err)
	}
	// Journal wiring replaces the registry; start a fresh turn on it.
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-j"}); err != nil {
		t.Fatal(err)
	}
	drainEvents(sm.outputCh)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("journal not written: %v", err)
	}

	// New manager restores the active turn from disk.
	sm2 := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	if err := sm2.EnableTurnJournal(path); err != nil {
		t.Fatal(err)
	}
	rec, ok := sm2.ActiveTurn("turn-sess")
	if !ok || rec.State != protocol.TurnStateRunning || rec.TurnID == "" {
		t.Fatalf("restored turn = %+v ok=%v", rec, ok)
	}
	// The restored id must equal the pre-restart id (same derivation input).
	old, ok := sm.ActiveTurn("turn-sess")
	if !ok || old.TurnID != rec.TurnID {
		t.Fatalf("turn id drifted across restart: %+v vs %+v", old, rec)
	}
	// And a terminalizing exit after restore still works.
	sm2.SetSessionExited("turn-sess", protocol.ExitReasonNormalExit)
	if last, ok := sm2.turns.Last(turn.ActorKey{SessionID: "turn-sess"}); !ok || last.State != protocol.TurnStateAbandoned {
		t.Fatalf("post-restore exit = %+v", last)
	}
}

// --- feature flag: off keeps legacy behavior ----------------------------------

func TestTurnEnrichmentOffKeepsLegacyBehavior(t *testing.T) {
	sm, pty := newTurnTestManager(t)
	sm.turnMode = turnEnrichmentOff
	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-off"}); err != nil {
		t.Fatal(err)
	}
	evs := drainEvents(sm.outputCh)
	if n := len(findEvents(evs, protocol.EventTypeTurnStatus)); n != 0 {
		t.Errorf("off mode emitted %d turn_status events", n)
	}
	if _, ok := sm.ActiveTurn("turn-sess"); ok {
		t.Error("off mode must not track turns")
	}
	if pty.String() != "x\r" {
		t.Errorf("pty = %q", pty.String())
	}
}

// --- dispatch failure terminalizes the reserved turn ---------------------------

func TestTurnDispatchFailureFailsTurn(t *testing.T) {
	sm, pty := newTurnTestManager(t)
	pty.writeErr = errors.New("pty gone")
	err := sm.SendMessageWithInput(context.Background(), UserMessageInput{SessionID: "turn-sess", Content: "x", RequestID: "req-f"})
	if err == nil {
		t.Fatal("dispatch error expected")
	}
	evs := drainEvents(sm.outputCh)
	last := findEvents(evs, protocol.EventTypeTurnStatus)
	if len(last) == 0 || last[len(last)-1].TurnStatus != protocol.TurnStateFailed ||
		last[len(last)-1].TurnReason != protocol.TurnReasonInputDispatchFailed {
		t.Fatalf("dispatch-failure mapping = %+v", evs)
	}
}

// --- observe mode still accepts input during interrupt pending -----------------

func TestTurnObserveModeAcceptsInputWhileInterruptPending(t *testing.T) {
	sm, pty := newTurnTestManager(t)
	ctx := context.Background()
	sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "one", RequestID: "req-o1"})
	drainEvents(sm.outputCh)
	sm.InterruptSession("turn-sess")
	drainEvents(sm.outputCh)
	before := pty.String()
	err := sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: "turn-sess", Content: "still", RequestID: "req-o2"})
	if err != nil {
		t.Fatalf("observe mode must not reject input: %v", err)
	}
	if pty.String() == before {
		t.Error("observe mode input should still dispatch")
	}
}

// Phase 2 fail-open seam: a coordinator failure can never block dispatch.
func TestMemoryContextSeamFailsOpen(t *testing.T) {
	sm, pty := newTurnTestManager(t)
	sm.turnMode = turnEnrichmentObserve
	called := false
	coordinator := &memorycontext.Coordinator{
		Grants: grantTransportFunc(func(ctx context.Context, requestID, sessionID string) (*protocol.MemoryContextGrantResult, error) {
			called = true
			return nil, errors.New("relay unreachable")
		}),
	}
	sm.SetMemoryContext(coordinator, func() bool { return true },
		func(context.Context, string, string) memorycontext.Capability {
			return memorycontext.CapabilityNativeHiddenV1
		})
	err := sm.SendMessage(context.Background(), "turn-sess", "hello with context seam")
	if err != nil {
		t.Fatalf("dispatch must succeed despite coordinator failure: %v", err)
	}
	if !called {
		t.Fatal("coordinator should have been consulted on a fresh turn")
	}
	if pty.Len() == 0 {
		t.Fatal("original input must still be dispatched to the PTY")
	}
}

func TestMemoryContextCapabilityRequiresOwnedLiveRuntimeEvidence(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sm.sessions["owned"] = &ProcessState{
		SessionID: "owned", Source: "daemon", Agent: "opencode", Backend: &contextCaptureBackend{native: true},
	}
	sm.sessions["observed"] = &ProcessState{
		SessionID: "observed", Source: "terminal", Agent: "opencode", Backend: &contextCaptureBackend{native: true},
	}
	if got := sm.MemoryContextCapability(context.Background(), "owned", "opencode"); got != memorycontext.CapabilityNativeHiddenV1 {
		t.Fatalf("owned probed backend capability=%s", got)
	}
	if got := sm.MemoryContextCapability(context.Background(), "observed", "opencode"); got != memorycontext.CapabilityShadowOnly {
		t.Fatalf("observed terminal capability=%s", got)
	}
	if got := sm.MemoryContextCapability(context.Background(), "missing", "opencode"); got != memorycontext.CapabilityShadowOnly {
		t.Fatalf("missing runtime capability=%s", got)
	}
}

func TestFreshTurnDispatchesPreparedContextThroughAwareBackend(t *testing.T) {
	backend := &contextCaptureBackend{}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	sm.turnMode = turnEnrichmentObserve
	sm.sessions["context-sess"] = &ProcessState{
		SessionID: "context-sess", Source: "daemon", Status: protocol.StatusIdle,
		Agent: "opencode", Backend: backend,
	}
	pack := &memorycontext.PreparedContext{
		PackID: "pack-1", StableText: "stable", DynamicText: "dynamic",
	}

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "context-sess", Content: "unchanged user text", RequestID: "req-context",
		HiddenContext: pack,
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if backend.sentContent != "unchanged user text" {
		t.Fatalf("user content changed: %q", backend.sentContent)
	}
	if backend.hidden != pack {
		t.Fatalf("prepared context was dropped: got %+v", backend.hidden)
	}
}

func TestManagedCodexFreshTurnDoesNotBypassPreparedContext(t *testing.T) {
	backend := &contextCaptureBackend{}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	sm.turnMode = turnEnrichmentObserve
	sm.sessions["managed-codex-context"] = &ProcessState{
		SessionID: "managed-codex-context", Source: "daemon", Status: protocol.StatusIdle,
		Agent: "codex", Backend: backend, ControlMode: protocol.ControlManaged,
	}
	pack := &memorycontext.PreparedContext{PackID: "pack-codex", StableText: "stable"}

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "managed-codex-context", Content: "unchanged codex text", RequestID: "req-codex-context",
		HiddenContext: pack,
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if backend.sentContent != "unchanged codex text" || backend.hidden != pack {
		t.Fatalf("managed codex dropped context: content=%q hidden=%+v", backend.sentContent, backend.hidden)
	}
}

func TestFreshTurnRecordsAcceptedReceiptAfterContextAwareDispatch(t *testing.T) {
	backend := &contextCaptureBackend{}
	memory := &sessionMemoryContextClient{}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	sm.turnMode = turnEnrichmentObserve
	sm.sessions["context-sess"] = &ProcessState{
		SessionID: "context-sess", Source: "daemon", Status: protocol.StatusIdle,
		Agent: "opencode", Backend: backend,
	}
	sm.SetMemoryContext(&memorycontext.Coordinator{
		Grants: grantTransportFunc(func(context.Context, string, string) (*protocol.MemoryContextGrantResult, error) {
			return &protocol.MemoryContextGrantResult{
				Type: "memory_context_grant_result", Grant: "grant", ExpiresIn: 300,
				InstallationID: "install-1", SessionID: "context-sess",
				ProviderPublicOrigin: "https://memory.example", Services: []string{"memory.context"},
			}, nil
		}),
		Memory: memory,
	}, func() bool { return true }, func(context.Context, string, string) memorycontext.Capability {
		return memorycontext.CapabilityNativeHiddenV1
	})

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "context-sess", Content: "unchanged", RequestID: "req-receipt",
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if memory.receipts != 1 {
		t.Fatalf("accepted delivery receipts = %d, want 1", memory.receipts)
	}
}

func TestSlashCommandSkipsMemoryContextPreparation(t *testing.T) {
	backend := &contextCaptureBackend{}
	memory := &sessionMemoryContextClient{}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	sm.turnMode = turnEnrichmentObserve
	sm.sessions["command-sess"] = &ProcessState{
		SessionID: "command-sess", Source: "daemon", Status: protocol.StatusIdle,
		Agent: "opencode", Backend: backend,
	}
	sm.SetMemoryContext(&memorycontext.Coordinator{
		Grants: grantTransportFunc(func(context.Context, string, string) (*protocol.MemoryContextGrantResult, error) {
			return &protocol.MemoryContextGrantResult{
				Type: "memory_context_grant_result", Grant: "grant", ExpiresIn: 300,
				InstallationID: "install-1", SessionID: "command-sess",
				ProviderPublicOrigin: "https://memory.example", Services: []string{"memory.context"},
			}, nil
		}),
		Memory: memory,
	}, func() bool { return true }, func(context.Context, string, string) memorycontext.Capability {
		return memorycontext.CapabilityNativeHiddenV1
	})

	if err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: "command-sess", Content: "/help", RequestID: "req-command",
	}); err != nil {
		t.Fatalf("dispatch command: %v", err)
	}
	if memory.compiles != 0 || memory.receipts != 0 {
		t.Fatalf("slash command touched memory context: compiles=%d receipts=%d", memory.compiles, memory.receipts)
	}
	if backend.sentContent != "/help" || backend.hidden != nil {
		t.Fatalf("command dispatch = content %q hidden %+v", backend.sentContent, backend.hidden)
	}
}

type grantTransportFunc func(ctx context.Context, requestID, sessionID string) (*protocol.MemoryContextGrantResult, error)

func (f grantTransportFunc) RequestContextGrant(ctx context.Context, requestID, sessionID string) (*protocol.MemoryContextGrantResult, error) {
	return f(ctx, requestID, sessionID)
}

func (f grantTransportFunc) RegisterSession(ctx context.Context, requestID, sessionID string) (*protocol.SessionRegistrationAck, error) {
	return nil, errors.New("unsupported in test")
}
