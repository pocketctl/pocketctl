// Package turn implements the PocketCtl turn lifecycle core: a pure state
// machine, deterministic logical turn identity derivation, a centralized event
// classifier and an active-state journal. It has no dependency on any agent
// backend; provider projectors feed facts in and the daemon enriches outgoing
// events with the results.
//
// Semantics are frozen in
// docs/plans/2026-08-20-turn-lifecycle-and-stream-classification.md and
// openspec/changes/turn-lifecycle-stream-classification.
package turn

import (
	"fmt"
	"strings"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// ActorKey identifies the turn namespace: one active turn per
// (session, normalized agent). Root actors use an empty AgentID.
type ActorKey struct {
	SessionID string
	AgentID   string
}

func (k ActorKey) String() string { return k.SessionID + "|" + k.AgentID }

// NormalizeAgentID strips whitespace so the same subagent lands on one key.
func NormalizeAgentID(agentID string) string {
	return strings.TrimSpace(agentID)
}

// ActorScope derives the classification actor scope from existing agent
// hierarchy fields only — never from flow classification (plan §4).
func ActorScope(agentID string, isSubagent bool) string {
	if agentID != "" || isSubagent {
		return protocol.ActorScopeSubagent
	}
	return protocol.ActorScopeRoot
}

// IsTerminal reports whether state is one of the irreversible terminal states.
func IsTerminal(state string) bool {
	switch state {
	case protocol.TurnStateCompleted, protocol.TurnStateInterrupted,
		protocol.TurnStateFailed, protocol.TurnStateAbandoned:
		return true
	default:
		return false
	}
}

// IsActive reports whether state can still transition (non-terminal).
func IsActive(state string) bool {
	return state == protocol.TurnStateRunning || state == protocol.TurnStateInterruptRequested
}

// ValidState reports whether state belongs to the frozen state vocabulary.
func ValidState(state string) bool {
	return IsActive(state) || IsTerminal(state)
}

// CanTransition is the pure transition table (plan §3.2):
//
//	running              -> interrupt_requested | completed | failed | abandoned
//	interrupt_requested  -> interrupted | failed | abandoned
//	terminal             -> (nothing; terminal turns never reopen)
func CanTransition(from, to string) bool {
	switch from {
	case protocol.TurnStateRunning:
		switch to {
		case protocol.TurnStateInterruptRequested, protocol.TurnStateCompleted,
			protocol.TurnStateFailed, protocol.TurnStateAbandoned:
			return true
		}
	case protocol.TurnStateInterruptRequested:
		switch to {
		case protocol.TurnStateInterrupted, protocol.TurnStateFailed, protocol.TurnStateAbandoned:
			return true
		}
	}
	return false
}

// TransitionError is the typed error for illegal or conflicting transitions.
// It must never be silently swallowed: callers record the invalid-transition
// metric alongside it.
type TransitionError struct {
	TurnID string
	From   string
	To     string
	Reason string
}

func (e *TransitionError) Error() string {
	return fmt.Sprintf("turn %q: illegal transition %s -> %s", e.TurnID, e.From, e.To)
}

// InterruptPendingError is returned when input arrives while the actor's turn
// is still in interrupt_requested. It is retryable from the client's point of
// view (reason turn_interrupt_pending) and must not write to any backend.
type InterruptPendingError struct {
	TurnID string
}

func (e *InterruptPendingError) Error() string {
	return fmt.Sprintf("turn %q: interrupt still pending, retry later", e.TurnID)
}

// ActiveTurnError is returned when a start is attempted while a different
// active turn already exists for the actor.
type ActiveTurnError struct {
	TurnID string
	State  string
}

func (e *ActiveTurnError) Error() string {
	return fmt.Sprintf("active turn %q already in state %s", e.TurnID, e.State)
}
