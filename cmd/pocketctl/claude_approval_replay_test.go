package main

import (
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
)

func TestClaudeApprovalReconnectReplayFollowsDiscovery(t *testing.T) {
	sessions := []session.SessionInfo{
		{SessionID: "claude-1", Agent: adapter.AgentClaude, Status: protocol.StatusWaitingApproval},
		{SessionID: "codex-1", Agent: adapter.AgentCodex, Status: protocol.StatusRunning},
		{SessionID: "opencode-1", Agent: adapter.AgentOpencode, Status: protocol.StatusRunning},
	}
	calls := make([]string, 0, len(sessions))
	events := reconnectSessionEvents(sessions, func(sessionID string) []protocol.DaemonEvent {
		calls = append(calls, sessionID)
		if sessionID != "claude-1" {
			return nil
		}
		return []protocol.DaemonEvent{{
			Type: "approval_request", SessionID: sessionID, RequestID: "req-1",
		}}
	})

	if len(events) != 4 {
		t.Fatalf("events len=%d want 4", len(events))
	}
	for i, event := range events[:3] {
		if event.Type != "session_discovered" || event.SessionID != sessions[i].SessionID {
			t.Fatalf("discovery[%d]=%#v", i, event)
		}
	}
	if replay := events[3]; replay.Type != "approval_request" || replay.SessionID != "claude-1" || replay.RequestID != "req-1" {
		t.Fatalf("replay=%#v", replay)
	}
	if len(calls) != 3 {
		t.Fatalf("pending callback calls=%v", calls)
	}
}

func TestRecoverClaudeApprovalEventsClosesOrphans(t *testing.T) {
	events := recoverClaudeApprovalEvents(&daemon.ClaudeApprovalState{
		DaemonID: "daemon-1",
		Requests: []daemon.ClaudeApprovalStateItem{
			{SessionID: "claude-1", RequestID: "req-1", CreatedAt: time.Now()},
			{SessionID: "claude-1", RequestID: "req-2", CreatedAt: time.Now()},
		},
	})
	if len(events) != 2 {
		t.Fatalf("events len=%d want 2", len(events))
	}
	for i, event := range events {
		if event.Type != "approval_resolved" || event.Reason != "daemon_restarted" {
			t.Fatalf("event[%d]=%#v", i, event)
		}
		if event.RequestID != "req-"+string(rune('1'+i)) {
			t.Fatalf("event[%d] request=%q", i, event.RequestID)
		}
	}
}

func TestReconnectSessionEventsWithoutClaudeReplayIsUnchanged(t *testing.T) {
	sessions := []session.SessionInfo{
		{SessionID: "codex-1", Agent: adapter.AgentCodex},
		{SessionID: "opencode-1", Agent: adapter.AgentOpencode},
	}
	events := reconnectSessionEvents(sessions, func(string) []protocol.DaemonEvent { return nil })
	if len(events) != len(sessions) {
		t.Fatalf("events len=%d want %d", len(events), len(sessions))
	}
	for _, event := range events {
		if event.Type != "session_discovered" {
			t.Fatalf("non-discovery event added for non-Claude session: %#v", event)
		}
	}
}
