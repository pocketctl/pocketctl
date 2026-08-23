package turn

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

var allStates = []string{
	protocol.TurnStateRunning,
	protocol.TurnStateInterruptRequested,
	protocol.TurnStateCompleted,
	protocol.TurnStateInterrupted,
	protocol.TurnStateFailed,
	protocol.TurnStateAbandoned,
}

// Full legal/illegal transition matrix from plan §3.2. 100% edge coverage.
func TestCanTransitionMatrix(t *testing.T) {
	legal := map[string][]string{
		protocol.TurnStateRunning: {
			protocol.TurnStateInterruptRequested,
			protocol.TurnStateCompleted,
			protocol.TurnStateFailed,
			protocol.TurnStateAbandoned,
		},
		protocol.TurnStateInterruptRequested: {
			protocol.TurnStateInterrupted,
			protocol.TurnStateFailed,
			protocol.TurnStateAbandoned,
		},
		protocol.TurnStateCompleted:   {},
		protocol.TurnStateInterrupted: {},
		protocol.TurnStateFailed:      {},
		protocol.TurnStateAbandoned:   {},
	}
	for _, from := range allStates {
		for _, to := range allStates {
			want := false
			for _, w := range legal[from] {
				if w == to {
					want = true
					break
				}
			}
			if got := CanTransition(from, to); got != want {
				t.Errorf("CanTransition(%s, %s) = %v, want %v", from, to, got, want)
			}
		}
	}
}

func TestTerminalStatesAreIrreversibleAndActiveFlag(t *testing.T) {
	for _, s := range allStates {
		term := IsTerminal(s)
		active := IsActive(s)
		if term == active {
			t.Errorf("state %s: IsTerminal and IsActive must be disjoint", s)
		}
		if !ValidState(s) {
			t.Errorf("state %s must be in the frozen vocabulary", s)
		}
	}
	if ValidState("paused") {
		t.Error("unknown state must not validate")
	}
	for _, term := range []string{protocol.TurnStateCompleted, protocol.TurnStateInterrupted, protocol.TurnStateFailed, protocol.TurnStateAbandoned} {
		for _, to := range allStates {
			if CanTransition(term, to) {
				t.Errorf("terminal state %s must never reopen to %s", term, to)
			}
		}
	}
}

func TestActorScopeFromHierarchyOnly(t *testing.T) {
	cases := []struct {
		agentID    string
		isSubagent bool
		want       string
	}{
		{"", false, protocol.ActorScopeRoot},
		{"agent-1", false, protocol.ActorScopeSubagent},
		{"", true, protocol.ActorScopeSubagent},
		{"agent-1", true, protocol.ActorScopeSubagent},
	}
	for _, c := range cases {
		if got := ActorScope(c.agentID, c.isSubagent); got != c.want {
			t.Errorf("ActorScope(%q, %v) = %q, want %q", c.agentID, c.isSubagent, got, c.want)
		}
	}
}

func TestNormalizeAgentID(t *testing.T) {
	if NormalizeAgentID("  agent-1 ") != "agent-1" {
		t.Error("agent id must be trimmed")
	}
	if NormalizeAgentID("") != "" {
		t.Error("root actor must stay empty")
	}
}

func TestTypedErrorsAreDistinct(t *testing.T) {
	errs := []error{
		&TransitionError{TurnID: "t1", From: "running", To: "completed"},
		&InterruptPendingError{TurnID: "t1"},
		&ActiveTurnError{TurnID: "t1", State: "running"},
		ErrNoActiveTurn,
		ErrStaleTurn,
		ErrNoIdentityAnchor,
		ErrTurnAlreadyActive,
	}
	for _, err := range errs {
		if err.Error() == "" {
			t.Errorf("typed error %T must have a message", err)
		}
	}
	if _, ok := error(ErrNoActiveTurn).(errString); !ok {
		t.Error("sentinel errors must stay comparable values")
	}
}
