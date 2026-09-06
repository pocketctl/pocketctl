package session

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// ObserverReadOnlyCode is the stable daemon protocol reason for attempts to
// drive an observer-backed session.
const ObserverReadOnlyCode = "observer_read_only"

// ObserverReadOnlyError preserves adapter.ErrObserverReadOnly as the shared
// sentinel while carrying the session identity needed by control responses.
type ObserverReadOnlyError struct {
	SessionID string
}

func (e *ObserverReadOnlyError) Error() string {
	return fmt.Sprintf("session_id=%q: %v", e.SessionID, adapter.ErrObserverReadOnly)
}

func (*ObserverReadOnlyError) Unwrap() error { return adapter.ErrObserverReadOnly }

func observerReadOnlyError(sessionID string) error {
	if sessionID == "" {
		return adapter.ErrObserverReadOnly
	}
	return &ObserverReadOnlyError{SessionID: sessionID}
}

func rejectObserverAgent(agent, sessionID string) error {
	if adapter.IsObserverAgent(agent) {
		return observerReadOnlyError(sessionID)
	}
	return nil
}

// observerDriveGate coordinates drive authorization with origin
// reclassification for one session. A pending classifier has writer priority:
// later drives wait, while drives that already hold a lease are allowed to
// finish before classification commits.
type observerDriveGate struct {
	mu                    sync.Mutex
	changed               *sync.Cond
	activeDrives          int
	waitingDrives         int
	classificationPending bool
}

func newObserverDriveGate() *observerDriveGate {
	gate := &observerDriveGate{}
	gate.changed = sync.NewCond(&gate.mu)
	return gate
}

func (sm *SessionManager) observerDriveGateFor(sessionID string) *observerDriveGate {
	sm.observerDriveGatesMu.Lock()
	defer sm.observerDriveGatesMu.Unlock()
	if sm.observerDriveGates == nil {
		sm.observerDriveGates = make(map[string]*observerDriveGate)
	}
	gate := sm.observerDriveGates[sessionID]
	if gate == nil {
		gate = newObserverDriveGate()
		sm.observerDriveGates[sessionID] = gate
	}
	return gate
}

type observerDriveLeaseContextKey struct{}

type observerDriveLease struct {
	manager   *SessionManager
	sessionID string
	gate      *observerDriveGate
	active    atomic.Bool
	release   sync.Once
}

func (lease *observerDriveLease) close() {
	lease.release.Do(func() {
		lease.active.Store(false)
		lease.gate.mu.Lock()
		lease.gate.activeDrives--
		lease.gate.changed.Broadcast()
		lease.gate.mu.Unlock()
	})
}

// acquireObserverDrive returns a stable authorization lease. Agent is the
// authoritative discriminator and is read only while holding the same gate a
// watcher must hold to change it. The gate mutex is never held for backend,
// PTY, process, quota, or resolver work; activeDrives supplies that exclusion.
func (sm *SessionManager) acquireObserverDrive(ctx context.Context, sessionID string) (context.Context, func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if existing, ok := ctx.Value(observerDriveLeaseContextKey{}).(*observerDriveLease); ok &&
		existing.manager == sm && existing.sessionID == sessionID && existing.active.Load() {
		return ctx, func() {}, nil
	}

	// All controls share the same read-only history classification before
	// acquiring authorization. This may hydrate metadata but cannot drive it.
	sm.EnsureSessionLoaded(sessionID)
	gate := sm.observerDriveGateFor(sessionID)
	gate.mu.Lock()
	if gate.classificationPending {
		gate.waitingDrives++
		gate.changed.Broadcast()
		for gate.classificationPending {
			gate.changed.Wait()
		}
		gate.waitingDrives--
		gate.changed.Broadcast()
	}
	sm.mu.RLock()
	state := sm.sessions[sessionID]
	agent := ""
	if state != nil {
		agent = state.Agent
	}
	sm.mu.RUnlock()
	if err := rejectObserverAgent(agent, sessionID); err != nil {
		gate.mu.Unlock()
		return ctx, func() {}, err
	}
	gate.activeDrives++
	gate.changed.Broadcast()
	lease := &observerDriveLease{manager: sm, sessionID: sessionID, gate: gate}
	lease.active.Store(true)
	gate.mu.Unlock()
	return context.WithValue(ctx, observerDriveLeaseContextKey{}, lease), lease.close, nil
}

// WithObserverDrive holds one stable drive authorization across daemon-level
// effects such as quota validation and state-dirty marking. The derived
// context lets lower SessionManager layers reuse, rather than recursively wait
// on, the same lease.
func (sm *SessionManager) WithObserverDrive(ctx context.Context, sessionID string, drive func(context.Context) error) error {
	driveCtx, release, err := sm.acquireObserverDrive(ctx, sessionID)
	if err != nil {
		return err
	}
	defer release()
	return drive(driveCtx)
}

// rejectObserverDrive is a non-driving preflight. Direct write APIs use
// acquireObserverDrive and retain its lease until every side effect finishes.
func (sm *SessionManager) rejectObserverDrive(sessionID string) error {
	_, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		return err
	}
	release()
	return nil
}

func (sm *SessionManager) rejectObserverUserMessage(sessionID string) error {
	return sm.rejectObserverDrive(sessionID)
}

// RejectObserverDrive exposes the shared gate to the daemon command router.
func (sm *SessionManager) RejectObserverDrive(sessionID string) error {
	return sm.rejectObserverDrive(sessionID)
}

// RejectObserverUserMessage exposes the history-aware message preflight to the
// daemon command router, which must run it before resume quota validation.
func (sm *SessionManager) RejectObserverUserMessage(sessionID string) error {
	return sm.rejectObserverUserMessage(sessionID)
}

// IsObserverDriveCommand identifies daemon-native writes. Read-only metadata,
// replay/list operations, pinning, and Relay-only deletion are deliberately
// absent. Model/slash changes travel through user_message.
func IsObserverDriveCommand(commandType string) bool {
	switch commandType {
	case "user_message",
		"abort_create",
		"session_kill",
		"session_interrupt",
		"set_permission_config",
		"set_effort",
		"set_session_agent",
		"approval_response",
		"question_response",
		"question_reject",
		"mcp_elicitation_response",
		"interactive_response":
		return true
	default:
		return false
	}
}

// ObserverReadOnlyEvent maps a rejected message to a typed nack and every
// other daemon control to a correlated error.
func ObserverReadOnlyEvent(commandType, sessionID, requestID, msgID string, err error) protocol.DaemonEvent {
	if err == nil {
		err = observerReadOnlyError(sessionID)
	}
	if commandType == "user_message" {
		retryable := false
		return protocol.DaemonEvent{
			Type: "user_message_receipt", SessionID: sessionID, RequestID: requestID, MsgID: msgID,
			Status: "rejected", Reason: ObserverReadOnlyCode, Retryable: &retryable,
		}
	}
	return protocol.DaemonEvent{
		Type: "error", SessionID: sessionID, RequestID: requestID,
		Operation: commandType, Reason: ObserverReadOnlyCode, Error: err.Error(),
	}
}

// ObserverCreateRejectedEvent rejects observer creation without consuming its
// quota grant while preserving request/reservation correlation for Relay.
func ObserverCreateRejectedEvent(requestID, reservationID string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type: "session_create_failed", RequestID: requestID, ReservationID: reservationID,
		Reason: ObserverReadOnlyCode, Error: adapter.ErrObserverReadOnly.Error(),
	}
}

// ObserverUpgradeRejectedEvent is the agent-level counterpart to session
// control errors. Observer providers have no daemon-owned CLI to upgrade.
func ObserverUpgradeRejectedEvent(agent, requestID string) protocol.DaemonEvent {
	return protocol.DaemonEvent{
		Type: "upgrade_result", Agent: agent, RequestID: requestID, Status: "failed",
		Reason: ObserverReadOnlyCode, Error: adapter.ErrObserverReadOnly.Error(),
	}
}
