package session

import (
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestRestoreCodexObserverStatusPreservesOwnershipAndActivity(t *testing.T) {
	for _, tc := range []struct {
		name, agent, source, mode, status string
		want                              bool
	}{
		{"desktop", adapter.AgentCodexDesktop, "observer", protocol.ControlLegacyReadOnly, protocol.StatusIdle, true},
		{"managed", adapter.AgentCodex, "daemon", protocol.ControlManaged, protocol.StatusIdle, false},
		{"terminal", adapter.AgentCodex, "terminal", protocol.ControlLegacyReadOnly, protocol.StatusIdle, false},
		{"unsupported status", adapter.AgentCodexDesktop, "observer", protocol.ControlLegacyReadOnly, protocol.StatusExited, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := make(chan protocol.DaemonEvent, 8)
			sm := NewSessionManager(out)
			activity := time.Now().Add(-time.Hour)
			ps := &ProcessState{SessionID: "restore", Agent: tc.agent, Source: tc.source,
				ControlMode: tc.mode, Status: protocol.StatusBusy, LastActivityAt: activity, TurnStartedAt: activity}
			sm.sessions[ps.SessionID] = ps
			if got := sm.RestoreCodexObserverStatus(ps.SessionID, tc.status); got != tc.want {
				t.Fatalf("restored=%v want %v", got, tc.want)
			}
			if !ps.LastActivityAt.Equal(activity) || ps.Agent != tc.agent || ps.Source != tc.source || ps.ControlMode != tc.mode || len(out) != 0 {
				t.Fatalf("restoration changed activity/ownership or emitted live events: %+v", ps)
			}
			if tc.want {
				if ps.Status != tc.status || !ps.TurnStartedAt.IsZero() {
					t.Fatalf("completed history did not clear busy state: %+v", ps)
				}
			} else if ps.Status != protocol.StatusBusy || !ps.TurnStartedAt.Equal(activity) {
				t.Fatalf("rejected restoration changed lifecycle: %+v", ps)
			}
		})
	}
}
