package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"sync/atomic"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

// Turn lifecycle integration (plan stage 2). The registry is independent of
// sm.sessions: it never changes ProcessState's active-session definition,
// quota semantics or ownership. Enrichment is guarded by
// POCKETCTL_TURN_ENRICHMENT=off|observe|enforce (default observe).

type turnEnrichmentMode int

const (
	turnEnrichmentOff turnEnrichmentMode = iota
	turnEnrichmentObserve
	turnEnrichmentEnforce
)

func parseTurnEnrichmentMode(raw string) turnEnrichmentMode {
	switch raw {
	case "off":
		return turnEnrichmentOff
	case "enforce":
		return turnEnrichmentEnforce
	default:
		return turnEnrichmentObserve
	}
}

var turnLocalRequestSeq atomic.Uint64

// localRequestAnchor mints a content-free anchor for internal callers that
// have no relay request id. Each mint is unique per call — internal callers
// have no retry-convergence requirement.
func localRequestAnchor(sessionID string) string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("local-%s-%d", sessionID, turnLocalRequestSeq.Add(1))
	}
	return "local-" + hex.EncodeToString(b[:])
}

// turnEnabled reports whether turn metadata is being attached at all.
func (sm *SessionManager) turnEnabled() bool { return sm.turnMode != turnEnrichmentOff }

// UserMessageInput is the stage-2 command object for user input. Legacy
// callers keep the SendMessage wrapper; the relay daemon handler populates
// RequestID/MsgID so the daemon actually uses the relay-guaranteed ids.
type UserMessageInput struct {
	SessionID string
	Content   string
	RequestID string
	MsgID     string
	InputMode string // auto|new_turn|steer; empty = auto
	// HiddenContext is the Phase 2 native hidden-context payload for this
	// new turn. Content stays the exact user input for echo, receipts,
	// titles, Relay events and turn identity.
	HiddenContext *memorycontext.PreparedContext
	// SkipMemoryContext is internal fail-open state for an initial prompt whose
	// Relay session-registration ACK timed out. The prompt still dispatches.
	SkipMemoryContext bool
}

var ErrSessionExecutionIdentityUnavailable = errors.New("session execution identity unavailable")

type userMessageCorrelation struct {
	RequestID string
	MsgID     string
	TurnID    string
}

type userMessageCorrelationKey struct{}

func withUserMessageCorrelation(ctx context.Context, correlation userMessageCorrelation) context.Context {
	return context.WithValue(ctx, userMessageCorrelationKey{}, correlation)
}

func userMessageCorrelationFrom(ctx context.Context) userMessageCorrelation {
	correlation, _ := ctx.Value(userMessageCorrelationKey{}).(userMessageCorrelation)
	return correlation
}

func (sm *SessionManager) executionAgent(sessionID string) (string, error) {
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	agent := ""
	if ps != nil {
		agent = ps.Agent
	}
	sm.mu.RUnlock()
	if ps == nil || agent == "" {
		return "", fmt.Errorf("%w: session %s", ErrSessionExecutionIdentityUnavailable, sessionID)
	}
	switch agent {
	case adapter.AgentClaude, adapter.AgentCodex, adapter.AgentOpencode:
		return agent, nil
	default:
		return "", fmt.Errorf("%w: unsupported agent %q", ErrSessionExecutionIdentityUnavailable, agent)
	}
}

// ValidateExecutionIdentity confirms that a drive command has a recovered,
// supported agent identity before quota admission or turn creation.
func (sm *SessionManager) ValidateExecutionIdentity(sessionID string) error {
	_, err := sm.executionAgent(sessionID)
	return err
}

// SetMemoryContext attaches the Phase 2 context coordinator. The ready
// predicate resolves the local effective-mode ceiling; the capability
// resolver reports the probed native-hidden support for one agent (the
// adapters from Tasks 12-14 install it; absent means Shadow-only).
func (sm *SessionManager) SetMemoryContext(
	coordinator *memorycontext.Coordinator,
	ready func() bool,
	capabilityFor func(context.Context, string, string) memorycontext.Capability,
) {
	sm.mu.Lock()
	sm.memoryContext = coordinator
	sm.memoryContextReady = ready
	sm.memoryContextCapability = capabilityFor
	sm.mu.Unlock()
}

type memoryContextNativeBackend interface {
	memoryContextNativeSupported(context.Context) bool
}

// memoryContextReceiptDeferrer is implemented by a backend whose Send call
// only starts an asynchronous native request. Such a backend must record the
// receipt itself once the native API returns an authoritative result.
type memoryContextReceiptDeferrer interface {
	defersMemoryContextReceipt() bool
}

// MemoryContextCapability resolves one exact owned runtime instance. Observed
// terminal sessions and interactive PTYs are permanently Shadow-only. Managed
// backends must expose evidence from their live schema probe; dormant daemon-
// owned Claude resumes probe the exact CLI binary help before each upgrade.
func (sm *SessionManager) MemoryContextCapability(ctx context.Context, sessionID, agent string) memorycontext.Capability {
	sm.mu.RLock()
	ps := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if ps == nil || ps.Source != "daemon" {
		return memorycontext.CapabilityShadowOnly
	}
	if backend, ok := ps.Backend.(memoryContextNativeBackend); ok && backend.memoryContextNativeSupported(ctx) {
		switch ps.Agent {
		case adapter.AgentCodex:
			return memorycontext.ResolveCapability(memorycontext.RuntimeCodexAppServer, memorycontext.ProbeSupported)
		case adapter.AgentOpencode:
			return memorycontext.ResolveCapability(memorycontext.RuntimeOpenCodeServer, memorycontext.ProbeSupported)
		}
	}
	if agent == adapter.AgentClaude && (ps.Status == protocol.StatusExited || ps.Status == protocol.StatusCompleted) {
		binary, err := findAgentCLI(adapter.AgentClaude)
		if err == nil {
			return memorycontext.ResolveCapability(memorycontext.RuntimeClaudePrintResume, memorycontext.ProbeClaudeRuntime(ctx, binary))
		}
	}
	return memorycontext.CapabilityShadowOnly
}

// DispatchMemoryContextControl routes an inbound Relay control reply to the
// installed Phase 2 grant transport. It returns true only for recognized
// context messages; callers can keep them out of the ordinary session-command
// switch without exposing the coordinator or grant token.
func (sm *SessionManager) DispatchMemoryContextControl(msg protocol.ClientMessage) bool {
	switch msg.Type {
	case "memory_context_grant_result", "memory_context_grant_error",
		"session_registration_ack", "session_registration_error":
	default:
		return false
	}
	sm.mu.RLock()
	coordinator := sm.memoryContext
	sm.mu.RUnlock()
	if coordinator == nil || coordinator.Grants == nil {
		return true
	}
	if dispatcher, ok := coordinator.Grants.(interface{ Dispatch(protocol.ClientMessage) }); ok {
		dispatcher.Dispatch(msg)
	}
	return true
}

// prepareMemoryContext runs the fail-open enrichment seam. Every path —
// coordinator absent, mode off, grant/compile/admission failure, deadline —
// returns nil and the caller dispatches the original input unchanged.
func (sm *SessionManager) prepareMemoryContext(ctx context.Context, in UserMessageInput, requestID, agent string) *memorycontext.PreparedContext {
	sm.mu.RLock()
	coordinator := sm.memoryContext
	ready := sm.memoryContextReady
	capabilityFor := sm.memoryContextCapability
	sm.mu.RUnlock()
	if coordinator == nil {
		return nil
	}
	mode := memorycontext.ModeOff
	if ready != nil && ready() {
		mode = memorycontext.ModeEnabled
	}
	capability := memorycontext.CapabilityShadowOnly
	if capabilityFor != nil {
		capability = capabilityFor(ctx, in.SessionID, agent)
	}
	pack, _ := coordinator.Prepare(ctx, memorycontext.TurnRequest{
		ClientRequestID: requestID,
		SessionID:       in.SessionID,
		Agent:           agent,
		Cwd:             sm.cwdFor(in.SessionID),
		UserContent:     in.Content,
		IsNewTurn:       true,
		Mode:            mode,
		Capability:      capability,
	})
	return pack
}

func (sm *SessionManager) recordMemoryContextReceipt(ctx context.Context, pack *memorycontext.PreparedContext, delivered bool, outcome string) {
	if pack == nil {
		return
	}
	sm.mu.RLock()
	coordinator := sm.memoryContext
	sm.mu.RUnlock()
	if coordinator != nil {
		coordinator.Receipt(ctx, pack, memorycontext.DeliveryResult{
			Delivered: delivered, OutcomeCode: outcome,
		})
	}
}

func (sm *SessionManager) defersMemoryContextReceipt(sessionID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps := sm.sessions[sessionID]
	if ps == nil || ps.Backend == nil {
		return false
	}
	deferred, ok := ps.Backend.(memoryContextReceiptDeferrer)
	return ok && deferred.defersMemoryContextReceipt()
}

func (sm *SessionManager) cwdFor(sessionID string) string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if ps, ok := sm.sessions[sessionID]; ok {
		return ps.Cwd
	}
	return ""
}

// TakeDeferredInitialPrompt claims the managed-session prompt exactly once
// after session_created has been sent to Relay.
func (sm *SessionManager) TakeDeferredInitialPrompt(sessionID string) (string, bool) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	ps := sm.sessions[sessionID]
	if ps == nil || ps.DeferredInitialPrompt == "" {
		return "", false
	}
	prompt := ps.DeferredInitialPrompt
	ps.DeferredInitialPrompt = ""
	return prompt, true
}

// SendMessage keeps the legacy signature: it forwards through the turn-aware
// path with a locally-minted anchor.
func (sm *SessionManager) SendMessage(ctx context.Context, sessionID string, content string) error {
	return sm.SendMessageWithInput(ctx, UserMessageInput{SessionID: sessionID, Content: content})
}

// deferTurnReserveToBackend reports whether the turn reservation happens
// inside the backend rather than in SendMessageWithInput. Managed codex only
// learns its native turn id from the turn/start response, and the stage-3
// contract requires the logical id to derive from the native one — so the
// backend reserves after the RPC returns, still before any native content
// notification can arrive.
func (sm *SessionManager) deferTurnReserveToBackend(sessionID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok || ps.Backend == nil {
		return false
	}
	return ps.Agent == "codex" && ps.ControlMode == protocol.ControlManaged
}

// SendMessageWithInput reserves the turn before dispatch so the agent's fast
// output can never precede the turn identity. With an active running turn the
// input binds as an addendum (steer); after a terminal turn it opens a new
// turn linked to the interrupted predecessor.
func (sm *SessionManager) SendMessageWithInput(ctx context.Context, in UserMessageInput) error {
	ctx, release, err := sm.acquireObserverDrive(ctx, in.SessionID)
	if err != nil {
		return err
	}
	defer release()
	agent, err := sm.executionAgent(in.SessionID)
	if err != nil {
		return err
	}
	ctx = withUserMessageCorrelation(ctx, userMessageCorrelation{RequestID: in.RequestID, MsgID: in.MsgID})
	if !sm.turnEnabled() {
		return sm.dispatchUserMessage(ctx, in.SessionID, in.Content)
	}
	// Native slash commands are control operations rather than model turns. They
	// must not reserve a canonical turn or compile/consume a hidden context pack.
	if _, _, ok := parseOpenCodeSlashCommand(in.Content); ok {
		return sm.dispatchUserMessage(ctx, in.SessionID, in.Content)
	}
	key := turn.ActorKey{SessionID: in.SessionID}
	requestID := in.RequestID
	if requestID == "" {
		requestID = localRequestAnchor(in.SessionID)
	}

	// Reject input while an interrupt is still pending — enforced mode only;
	// observe keeps accepting so rollout cannot lock users out.
	if rec, ok := sm.turns.Active(key); ok && rec.State == protocol.TurnStateInterruptRequested && in.InputMode != protocol.InputModeSteer {
		if sm.turnMode == turnEnrichmentEnforce {
			return &turn.InterruptPendingError{TurnID: rec.TurnID}
		}
	}

	// Journal-reconcile (review P1-6): a restored turn carries evidence from
	// before this daemon process. If the session is not observably running,
	// the turn ended while we were away — terminalize it as abandoned instead
	// of silently binding the new input as its addendum.
	if rec, ok := sm.turns.Active(key); ok && rec.Restored && !sm.sessionObservablyRunning(in.SessionID) {
		sm.terminalizeTurn(key, rec, protocol.TurnStateAbandoned, "daemon_restart_reconcile", protocol.TurnConfidenceInferred)
	}

	// Managed Codex defers the turn reservation to the native turn/start reply,
	// but it must not bypass the Phase 2 preparation/delivery seam. A steer to
	// an already-running native turn remains context-free.
	if sm.deferTurnReserveToBackend(in.SessionID) {
		if active, ok := sm.turns.Active(key); ok && active.State == protocol.TurnStateRunning && in.InputMode != protocol.InputModeNewTurn {
			return sm.dispatchUserMessage(ctx, in.SessionID, in.Content)
		}
		if in.HiddenContext == nil && !in.SkipMemoryContext {
			in.HiddenContext = sm.prepareMemoryContext(ctx, in, requestID, agent)
		}
		if err := sm.dispatchUserMessageWithContext(ctx, in.SessionID, in.Content, in.HiddenContext); err != nil {
			sm.recordMemoryContextReceipt(ctx, in.HiddenContext, false, "dispatch_failed")
			return err
		}
		sm.recordMemoryContextReceipt(ctx, in.HiddenContext, true, "accepted")
		return nil
	}

	if active, ok := sm.turns.Active(key); ok && active.State == protocol.TurnStateRunning && in.InputMode != protocol.InputModeNewTurn {
		if _, err := sm.turns.Addendum(key, requestID); err != nil {
			return err
		}
		// Steer/addendum never creates a pack or injection (plan 8.3).
		return sm.dispatchUserMessage(ctx, in.SessionID, in.Content)
	}

	// Phase 2 context enrichment: only the fresh-turn path may prepare. The
	// coordinator is nil until the relay grant transport is attached; every
	// outcome (including errors) dispatches the original input unchanged.
	if in.HiddenContext == nil && !in.SkipMemoryContext {
		in.HiddenContext = sm.prepareMemoryContext(ctx, in, requestID, agent)
	}

	start := turn.StartInput{
		Actor:    key,
		Identity: turn.Identity{Agent: agent, RequestID: requestID},
	}
	// After an interrupt the new turn records the continuation link.
	if last, ok := sm.turns.Last(key); ok && last.State == protocol.TurnStateInterrupted {
		start.PreviousTurnID = last.TurnID
		start.ContinuationReason = protocol.ContinuationReasonAfterInterrupt
	}
	rec, err := sm.turns.Start(start)
	if err != nil {
		if sm.turnMode != turnEnrichmentEnforce && asInterruptPending(err) {
			// observe mode: do not strand the input on a pending interrupt
			return sm.dispatchUserMessage(ctx, in.SessionID, in.Content)
		}
		return err
	}
	sm.emitTurnStatus(rec, protocol.TurnStateRunning, "")
	ctx = withUserMessageCorrelation(ctx, userMessageCorrelation{RequestID: in.RequestID, MsgID: in.MsgID, TurnID: rec.TurnID})

	if dispatchErr := sm.dispatchUserMessageWithContext(ctx, in.SessionID, in.Content, in.HiddenContext); dispatchErr != nil {
		sm.recordMemoryContextReceipt(ctx, in.HiddenContext, false, "dispatch_failed")
		sm.outputCh <- protocol.DaemonEvent{
			Type:           "error",
			SessionID:      rec.Actor.SessionID,
			AgentID:        rec.Actor.AgentID,
			TurnID:         rec.TurnID,
			SourceTurnID:   rec.SourceTurnID,
			TurnOrigin:     rec.Origin,
			TurnConfidence: rec.Confidence,
			Error:          dispatchErr.Error(),
		}
		sm.terminalizeTurn(key, rec, protocol.TurnStateFailed, protocol.TurnReasonInputDispatchFailed, protocol.TurnConfidenceDerived)
		return dispatchErr
	}
	if !sm.defersMemoryContextReceipt(in.SessionID) {
		sm.recordMemoryContextReceipt(ctx, in.HiddenContext, true, "accepted")
	}
	return nil
}

func asInterruptPending(err error) bool {
	var pending *turn.InterruptPendingError
	return errorAs(err, &pending)
}

// errorAs is errors.As restricted to the pending type to keep imports tight.
func errorAs(err error, target **turn.InterruptPendingError) bool {
	for err != nil {
		if p, ok := err.(*turn.InterruptPendingError); ok {
			*target = p
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// agentTypeFor resolves the agent type used in logical id namespacing.
func (sm *SessionManager) agentTypeFor(sessionID string) string {
	if agent, ok := sm.GetSessionAgent(sessionID); ok && agent != "" {
		return agent
	}
	return "claude-code"
}

// emitTurnStatus publishes a turn_status event. Emission deduplication is NOT
// done here — the daemon's outgoing chokepoint (client.OnEvent →
// ObserveTurnStatusEvent) owns the single (turn, state) claim so every
// producer stays order-safe.
func (sm *SessionManager) emitTurnStatus(rec turn.TurnRecord, state, reason string) {
	if !sm.turnEnabled() {
		return
	}
	sm.outputCh <- turn.StatusEvent(rec, state, reason)
}

// ObserveTurnStatusEvent synchronizes a projected turn_status event into the
// registry and reports whether the event should still be forwarded — the
// single dedup point for (turn_id, state). Stale facts (a running event
// colliding with a different active turn) are dropped; terminal facts for
// unknown turns are forwarded as pure observation without creating records.
//
// Terminal merge (review P1-1): when an adapter-projected terminal fact
// arrives while a *different* turn is active and running for the same actor,
// the projection is describing that real turn (the adapters derive from the
// same conversation). The active turn is terminalized with the projected
// state and the projected event is dropped so exactly one identity survives.
func (sm *SessionManager) ObserveTurnStatusEvent(ev protocol.DaemonEvent) bool {
	if ev.Type != protocol.EventTypeTurnStatus || ev.TurnID == "" {
		return true
	}
	if !sm.turnEnabled() {
		return true
	}
	key := turn.ActorKey{SessionID: ev.SessionID, AgentID: turn.NormalizeAgentID(ev.AgentID)}
	if turn.IsActive(ev.TurnStatus) {
		if active, ok := sm.turns.Active(key); ok && active.TurnID != ev.TurnID {
			// A projected OpenCode source can bind only when it matches the exact
			// native id reserved for this outbound dispatch; fresh-sync history and
			// competing clients fail this check regardless of timestamp.
			if sm.openCodeProjectedSourceCanBind(active, ev) {
				_, _ = sm.turns.BindSource(key, active.TurnID, ev.SourceTurnID)
			}
			return false
		}
		if _, ok := sm.turns.Active(key); !ok {
			sm.turns.Reconcile(turn.TurnRecord{
				Actor:        key,
				Agent:        sm.agentTypeFor(ev.SessionID),
				TurnID:       ev.TurnID,
				SourceTurnID: ev.SourceTurnID,
				State:        ev.TurnStatus,
				Origin:       ev.TurnOrigin,
				Confidence:   ev.TurnConfidence,
				StartedAt:    time.Now(),
			})
		}
	} else if active, ok := sm.turns.Active(key); ok {
		if active.TurnID != ev.TurnID && active.State == protocol.TurnStateRunning && active.SourceTurnID == "" &&
			turn.IsTerminal(ev.TurnStatus) &&
			sm.openCodeProjectedSourceCanBind(active, ev) {
			bound, err := sm.turns.BindSource(key, active.TurnID, ev.SourceTurnID)
			if err != nil {
				return false
			}
			active = bound
		}
		if active.TurnID == ev.TurnID {
			if _, err := sm.turns.Terminalize(key, ev.TurnID, ev.TurnStatus, ev.TurnReason, ev.TurnConfidence); err != nil {
				return false // illegal/contradictory transition — do not publish
			}
		} else if active.State == protocol.TurnStateRunning && active.SourceTurnID != "" &&
			ev.SourceTurnID == active.SourceTurnID && turn.CanTransition(protocol.TurnStateRunning, ev.TurnStatus) {
			// Merge only after explicit source binding. An uncorrelated late
			// terminal from a previous turn is stale and cannot close this turn.
			sm.terminalizeTurnFromOutgoing(key, active, ev.TurnStatus, ev.TurnReason, protocol.TurnConfidenceDerived)
			return false
		} else {
			return false
		}
	}
	return sm.turns.ClaimEmission(ev.TurnID, ev.TurnStatus)
}

// openCodeProjectedSourceCanBind is the narrow correlation path for native
// OpenCode source-message projections that arrive while a request-anchored
// turn is already active. Time ordering is not identity: only the source id
// reserved for the actual outbound dispatch can confirm the binding.
func (sm *SessionManager) openCodeProjectedSourceCanBind(active turn.TurnRecord, ev protocol.DaemonEvent) bool {
	if sm.agentForTurn(active) != adapter.AgentOpencode || ev.Resync || ev.SourceTurnID == "" ||
		ev.TurnOrigin != protocol.TurnOriginSourceMessage {
		return false
	}
	return active.ExpectedSourceTurnID != "" && ev.SourceTurnID == active.ExpectedSourceTurnID
}

func (sm *SessionManager) agentForTurn(active turn.TurnRecord) string {
	if active.Agent != "" {
		return active.Agent
	}
	// Older journal entries did not persist Agent. By the time an adapter
	// projection arrives, discovery's ProcessState is the authoritative
	// backwards-compatible source for that non-content identity field.
	return sm.agentTypeFor(active.Actor.SessionID)
}

// terminalizeTurn drives the actor's turn to a terminal state, emits the
// turn_status event, and (enforce mode only) drains interactions that belong
// exclusively to the dead turn. When a root turn is interrupted, child turns
// of the same session that are still active are abandoned — a subagent turn
// cannot outlive the user intent that spawned it (review P1-7).
func (sm *SessionManager) terminalizeTurn(key turn.ActorKey, rec turn.TurnRecord, state, reason, confidence string) {
	if !sm.turnEnabled() {
		return
	}
	final, err := sm.turns.Terminalize(key, rec.TurnID, state, reason, confidence)
	if err != nil {
		return // typed: stale, illegal or already terminal — never a guess
	}
	sm.emitTurnStatus(final, state, reason)
	sm.finishTerminalizedTurn(final, state)
}

// terminalizeTurnFromOutgoing is the WebSocket-chokepoint variant. The caller
// is synchronously consuming outputCh, so it must never block trying to put the
// canonical replacement back into a full copy of that same channel. Registry
// state changes synchronously; delivery waits asynchronously only when the
// buffer is full. Post-terminal cleanup runs outside the consumer and its
// events therefore cannot deadlock that consumer either.
func (sm *SessionManager) terminalizeTurnFromOutgoing(key turn.ActorKey, rec turn.TurnRecord, state, reason, confidence string) {
	if !sm.turnEnabled() {
		return
	}
	final, err := sm.turns.Terminalize(key, rec.TurnID, state, reason, confidence)
	if err != nil {
		return
	}
	event := turn.StatusEvent(final, state, reason)
	select {
	case sm.outputCh <- event:
	default:
		go func() { sm.outputCh <- event }()
	}
	go sm.finishTerminalizedTurn(final, state)
}

func (sm *SessionManager) finishTerminalizedTurn(final turn.TurnRecord, state string) {
	if state != protocol.TurnStateCompleted && sm.turnMode == turnEnrichmentEnforce {
		sm.drainTurnInteractions(final.Actor.SessionID, "turn_interrupted")
	}
	if state != protocol.TurnStateCompleted {
		sm.abandonChildTurns(final.Actor.SessionID, final.TurnID)
	}
}

// abandonChildTurns terminalizes only subagent turns carrying an explicit
// ParentTurnID for the root that just died. Shared session/actor proximity is
// intentionally insufficient evidence of parentage.
func (sm *SessionManager) abandonChildTurns(sessionID, rootTurnID string) {
	for key, child := range sm.turns.ActiveAll() {
		if key.SessionID != sessionID || key.AgentID == "" || child.ParentTurnID != rootTurnID {
			continue
		}
		sm.terminalizeTurn(key, child, protocol.TurnStateAbandoned, protocol.TurnReasonParentTurnInterrupted, protocol.TurnConfidenceInferred)
	}
}

// drainTurnInteractions resolves pending approvals/questions tied to a
// dead turn through the existing first-writer-wins paths so no zombie cards
// survive into the next turn (review P1-7): the hook approval server, the
// Claude channel, and OpenCode's pending permission/question maps.
func (sm *SessionManager) drainTurnInteractions(sessionID, reason string) {
	if sm.approvals != nil {
		sm.approvals.DrainSession(sessionID)
	}
	sm.HandleClaudeChannelSessionEnd(sessionID, reason)
	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	var permissions []PendingOpenCodePermission
	var questions []PendingOpenCodeQuestion
	if ok {
		if len(ps.PendingPermissions) > 0 {
			permissions = make([]PendingOpenCodePermission, 0, len(ps.PendingPermissions))
			for _, p := range ps.PendingPermissions {
				permissions = append(permissions, p)
			}
			ps.PendingPermissions = nil
		}
		if len(ps.PendingQuestions) > 0 {
			questions = make([]PendingOpenCodeQuestion, 0, len(ps.PendingQuestions))
			for _, q := range ps.PendingQuestions {
				questions = append(questions, q)
			}
			ps.PendingQuestions = nil
		}
	}
	sm.mu.Unlock()
	if !ok {
		return
	}
	for _, p := range permissions {
		sm.outputCh <- protocol.DaemonEvent{
			Type: "approval_resolved", SessionID: sessionID, RequestID: p.RequestID,
			Action: "reject", Approved: false, Reason: reason,
		}
	}
	for _, q := range questions {
		sm.outputCh <- protocol.DaemonEvent{
			Type: "question_resolved", SessionID: sessionID, RequestID: q.RequestID,
			Rejected: true, Reason: reason,
		}
	}
	if len(permissions) > 0 || len(questions) > 0 {
		sm.emitCurrentInteractionStatus(sessionID)
	}
}

// terminalizeTurnOnExit maps a session exit onto the active turn's terminal
// state (plan §3.3 scenario A): crash → failed, interrupt pending →
// interrupted, otherwise abandoned — never a fabricated completed.
func (sm *SessionManager) terminalizeTurnOnExit(sessionID, exitReason string) {
	if !sm.turnEnabled() {
		return
	}
	key := turn.ActorKey{SessionID: sessionID}
	rec, ok := sm.turns.Active(key)
	if !ok {
		return
	}
	state, reason := protocol.TurnStateAbandoned, protocol.TurnReasonSessionExitWithoutTurnTerminal
	switch {
	case rec.State == protocol.TurnStateInterruptRequested:
		state, reason = protocol.TurnStateInterrupted, "turn_interrupt_confirmed"
	case exitReason == protocol.ExitReasonProcessCrash || exitReason == protocol.ExitReasonSignalKill:
		state, reason = protocol.TurnStateFailed, protocol.TurnReasonProcessCrash
	}
	sm.terminalizeTurn(key, rec, state, reason, protocol.TurnConfidenceInferred)
}

// observeAgentStatusForTurn closes the active turn when an agent-sourced
// status event reports the session back at idle/completed. It runs before the
// triggering event is forwarded so the turn terminal always precedes the
// session status on the wire.
func (sm *SessionManager) observeAgentStatusForTurn(sessionID, status string) {
	if !sm.turnEnabled() {
		return
	}
	if status != protocol.StatusIdle && status != protocol.StatusCompleted {
		return
	}
	key := turn.ActorKey{SessionID: sessionID}
	rec, ok := sm.turns.Active(key)
	if !ok {
		return
	}
	sm.terminalizeTurn(key, rec, protocol.TurnStateCompleted, "agent_completed", protocol.TurnConfidenceDerived)
}

// abandonTurnOnActivityTimeout implements the stage-2 rule: the five-minute
// no-activity fallback must publish abandoned(activity_timeout) before the
// session returns to idle — never a disguised completed.
func (sm *SessionManager) abandonTurnOnActivityTimeout(sessionID string) {
	if !sm.turnEnabled() {
		return
	}
	key := turn.ActorKey{SessionID: sessionID}
	rec, ok := sm.turns.Active(key)
	if !ok {
		return
	}
	sm.terminalizeTurn(key, rec, protocol.TurnStateAbandoned, protocol.TurnReasonActivityTimeout, protocol.TurnConfidenceInferred)
}

// confirmPTYInterrupt waits a bounded grace for native terminal evidence
// after Ctrl+C was accepted by the PTY. Without any (Claude TUI writes no
// terminal JSONL record on interrupt) the turn terminalizes as
// interrupted(inferred) and only then does the session return to idle.
func (sm *SessionManager) confirmPTYInterrupt(sessionID string) {
	grace := sm.interruptGrace
	if grace <= 0 {
		grace = 3 * time.Second
	}
	time.Sleep(grace)
	key := turn.ActorKey{SessionID: sessionID}
	rec, ok := sm.turns.Active(key)
	if !ok || rec.State != protocol.TurnStateInterruptRequested {
		return // already terminalized by native evidence or exit
	}
	sm.terminalizeTurn(key, rec, protocol.TurnStateInterrupted, "pty_ctrl_c_confirmed", protocol.TurnConfidenceInferred)
	sm.publishInferredPTYIdle(sessionID, rec.TurnID)
}

// publishInferredPTYIdle publishes the session-idle side of a confirmed PTY
// interrupt without treating it as fresh agent completion evidence. A user can
// start a continuation as soon as the interrupted turn is published; that
// successor owns the session lifecycle, so the old inference must not overwrite
// its running state or terminalize it as completed.
func (sm *SessionManager) publishInferredPTYIdle(sessionID, interruptedTurnID string) {
	if interruptedTurnID == "" {
		return
	}
	key := turn.ActorKey{SessionID: sessionID}
	last, ok := sm.turns.Last(key)
	if !ok || last.TurnID != interruptedTurnID || last.State != protocol.TurnStateInterrupted {
		return
	}
	if _, ok := sm.turns.Active(key); ok {
		return
	}

	sm.mu.Lock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	now := time.Now()
	ps.Status = protocol.StatusIdle
	ps.LastActivityAt = now
	sm.mu.Unlock()

	sm.outputCh <- protocol.DaemonEvent{
		Type:           "session_status",
		SessionID:      sessionID,
		Status:         protocol.StatusIdle,
		LastActivityAt: now.UTC().Format(time.RFC3339),
	}
}

// confirmAbortInterrupt is the opencode counterpart: after POST /abort was
// accepted the poller's authoritative status should close the turn; when it
// never arrives the bounded inference terminalizes interrupted so the turn
// cannot hang.
func (sm *SessionManager) confirmAbortInterrupt(sessionID string) {
	grace := sm.interruptGrace
	if grace <= 0 {
		grace = 10 * time.Second
	}
	time.Sleep(grace)
	key := turn.ActorKey{SessionID: sessionID}
	rec, ok := sm.turns.Active(key)
	if !ok || rec.State != protocol.TurnStateInterruptRequested {
		return
	}
	sm.terminalizeTurn(key, rec, protocol.TurnStateInterrupted, "abort_confirmed", protocol.TurnConfidenceInferred)
}

// turnAllowsCompletionSideEffects guards title generation and completion
// notifications: only a completed turn counts as success. While any turn is
// still in flight the side effects wait (review P1-5: comparing against the
// previous completed turn prematurely approved the current one); sessions
// without any turn record keep the legacy behavior.
func (sm *SessionManager) turnAllowsCompletionSideEffects(sessionID string) bool {
	if !sm.turnEnabled() {
		return true
	}
	key := turn.ActorKey{SessionID: sessionID}
	if _, ok := sm.turns.Active(key); ok {
		return false // a turn is still in flight
	}
	last, ok := sm.turns.Last(key)
	if !ok {
		return true
	}
	return last.State == protocol.TurnStateCompleted
}

// ActiveTurn exposes turn state for TurnStartedAt derivation. Read-only.
func (sm *SessionManager) ActiveTurn(sessionID string) (turn.TurnRecord, bool) {
	if sm.turns == nil {
		return turn.TurnRecord{}, false
	}
	return sm.turns.Active(turn.ActorKey{SessionID: sessionID})
}

// EnableTurnJournal attaches the persistent active-state journal and restores
// non-terminal entries. Called once from the daemon entry point; corruption is
// reported back for a structured warning while startup continues (fail-open).
func (sm *SessionManager) EnableTurnJournal(path string) error {
	journal, err := turn.OpenJournal(path)
	if err != nil {
		// Journal handle is still returned by OpenJournal even on corruption;
		// wire what we got and surface the error.
		if journal == nil {
			return err
		}
	}
	entries, loadErr := journal.Load()
	sm.mu.Lock()
	sm.turns = turn.NewRegistry(journal, sm.turnMetrics)
	sm.mu.Unlock()
	if len(entries) > 0 {
		sm.turns.Restore(entries)
	}
	if err != nil {
		return err
	}
	return loadErr
}

// sessionObservablyRunning reports whether the session's live state says an
// agent turn could still be in flight.
func (sm *SessionManager) sessionObservablyRunning(sessionID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps, ok := sm.sessions[sessionID]
	if !ok {
		return false
	}
	switch ps.Status {
	case protocol.StatusRunning, protocol.StatusBusy, protocol.StatusRetry,
		protocol.StatusWaitingApproval, protocol.StatusWaitingQuestion:
		return true
	default:
		return false
	}
}

// ReconcileRestoredTurns runs the post-restore reconciliation against the
// sessions discovered so far: a restored turn whose session is gone or no
// longer observably running ended while the daemon was down and terminalizes
// as abandoned (review P1-6). This runs after the discovery grace period, so
// absence from the settled discovery set is terminal evidence too.
func (sm *SessionManager) ReconcileRestoredTurns() {
	if !sm.turnEnabled() {
		return
	}
	for key, rec := range sm.turns.ActiveAll() {
		if !rec.Restored {
			continue
		}
		sm.mu.RLock()
		_, discovered := sm.sessions[key.SessionID]
		sm.mu.RUnlock()
		if !discovered || !sm.sessionObservablyRunning(key.SessionID) {
			sm.terminalizeTurn(key, rec, protocol.TurnStateAbandoned, "daemon_restart_reconcile", protocol.TurnConfidenceInferred)
		}
	}
}

// reserveTurnForInitialPrompt anchors the first turn of a freshly created
// session. The request anchor is synthesized locally (the create flow has no
// relay request id), keeping the dispatch-before-identity guarantee.
func (sm *SessionManager) reserveTurnForInitialPrompt(sessionID, agent string) (turn.TurnRecord, error) {
	if !sm.turnEnabled() {
		return turn.TurnRecord{}, nil
	}
	if agent == "" {
		agent = "claude-code"
	}
	return sm.turns.Start(turn.StartInput{
		Actor:    turn.ActorKey{SessionID: sessionID},
		Identity: turn.Identity{Agent: agent, RequestID: localRequestAnchor(sessionID)},
	})
}

// emitInitialPrompt reserves and publishes the lifecycle identity before the
// optimistic user echo. The actual agent dispatch is owned by each creation
// path (PTY writes later; Codex exec receives the prompt in argv).
func (sm *SessionManager) emitInitialPrompt(sessionID, agent, prompt string) {
	if prompt == "" {
		return
	}
	if rec, err := sm.reserveTurnForInitialPrompt(sessionID, agent); err == nil && rec.TurnID != "" {
		sm.emitTurnStatus(rec, protocol.TurnStateRunning, "")
	}
	echo := protocol.DaemonEvent{Type: "user_text", SessionID: sessionID, Text: prompt}
	sm.EnrichOutgoingEvent(&echo)
	sm.outputCh <- echo
}

// attributableContentTypes are the event types that represent agent/user
// content and therefore should carry turn identity once enrichment is on.
var attributableContentTypes = map[string]struct{}{
	"user_text": {}, "agent_text": {}, "agent_reasoning": {},
	"tool_call": {}, "tool_result": {}, "agent_patch": {}, "agent_file": {},
	"agent_file_change": {}, "agent_plan": {}, "agent_todo": {}, "agent_subtask": {},
}

// EnrichOutgoingEvent is the central outgoing classifier (plan §5): it stamps
// actor/flow/content classification metadata onto every event that does not
// already carry a classifier version, and counts content events that remain
// unassigned (no turn anchor). It never filters, reorders or rewrites.
//
// Identity unification (review P1-1): for controlled sessions the registry's
// active turn (request/native anchored) is authoritative. Content events the
// adapters projected with a source-message identity are re-bound to the
// active turn so one real turn never splits into "lifecycle without content"
// and "content without lifecycle" groups.
func (sm *SessionManager) EnrichOutgoingEvent(ev *protocol.DaemonEvent) {
	if !sm.turnEnabled() || ev == nil {
		return
	}
	_, content := attributableContentTypes[ev.Type]
	if content && ev.SessionID != "" {
		key := turn.ActorKey{SessionID: ev.SessionID, AgentID: turn.NormalizeAgentID(ev.AgentID)}
		if rec, ok := sm.turns.Active(key); ok && rec.State == protocol.TurnStateRunning {
			// OpenCode's first poll contains full history. Source-stamped content
			// may bind only when it matches the reserved outbound source identity;
			// bare daemon-originated content remains eligible.
			canStamp := true
			if sm.agentForTurn(rec) == adapter.AgentOpencode && ev.SourceTurnID != "" {
				canStamp = rec.SourceTurnID == ev.SourceTurnID ||
					rec.SourceTurnID == "" && sm.openCodeProjectedSourceCanBind(rec, *ev)
			}
			if canStamp && ev.SourceTurnID != "" && rec.SourceTurnID == "" {
				if bound, err := sm.turns.BindSource(key, rec.TurnID, ev.SourceTurnID); err == nil {
					rec = bound
				}
			}
			if canStamp {
				stampActiveTurnIdentity(ev, rec)
			}
		}
	} else if ev.Type == "error" && ev.SessionID != "" && ev.SourceTurnID != "" {
		key := turn.ActorKey{SessionID: ev.SessionID, AgentID: turn.NormalizeAgentID(ev.AgentID)}
		if rec, ok := sm.turns.Active(key); ok && rec.State == protocol.TurnStateRunning {
			// Diagnostic errors never bind on arbitrary source id alone. A matching
			// existing binding is sufficient; otherwise only the exact reserved
			// outbound source identity may establish it.
			if rec.SourceTurnID == "" && sm.openCodeProjectedSourceCanBind(rec, *ev) {
				if bound, err := sm.turns.BindSource(key, rec.TurnID, ev.SourceTurnID); err == nil {
					rec = bound
				}
			}
			if rec.SourceTurnID == ev.SourceTurnID {
				stampActiveTurnIdentity(ev, rec)
			}
		}
	}
	if ev.ClassifierVersion == "" {
		turn.Apply(ev, turn.Classify(ev, sm.turnMetrics))
	}
	if content && ev.TurnID == "" {
		sm.turnMetrics.UnassignedEvent()
	}
}

func stampActiveTurnIdentity(ev *protocol.DaemonEvent, rec turn.TurnRecord) {
	ev.TurnID = rec.TurnID
	if ev.SourceTurnID == "" {
		ev.SourceTurnID = rec.SourceTurnID
	}
	ev.TurnOrigin = rec.Origin
	ev.TurnConfidence = rec.Confidence
}
