package session

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/approval"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func newClaudeApprovalV2Manager(t *testing.T) (*SessionManager, chan protocol.DaemonEvent) {
	t.Helper()
	t.Setenv("POCKETCTL_CLAUDE_APPROVAL_V2", "1")
	events := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(events)
	sm.sessions["claude-1"] = &ProcessState{
		SessionID: "claude-1",
		Agent:     adapter.AgentClaude,
		Source:    "daemon",
		Status:    protocol.StatusRunning,
	}
	return sm, events
}

func TestClaudeApprovalRegistryMultiplePending(t *testing.T) {
	sm, events := newClaudeApprovalV2Manager(t)
	sm.handleApprovalRequest(approval.Request{
		RequestID: "req-2", SessionID: "claude-1", Tool: "Write", Input: json.RawMessage(`{"file":"b"}`),
	})
	sm.handleApprovalRequest(approval.Request{
		RequestID: "req-1", SessionID: "claude-1", Tool: "Bash", Input: json.RawMessage(`{"command":"true"}`),
	})
	for range 4 {
		<-events
	}

	snapshot := sm.PendingClaudeApprovals("claude-1")
	if len(snapshot) != 2 {
		t.Fatalf("pending snapshot len=%d want 2", len(snapshot))
	}
	req2Index := -1
	seen := make(map[string]bool, len(snapshot))
	for i, pending := range snapshot {
		seen[pending.RequestID] = true
		if pending.RequestID == "req-2" {
			req2Index = i
		}
	}
	if !seen["req-1"] || !seen["req-2"] || req2Index < 0 {
		t.Fatalf("pending IDs=%v", seen)
	}
	snapshot[req2Index].Input[0] = '['
	again := sm.PendingClaudeApprovals("claude-1")
	for _, pending := range again {
		if pending.RequestID == "req-2" && string(pending.Input) != `{"file":"b"}` {
			t.Fatalf("snapshot mutated registry input: %s", pending.Input)
		}
	}

	approved := true
	sm.handleClaudeApprovalFinished(approval.Finished{
		RequestID: "req-2", SessionID: "claude-1", Approved: &approved, Reason: approval.FinishApproved,
	})
	resolved := <-events
	status := <-events
	if resolved.Type != "approval_resolved" || resolved.RequestID != "req-2" || !resolved.Approved {
		t.Fatalf("unexpected first resolution: %#v", resolved)
	}
	if status.Status != protocol.StatusWaitingApproval {
		t.Fatalf("status after one resolution=%q want waiting_approval", status.Status)
	}
	if pending := sm.PendingClaudeApprovals("claude-1"); len(pending) != 1 || pending[0].RequestID != "req-1" {
		t.Fatalf("remaining pending=%#v", pending)
	}

	sm.handleClaudeApprovalFinished(approval.Finished{
		RequestID: "req-1", SessionID: "claude-1", Reason: approval.FinishTimedOut,
	})
	resolved = <-events
	status = <-events
	if resolved.Reason != string(approval.FinishTimedOut) {
		t.Fatalf("timeout reason=%q", resolved.Reason)
	}
	if status.Status != protocol.StatusRunning {
		t.Fatalf("final status=%q want running", status.Status)
	}
}

func TestClaudeApprovalRegistryDuplicateAndCrossAgentIsolation(t *testing.T) {
	sm, events := newClaudeApprovalV2Manager(t)
	request := approval.Request{RequestID: "req-1", SessionID: "claude-1", Tool: "Bash"}
	sm.handleApprovalRequest(request)
	sm.handleApprovalRequest(request)
	if len(events) != 2 {
		t.Fatalf("duplicate request emitted %d events want 2", len(events))
	}

	sm.sessions["opencode-1"] = &ProcessState{
		SessionID: "opencode-1", Agent: adapter.AgentOpencode, Status: protocol.StatusRunning,
	}
	sm.handleApprovalRequest(approval.Request{RequestID: "collision", SessionID: "opencode-1", Tool: "Bash"})
	if got := sm.PendingClaudeApprovals("opencode-1"); len(got) != 0 {
		t.Fatalf("Claude approval attached to OpenCode session: %#v", got)
	}
}

func TestClaudeApprovalRegistryResolvedElsewhereTombstone(t *testing.T) {
	sm, _ := newClaudeApprovalV2Manager(t)
	sm.handleApprovalRequest(approval.Request{RequestID: "req-1", SessionID: "claude-1", Tool: "Bash"})
	sm.handleClaudeApprovalFinished(approval.Finished{
		RequestID: "req-1", SessionID: "claude-1", Reason: approval.FinishHookDisconnected,
	})

	err := sm.resolveClaudeApproval("claude-1", "req-1", true)
	var resolved *ResolvedElsewhereError
	if !errors.As(err, &resolved) || resolved.RequestID != "req-1" {
		t.Fatalf("late response error=%v want ResolvedElsewhereError", err)
	}
}

func TestClaudeApprovalFlagDefaultsOff(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_APPROVAL_V2", "")
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	if sm.claudeApprovalV2 {
		t.Fatal("Claude approval V2 must remain rollout-gated by default")
	}
}

func TestClaudeApprovalTombstoneExpires(t *testing.T) {
	sm, _ := newClaudeApprovalV2Manager(t)
	key := claudeApprovalKey{sessionID: "claude-1", requestID: "old"}
	sm.claudeApprovalResolved[key] = time.Now().Add(-time.Second)
	sm.mu.Lock()
	sm.pruneClaudeApprovalTombstonesLocked(time.Now())
	sm.mu.Unlock()
	if _, ok := sm.claudeApprovalResolved[key]; ok {
		t.Fatal("expired tombstone was not pruned")
	}
}

func TestClaudeLegacyApprovalTimeoutAndConcurrentRequests(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_APPROVAL_V2", "")
	events := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(events)
	sm.sessions["legacy"] = &ProcessState{SessionID: "legacy", Agent: adapter.AgentClaude, Status: protocol.StatusRunning}
	for _, id := range []string{"first", "second"} {
		sm.handleApprovalRequest(approval.Request{SessionID: "legacy", RequestID: id, Tool: "Bash"})
	}
	for range 4 {
		<-events
	}
	if err := sm.resolveLegacyClaudeApproval("foreign", "first", true); err == nil {
		t.Fatal("foreign session could answer approval")
	}
	sm.handleLegacyApprovalFinished(approval.Finished{SessionID: "legacy", RequestID: "first", Reason: approval.FinishTimedOut})
	if event := <-events; event.Type != "approval_resolved" || event.Reason != "timed_out" || event.Approved {
		t.Fatalf("timeout=%#v", event)
	}
	if event := <-events; event.Status != protocol.StatusWaitingApproval {
		t.Fatalf("remaining request status=%#v", event)
	}
	if snapshot := sm.PendingClaudeApprovals("legacy"); len(snapshot) != 1 || snapshot[0].RequestID != "second" || snapshot[0].Tool != "Bash" {
		t.Fatalf("pending snapshot=%#v", snapshot)
	}
	if got := sm.sessions["legacy"].PendingRequestID; got != "second" {
		t.Fatalf("remaining request=%s", got)
	}
	sm.handleLegacyApprovalFinished(approval.Finished{SessionID: "legacy", RequestID: "first", Reason: approval.FinishTimedOut})
	if len(events) != 0 {
		t.Fatal("duplicate finish emitted events")
	}
	delete(sm.sessions, "legacy")
	sm.handleLegacyApprovalFinished(approval.Finished{SessionID: "legacy", RequestID: "second", Reason: approval.FinishSessionDrained})
	if event := <-events; event.Type != "approval_resolved" || event.RequestID != "second" {
		t.Fatalf("removed session resolution=%#v", event)
	}
	if len(sm.legacyClaudeApprovals) != 0 {
		t.Fatal("pending ledger leaked")
	}
}

func TestClaudeLegacyApprovalReferencesSurviveRestart(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_APPROVAL_V2", "")
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	var saved []ClaudeApprovalReference
	sm.SetClaudeApprovalRecorder(func(refs []ClaudeApprovalReference) error {
		saved = append([]ClaudeApprovalReference(nil), refs...)
		return nil
	})
	sm.handleApprovalRequest(approval.Request{SessionID: "legacy", RequestID: "restart", Tool: "Bash"})
	if len(saved) != 1 || saved[0].SessionID != "legacy" || saved[0].RequestID != "restart" || saved[0].CreatedAt.IsZero() {
		t.Fatalf("restart references=%#v", saved)
	}
	sm.handleLegacyApprovalFinished(approval.Finished{SessionID: "legacy", RequestID: "restart", Reason: approval.FinishHookDisconnected})
	if len(saved) != 0 {
		t.Fatalf("finished request retained=%#v", saved)
	}
}

func TestClaudeApprovalRecorderDetachWaitsForWriter(t *testing.T) {
	t.Setenv("POCKETCTL_CLAUDE_APPROVAL_V2", "")
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	entered, release, requested, detached := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var saved []ClaudeApprovalReference
	sm.SetClaudeApprovalRecorder(func(refs []ClaudeApprovalReference) error {
		close(entered)
		<-release
		saved = append([]ClaudeApprovalReference(nil), refs...)
		return nil
	})
	go func() {
		sm.handleApprovalRequest(approval.Request{SessionID: "legacy", RequestID: "shutdown", Tool: "Bash"})
		close(requested)
	}()
	<-entered
	go func() { sm.SetClaudeApprovalRecorder(nil); close(detached) }()
	early := false
	select {
	case <-detached:
		early = true
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	<-requested
	<-detached
	if early {
		t.Fatal("shutdown detached the recorder before its in-flight reference write completed")
	}
	sm.handleLegacyApprovalFinished(approval.Finished{SessionID: "legacy", RequestID: "shutdown", Reason: approval.FinishServerShutdown})
	if len(saved) != 1 || saved[0].RequestID != "shutdown" {
		t.Fatalf("shutdown lost restart reference: %#v", saved)
	}
}
