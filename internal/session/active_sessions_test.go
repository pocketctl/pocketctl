package session

import (
	"reflect"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestActiveRootSessionIDsIncludesIdleAndExcludesTerminalStates(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.sessions = map[string]*ProcessState{
		"running-claude": {SessionID: "running-claude", Agent: "claude-code", Status: protocol.StatusRunning},
		"idle-codex":     {SessionID: "idle-codex", Agent: "codex", Status: protocol.StatusIdle, Source: "terminal"},
		"idle-opencode":  {SessionID: "idle-opencode", Agent: "opencode", Status: protocol.StatusIdle, Source: "terminal"},
		"waiting":        {SessionID: "waiting", Status: protocol.StatusWaitingApproval},
		"exited":         {SessionID: "exited", Status: protocol.StatusExited},
		"completed":      {SessionID: "completed", Status: protocol.StatusCompleted},
		"error":          {SessionID: "error", Status: protocol.StatusError},
		"killed":         {SessionID: "killed", Status: protocol.StatusKilled},
	}

	got := sm.ActiveRootSessionIDs()
	want := []string{"idle-codex", "idle-opencode", "running-claude", "waiting"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ActiveRootSessionIDs() = %v, want %v", got, want)
	}
}
