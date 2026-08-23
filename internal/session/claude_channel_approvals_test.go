package session

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/claudechannel"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type fakeChannelResponder struct {
	mu        sync.Mutex
	behaviors []string
	failures  int
	err       error
}

func (f *fakeChannelResponder) Send(behavior string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.behaviors = append(f.behaviors, behavior)
	return f.err
}

func (f *fakeChannelResponder) FailClosed() {
	f.mu.Lock()
	f.failures++
	f.mu.Unlock()
}

func TestClaudeChannelApprovalFirstWriterWins(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(events)
	sm.RegisterTerminalSession("session-1", "/repo", 1111, "/dev/tty1", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-1", ClaudeParentPID: 1111, ChannelPID: 2222,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{}
	publicID := "d9428888-122b-11e1-b85c-61cd3cbb3210"
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: publicID, InstanceID: "instance-1", ShortRequestID: "abcde",
		ToolName: "Bash", Description: "run command", InputPreview: "echo ok", Responder: responder,
	})

	results := make(chan error, 2)
	go func() { results <- sm.ResolveApprovalAction("session-1", publicID, "once") }()
	go func() { results <- sm.ResolveApprovalAction("session-1", publicID, "reject") }()
	first, second := <-results, <-results
	resolvedElsewhere := 0
	for _, err := range []error{first, second} {
		var resolved *ResolvedElsewhereError
		if errors.As(err, &resolved) {
			resolvedElsewhere++
		} else if err != nil {
			t.Fatalf("unexpected resolution error: %v", err)
		}
	}
	if resolvedElsewhere != 1 {
		t.Fatalf("resolved_elsewhere results=%d want 1", resolvedElsewhere)
	}
	responder.mu.Lock()
	defer responder.mu.Unlock()
	if len(responder.behaviors) != 1 {
		t.Fatalf("verdict writes=%v want exactly one", responder.behaviors)
	}
	assertClaudeChannelResolutionEvents(t, events, publicID, "submitted", "claude_result_unconfirmed")
}

func TestClaudeChannelApprovalIsJournaledBeforeBroadcast(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	persisted := false
	sm.SetClaudeApprovalRecorder(func(refs []ClaudeApprovalReference) error {
		persisted = len(refs) == 1 && refs[0].SessionID == "session-journal"
		return nil
	})
	sm.RegisterTerminalSession("session-journal", "/repo", 7101, "/dev/tty8", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-journal", ClaudeParentPID: 7101, ChannelPID: 8101,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: "573cca55-bd7e-4af0-840d-dc0288d12519", InstanceID: "instance-journal",
		ShortRequestID: "abcjk", ToolName: "Bash", Responder: &fakeChannelResponder{},
	})
	if !persisted {
		t.Fatal("Channel request was not persisted before Handle returned")
	}
	event := <-events
	if event.Type != "approval_request" {
		t.Fatalf("first broadcast=%+v", event)
	}
}

func TestClaudeChannelApprovalPersistenceFailureNeverBroadcasts(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	sm.SetClaudeApprovalRecorder(func([]ClaudeApprovalReference) error { return errors.New("disk full") })
	sm.RegisterTerminalSession("session-journal-fail", "/repo", 7102, "/dev/tty9", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-journal-fail", ClaudeParentPID: 7102, ChannelPID: 8102,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{}
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: "73028d86-ed85-44db-ab0f-f9117ae59e10", InstanceID: "instance-journal-fail",
		ShortRequestID: "abcjm", ToolName: "Edit", Responder: responder,
	})
	select {
	case event := <-events:
		t.Fatalf("unpersisted request was broadcast: %+v", event)
	case <-time.After(30 * time.Millisecond):
	}
	responder.mu.Lock()
	defer responder.mu.Unlock()
	if responder.failures != 1 || len(responder.behaviors) != 0 {
		t.Fatalf("persistence failure responder=%+v", responder)
	}
}

func TestClaudeApprovalJournalConcurrentWritesEndWithLatestRegistry(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(events)
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	var writesMu sync.Mutex
	var writes [][]ClaudeApprovalReference
	calls := 0
	sm.SetClaudeApprovalRecorder(func(refs []ClaudeApprovalReference) error {
		calls++
		if calls == 1 {
			close(firstEntered)
			<-releaseFirst
		}
		writesMu.Lock()
		writes = append(writes, append([]ClaudeApprovalReference(nil), refs...))
		writesMu.Unlock()
		return nil
	})
	sm.RegisterTerminalSession("session-order", "/repo", 7103, "/dev/tty10", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-order", ClaudeParentPID: 7103, ChannelPID: 8103,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})

	done1 := make(chan struct{})
	go func() {
		sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
			PublicRequestID: "bf7c2aa9-5fa2-4204-960a-158c57ca2d47", InstanceID: "instance-order",
			ShortRequestID: "abcjo", ToolName: "Bash", Responder: &fakeChannelResponder{},
		})
		close(done1)
	}()
	<-firstEntered
	done2 := make(chan struct{})
	go func() {
		sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
			PublicRequestID: "dc0cdd91-1569-4c13-9710-ecfad9554ae4", InstanceID: "instance-order",
			ShortRequestID: "abcjp", ToolName: "Edit", Responder: &fakeChannelResponder{},
		})
		close(done2)
	}()
	secondKey := ClaudeChannelApprovalKey{InstanceID: "instance-order", ClaudeRequestID: "abcjp"}
	secondRegistered := false
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		sm.mu.RLock()
		_, secondRegistered = sm.claudeChannelApprovals[secondKey]
		sm.mu.RUnlock()
		if secondRegistered {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !secondRegistered {
		close(releaseFirst)
		t.Fatal("second request did not enter registry before first journal write was released")
	}
	close(releaseFirst)
	select {
	case <-done1:
	case <-time.After(time.Second):
		t.Fatal("first persistence did not complete")
	}
	select {
	case <-done2:
	case <-time.After(time.Second):
		t.Fatal("second persistence did not complete")
	}
	writesMu.Lock()
	defer writesMu.Unlock()
	if len(writes) != 2 || len(writes[len(writes)-1]) != 2 {
		t.Fatalf("journal writes=%+v, final snapshot must contain both requests", writes)
	}
}

func TestClaudeChannelBindingRejectsPIDReuseIdentityMismatch(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	sm.mu.Lock()
	sm.sessions["stale-session"] = &ProcessState{
		SessionID: "stale-session", Agent: adapter.AgentClaude, Source: "terminal",
		Pid: 7201, Status: protocol.StatusRunning, StartedAt: time.Now(),
		ProcessStartIdentity: "darwin:old",
	}
	sm.mu.Unlock()
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-reused", ClaudeParentPID: 7201, ChannelPID: 8201,
		ProtocolVersion: claudechannel.MCPProtocolVersion, ProcessStartIdentity: "darwin:new",
	})
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: "41e4567a-003f-404b-8ee6-1065f71241d9", InstanceID: "instance-reused",
		ShortRequestID: "abcjn", ToolName: "Bash", Responder: &fakeChannelResponder{},
	})
	select {
	case event := <-events:
		t.Fatalf("PID-reused request leaked to stale session: %+v", event)
	case <-time.After(30 * time.Millisecond):
	}
}

func assertClaudeChannelResolutionEvents(t *testing.T, events <-chan protocol.DaemonEvent, requestID, status, reason string) {
	t.Helper()
	foundResult := false
	foundClosed := false
	deadline := time.After(time.Second)
	for !foundResult || !foundClosed {
		select {
		case event := <-events:
			if event.RequestID != requestID {
				continue
			}
			switch event.Type {
			case "interaction_result":
				foundResult = event.Status == status && event.Reason == reason
			case "approval_resolved":
				foundClosed = event.Reason == reason && !event.Approved && event.Action == ""
			}
		case <-deadline:
			t.Fatalf("missing resolution events for %s: interaction=%v closed=%v", requestID, foundResult, foundClosed)
		}
	}
}

func TestClaudeChannelRequestBeforeBindingPublishesAfterWatcher(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	responder := &fakeChannelResponder{}
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-2", ClaudeParentPID: 3333, ChannelPID: 4444,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		InstanceID:      "instance-2", ShortRequestID: "fghij", ToolName: "Edit",
		Description: "edit file", InputPreview: "file.go", Responder: responder,
	})
	select {
	case event := <-events:
		t.Fatalf("unbound request leaked to clients: %+v", event)
	case <-time.After(30 * time.Millisecond):
	}
	sm.RegisterTerminalSession("session-2", "/repo", 3333, "/dev/tty2", protocol.StatusRunning, adapter.AgentClaude)
	select {
	case event := <-events:
		if event.Type != "approval_request" || event.SessionID != "session-2" || event.ApprovalKind != "claude_channel" {
			t.Fatalf("unexpected bound event: %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("binding did not publish retained request")
	}
}

func TestClaudeChannelApprovalRejectsUnsupportedAndCrossSessionActions(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(events)
	sm.RegisterTerminalSession("session-a", "/repo/a", 5101, "/dev/tty1", protocol.StatusRunning, adapter.AgentClaude)
	sm.RegisterTerminalSession("session-b", "/repo/b", 5102, "/dev/tty2", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-a", ClaudeParentPID: 5101, ChannelPID: 6101,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{}
	publicID := "73d16cc4-184b-4f78-9cac-f351f633d8b5"
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: publicID, InstanceID: "instance-a", ShortRequestID: "abcdf",
		ToolName: "Bash", Responder: responder,
	})

	if err := sm.ResolveApprovalAction("session-a", publicID, "always"); err == nil {
		t.Fatal("always must be rejected for Claude Channel")
	}
	if err := sm.ResolveApprovalAction("session-b", publicID, "once"); err == nil {
		t.Fatal("cross-session approval must be rejected")
	}
	responder.mu.Lock()
	defer responder.mu.Unlock()
	if len(responder.behaviors) != 0 {
		t.Fatalf("invalid actions wrote verdicts: %v", responder.behaviors)
	}
}

func TestClaudeChannelApprovalWriteFailureClosesNeutralAndNeverReplays(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(events)
	sm.RegisterTerminalSession("session-fail", "/repo", 5201, "/dev/tty3", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-fail", ClaudeParentPID: 5201, ChannelPID: 6201,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{err: errors.New("short write")}
	publicID := "ef6bf42e-d68e-489b-8fd4-a8de43809d31"
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: publicID, InstanceID: "instance-fail", ShortRequestID: "abcfg",
		ToolName: "Edit", Responder: responder,
	})
	if err := sm.ResolveApprovalAction("session-fail", publicID, "reject"); err != nil {
		t.Fatalf("write failure should converge through events, got %v", err)
	}
	assertClaudeChannelResolutionEvents(t, events, publicID, ClaudeChannelApprovalResultUnknown, "channel_write_failed")
	if replay := sm.PendingClaudeChannelApprovals("session-fail"); len(replay) != 0 {
		t.Fatalf("result_unknown approval replayed as actionable: %+v", replay)
	}
}

func TestClaudeChannelSameShortIDIsIsolatedByInstanceAndSession(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 24)
	sm := NewSessionManager(events)
	for i, item := range []struct {
		session, instance, public string
		pid                       int
	}{
		{"session-one", "instance-one", "0380c528-7a57-423c-bdb9-034dc785034a", 5301},
		{"session-two", "instance-two", "376fdb50-fb20-4263-8f50-696089c9969a", 5302},
	} {
		sm.RegisterTerminalSession(item.session, "/repo", item.pid, fmt.Sprintf("/dev/tty%d", i+4), protocol.StatusRunning, adapter.AgentClaude)
		sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
			InstanceID: item.instance, ClaudeParentPID: item.pid, ChannelPID: item.pid + 1000,
			ProtocolVersion: claudechannel.MCPProtocolVersion,
		})
		sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
			PublicRequestID: item.public, InstanceID: item.instance, ShortRequestID: "abcgh",
			ToolName: "Bash", Responder: &fakeChannelResponder{},
		})
		if !sm.ClaudeChannelApprovalKnowsPublicRequest(item.session, item.public) {
			t.Fatalf("approval %d was not bound to its session", i)
		}
	}
}

func TestClaudeChannelDisconnectClosesPendingWithoutDecision(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(events)
	sm.RegisterTerminalSession("session-disconnect", "/repo", 5401, "/dev/tty6", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-disconnect", ClaudeParentPID: 5401, ChannelPID: 6401,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{}
	publicID := "ac815060-30b2-44b1-936a-dce32376d0d2"
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: publicID, InstanceID: "instance-disconnect", ShortRequestID: "abcgi",
		ToolName: "Bash", Responder: responder,
	})
	sm.HandleClaudeChannelDisconnect("instance-disconnect", "channel_disconnected")

	for {
		select {
		case event := <-events:
			if event.Type == "approval_resolved" && event.RequestID == publicID {
				if event.Reason != "channel_disconnected" || event.Approved || event.Action != "" {
					t.Fatalf("disconnect was not neutral: %+v", event)
				}
				responder.mu.Lock()
				defer responder.mu.Unlock()
				if responder.failures != 1 || len(responder.behaviors) != 0 {
					t.Fatalf("disconnect responder state failures=%d behaviors=%v", responder.failures, responder.behaviors)
				}
				return
			}
		case <-time.After(time.Second):
			t.Fatal("disconnect did not close pending approval")
		}
	}
}

func TestClaudeChannelSessionExitClosesPendingWithoutDecision(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(events)
	sm.RegisterTerminalSession("session-exit", "/repo", 5501, "/dev/tty7", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-exit", ClaudeParentPID: 5501, ChannelPID: 6501,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{}
	publicID := "165e4b49-a094-4609-a55d-c2ce78523259"
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: publicID, InstanceID: "instance-exit", ShortRequestID: "abcgj",
		ToolName: "Bash", Responder: responder,
	})
	sm.SetSessionExited("session-exit", "process_exit")

	for {
		select {
		case event := <-events:
			if event.Type == "approval_resolved" && event.RequestID == publicID {
				if event.Reason != "session_ended" || event.Approved || event.Action != "" {
					t.Fatalf("session exit was not neutral: %+v", event)
				}
				return
			}
		case <-time.After(time.Second):
			t.Fatal("session exit did not close pending approval")
		}
	}
}

// TestClaudeChannelApprovalObservedClosesSubmittedNeutrally verifies the
// claude_progress_observed transition. After a verdict is submitted, an
// observed tool execution emits a neutral approval_resolved without
// approved/action. Design §2.1/§2.2.
func TestClaudeChannelApprovalObservedClosesSubmittedNeutrally(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(events)
	sm.RegisterTerminalSession("session-obs", "/repo", 5601, "/dev/tty8", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-obs", ClaudeParentPID: 5601, ChannelPID: 6601,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{}
	publicID := "76abc842-18d4-4b78-8853-1a1e6f5c1a07"
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: publicID, InstanceID: "instance-obs", ShortRequestID: "abcob",
		ToolName: "Bash", Responder: responder,
	})
	if err := sm.ResolveApprovalAction("session-obs", publicID, "once"); err != nil {
		t.Fatal(err)
	}
	// Drain the submitted interaction_result + neutral approval_resolved.
	foundSubmitted := false
	for !foundSubmitted {
		select {
		case event := <-events:
			if event.Type == "interaction_result" && event.RequestID == publicID && event.Status == "submitted" {
				foundSubmitted = true
			}
		case <-time.After(time.Second):
			t.Fatal("submitted interaction_result never arrived")
		}
	}
	// JSONL tailer observes tool execution. The card must close neutrally.
	sm.MarkClaudeChannelApprovalObserved("session-obs", publicID)
	for {
		select {
		case event := <-events:
			if event.Type == "approval_resolved" && event.RequestID == publicID {
				if event.Reason != "claude_progress_observed" {
					continue
				}
				if event.Approved || event.Action != "" {
					t.Fatalf("observed close must NOT set approved/action: %+v", event)
				}
				return
			}
		case <-time.After(time.Second):
			t.Fatal("claude_progress_observed never arrived")
		}
	}
}

// TestClaudeChannelApprovalObservedIgnoredForPending verifies observation
// cannot close a pending approval — only submitted ones. A pending approval
// is still actionable and must not be dismissed by observation alone.
func TestClaudeChannelApprovalObservedIgnoredForPending(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	sm.RegisterTerminalSession("session-pend", "/repo", 5701, "/dev/tty9", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-pend", ClaudeParentPID: 5701, ChannelPID: 6701,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{}
	publicID := "87bcd953-29e5-4c89-9964-2b2f706d2b18"
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: publicID, InstanceID: "instance-pend", ShortRequestID: "abcpd",
		ToolName: "Bash", Responder: responder,
	})
	// Drain the broadcast approval_request + session_status so they don't
	// satisfy the select below.
	<-events
	<-events
	sm.MarkClaudeChannelApprovalObserved("session-pend", publicID)
	select {
	case event := <-events:
		t.Fatalf("observation must not close a pending approval: %+v", event)
	case <-time.After(80 * time.Millisecond):
	}
	if !sm.ClaudeChannelApprovalKnowsPublicRequest("session-pend", publicID) {
		t.Fatal("pending approval was dropped by observation")
	}
}
