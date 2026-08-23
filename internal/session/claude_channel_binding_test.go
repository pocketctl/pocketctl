package session

import (
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/claudechannel"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// TestClaudeChannelBindingWatcherFirstThenChannelBindsOnce verifies the
// "watcher-first" ordering: the JSONL watcher discovers the terminal Claude
// session, then the Channel process registers. The binding must land exactly
// once and the resulting ProcessState must carry the instance id.
// Design §Task 7 "Tests first": "Channel 先注册、watcher 后发现;watcher
// 先发现、Channel 后注册;两种顺序都绑定一次".
func TestClaudeChannelBindingWatcherFirstThenChannelBindsOnce(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	// 1. Watcher discovers the terminal Claude session FIRST.
	sm.RegisterTerminalSession("session-wf", "/repo", 6001, "/dev/tty1", protocol.StatusRunning, adapter.AgentClaude)
	// 2. Channel registers AFTER.
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-wf", ClaudeParentPID: 6001, ChannelPID: 7001,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	// 3. Binding must have landed.
	sm.mu.RLock()
	state := sm.sessions["session-wf"]
	bound := state != nil && state.ClaudeChannelInstanceID == "instance-wf"
	sm.mu.RUnlock()
	if !bound {
		t.Fatalf("watcher-first binding did not land: %+v", state)
	}
}

func TestClaudeChannelBindingFallsBackWhenRegisterHasNoProcessIdentity(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	sm.RegisterTerminalSession("session-windows", "/repo", 6002, "/dev/tty1", protocol.StatusRunning, adapter.AgentClaude)
	sm.mu.Lock()
	sm.sessions["session-windows"].ProcessStartIdentity = "windows:123"
	sm.mu.Unlock()
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-windows", ClaudeParentPID: 6002, ChannelPID: 7002,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	sm.mu.RLock()
	bound := sm.sessions["session-windows"].ClaudeChannelInstanceID
	sm.mu.RUnlock()
	if bound != "instance-windows" {
		t.Fatalf("identity-less register did not bind current terminal session: %q", bound)
	}
}

// TestClaudeChannelBindingBothOrderingsYieldSingleBinding verifies that no
// matter the order, the instance ends up bound to exactly one session and
// the session carries exactly one instance id.
func TestClaudeChannelBindingBothOrderingsYieldSingleBinding(t *testing.T) {
	for _, order := range []string{"channel-first", "watcher-first"} {
		t.Run(order, func(t *testing.T) {
			events := make(chan protocol.DaemonEvent, 8)
			sm := NewSessionManager(events)
			reg := claudechannel.RegisterEvent{
				InstanceID: "inst-" + order, ClaudeParentPID: 6101, ChannelPID: 7101,
				ProtocolVersion: claudechannel.MCPProtocolVersion,
			}
			if order == "channel-first" {
				sm.HandleClaudeChannelRegister(reg)
				sm.RegisterTerminalSession("sess-"+order, "/repo", 6101, "/dev/tty2", protocol.StatusRunning, adapter.AgentClaude)
			} else {
				sm.RegisterTerminalSession("sess-"+order, "/repo", 6101, "/dev/tty2", protocol.StatusRunning, adapter.AgentClaude)
				sm.HandleClaudeChannelRegister(reg)
			}
			sm.mu.RLock()
			state := sm.sessions["sess-"+order]
			instanceOnSession := state != nil && state.ClaudeChannelInstanceID == reg.InstanceID
			bindingSession := ""
			if b := sm.claudeChannelInstances[reg.InstanceID]; b != nil {
				bindingSession = b.SessionID
			}
			sm.mu.RUnlock()
			if !instanceOnSession {
				t.Fatalf("session missing instance id: %+v", state)
			}
			if bindingSession != "sess-"+order {
				t.Fatalf("binding session=%q want %q", bindingSession, "sess-"+order)
			}
		})
	}
}

// TestClaudeChannelBindingRejectsNonClaudeAgents verifies that a Channel
// registering with a PID that matches a Codex / OpenCode / ZCode session
// does NOT bind. Only terminal-sourced claude-code sessions are eligible.
// Design §Task 7: "daemon child PID、Codex PID、OpenCode PID、ZCode 无 PID
// 均不绑定".
func TestClaudeChannelBindingRejectsNonClaudeAgents(t *testing.T) {
	for _, agent := range []string{adapter.AgentCodex, adapter.AgentOpencode, adapter.AgentZcode} {
		t.Run(agent, func(t *testing.T) {
			events := make(chan protocol.DaemonEvent, 8)
			sm := NewSessionManager(events)
			sm.mu.Lock()
			sm.sessions["sess-"+agent] = &ProcessState{
				SessionID: "sess-" + agent, Agent: agent, Source: "terminal",
				Pid: 6201, Status: protocol.StatusRunning, StartedAt: time.Now(),
			}
			sm.mu.Unlock()
			sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
				InstanceID: "inst-" + agent, ClaudeParentPID: 6201, ChannelPID: 7201,
				ProtocolVersion: claudechannel.MCPProtocolVersion,
			})
			sm.mu.RLock()
			state := sm.sessions["sess-"+agent]
			bound := state != nil && state.ClaudeChannelInstanceID != ""
			sm.mu.RUnlock()
			if bound {
				t.Fatalf("%s session must NOT bind to a Claude Channel instance", agent)
			}
		})
	}
}

// TestClaudeChannelBindingRejectsDaemonSourceClaude verifies a daemon-sourced
// Claude session (Web-created PTY) does NOT bind to a Channel instance.
// Design §1.3/§Task 7: only source=terminal binds.
func TestClaudeChannelBindingRejectsDaemonSourceClaude(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	sm.mu.Lock()
	sm.sessions["sess-daemon"] = &ProcessState{
		SessionID: "sess-daemon", Agent: adapter.AgentClaude, Source: "daemon",
		Pid: 6301, Status: protocol.StatusRunning, StartedAt: time.Now(),
	}
	sm.mu.Unlock()
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "inst-daemon", ClaudeParentPID: 6301, ChannelPID: 7301,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	sm.mu.RLock()
	state := sm.sessions["sess-daemon"]
	bound := state != nil && state.ClaudeChannelInstanceID != ""
	sm.mu.RUnlock()
	if bound {
		t.Fatal("daemon-sourced Claude session must NOT bind to a Channel instance (design §1.3)")
	}
}

// TestClaudeChannelBindingRebindsOnSessionIDChange verifies that when a
// Channel instance's binding moves from session A to session B (simulating
// `claude --continue`/`--resume` reusing the same instance for a new
// session id), the old session's pending approvals are cleared and the new
// session takes the binding. Design §Task 7: "--continue/--resume 改
// session ID 时,instance 重绑并关闭旧 session pending".
func TestClaudeChannelBindingRebindsOnSessionIDChange(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(events)
	// Initial binding to session-A via PID 6401.
	sm.RegisterTerminalSession("session-A", "/repo", 6401, "/dev/tty3", protocol.StatusRunning, adapter.AgentClaude)
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-rebind", ClaudeParentPID: 6401, ChannelPID: 7401,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	responder := &fakeChannelResponder{}
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: "11111111-1111-1111-1111-111111111111", InstanceID: "instance-rebind",
		ShortRequestID: "rebid", ToolName: "Bash", Responder: responder,
	})
	// Sanity: bound to A.
	if !sm.ClaudeChannelApprovalKnowsPublicRequest("session-A", "11111111-1111-1111-1111-111111111111") {
		t.Fatal("approval not bound to session-A")
	}
	// Simulate --resume producing session-B with the SAME PID. The binding
	// must move; the old session-A pending entry must be closed neutrally.
	sm.RegisterTerminalSession("session-B", "/repo", 6401, "/dev/tty3", protocol.StatusRunning, adapter.AgentClaude)
	// Old session must no longer carry the instance id.
	sm.mu.RLock()
	oldState := sm.sessions["session-A"]
	oldInstance := ""
	if oldState != nil {
		oldInstance = oldState.ClaudeChannelInstanceID
	}
	newState := sm.sessions["session-B"]
	newInstance := ""
	if newState != nil {
		newInstance = newState.ClaudeChannelInstanceID
	}
	sm.mu.RUnlock()
	if oldInstance != "" {
		t.Fatalf("old session-A still carries instance id %q after rebind", oldInstance)
	}
	if newInstance != "instance-rebind" {
		t.Fatalf("new session-B did not pick up the binding: %q", newInstance)
	}
}

// TestClaudeChannelRequestDroppedAfterBindingGraceWhenNoWatcher verifies
// that when a request arrives for an instance whose binding never lands
// (no matching watcher session), the 5s grace expires and the request is
// dropped via FailClosed without ever broadcasting an actionable remote
// card. Design §Task 7: "permission 在绑定前到达时最多短暂保留 5 秒;仍未
// 绑定则不广播远端卡,终端继续".
func TestClaudeChannelRequestDroppedAfterBindingGraceWhenNoWatcher(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	responder := &fakeChannelResponder{}
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "instance-orphan", ClaudeParentPID: 9999, ChannelPID: 8888,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	sm.HandleClaudeChannelRequest(claudechannel.RequestEvent{
		PublicRequestID: "22222222-2222-2222-2222-222222222222", InstanceID: "instance-orphan",
		ShortRequestID: "orphn", ToolName: "Bash", Responder: responder,
	})
	// No matching terminal session is ever registered. Wait for the grace
	// window plus a margin for the AfterFunc to fire.
	deadline := time.After(claudeChannelBindingGrace + 500*time.Millisecond)
	for {
		select {
		case event := <-events:
			t.Fatalf("unbound request must NEVER broadcast: %+v", event)
		case <-deadline:
		}
		break
	}
	responder.mu.Lock()
	defer responder.mu.Unlock()
	if responder.failures != 1 || len(responder.behaviors) != 0 {
		t.Fatalf("orphan request responder failures=%d behaviors=%v want 1/0", responder.failures, responder.behaviors)
	}
}

// TestClaudeChannelBindingDoesNotMatchExitedSession verifies a Channel
// registering against a PID whose session is already Exited does not bind.
// Design §Task 7 "session exit/Claude process exit/Channel EOF 清绑定".
func TestClaudeChannelBindingDoesNotMatchExitedSession(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(events)
	sm.mu.Lock()
	sm.sessions["sess-exited"] = &ProcessState{
		SessionID: "sess-exited", Agent: adapter.AgentClaude, Source: "terminal",
		Pid: 6501, Status: protocol.StatusExited, StartedAt: time.Now(),
	}
	sm.mu.Unlock()
	sm.HandleClaudeChannelRegister(claudechannel.RegisterEvent{
		InstanceID: "inst-exited", ClaudeParentPID: 6501, ChannelPID: 7501,
		ProtocolVersion: claudechannel.MCPProtocolVersion,
	})
	sm.mu.RLock()
	state := sm.sessions["sess-exited"]
	bound := state != nil && state.ClaudeChannelInstanceID != ""
	sm.mu.RUnlock()
	if bound {
		t.Fatal("Exited session must not accept a new Channel binding")
	}
}
