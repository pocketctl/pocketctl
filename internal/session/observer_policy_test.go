package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

type observerDriveBackendSpy struct {
	starts     int
	sends      int
	interrupts int
	closes     int
}

func (b *observerDriveBackendSpy) Start(context.Context, protocol.SessionConfig) (string, error) {
	b.starts++
	return "unexpected", nil
}

func (b *observerDriveBackendSpy) Send(context.Context, string, string) error {
	b.sends++
	return nil
}

func (b *observerDriveBackendSpy) SendWithContext(context.Context, string, string, *memorycontext.PreparedContext) error {
	b.sends++
	return nil
}

func (b *observerDriveBackendSpy) Interrupt(string) error {
	b.interrupts++
	return nil
}

func (b *observerDriveBackendSpy) Close(string) error {
	b.closes++
	return nil
}

type observerDrivePTYSpy struct {
	bytes.Buffer
	writes int
}

func (p *observerDrivePTYSpy) Write(data []byte) (int, error) {
	p.writes++
	return p.Buffer.Write(data)
}

func (*observerDrivePTYSpy) Close() error                    { return nil }
func (*observerDrivePTYSpy) SetSize(rows, cols uint16) error { return nil }

type observerAbortProcessSpy struct {
	alive      bool
	terminates int
	kills      int
}

func (p *observerAbortProcessSpy) IsAlive(int) bool { return p.alive }
func (p *observerAbortProcessSpy) Terminate(int) error {
	p.terminates++
	return nil
}
func (p *observerAbortProcessSpy) Kill(int) error {
	p.kills++
	return nil
}

func observerPolicyManager(agent string) (*SessionManager, *ProcessState, *observerDriveBackendSpy, *observerDrivePTYSpy) {
	backend := &observerDriveBackendSpy{}
	pty := &observerDrivePTYSpy{}
	lastActivity := time.Date(2026, 9, 4, 9, 8, 7, 0, time.UTC)
	state := &ProcessState{
		SessionID:        "observer-session",
		Agent:            agent,
		Source:           "daemon", // forged writable-looking metadata must not grant control
		ControlMode:      protocol.ControlManaged,
		Backend:          backend,
		PTY:              pty,
		Pid:              os.Getpid(),
		Status:           protocol.StatusIdle,
		LastActivityAt:   lastActivity,
		Effort:           "medium",
		CurrentAgent:     "build",
		PendingRequestID: "approval-1",
		Permission: &protocol.PermissionConfig{
			Agent: adapter.AgentCodex, Preset: "custom", ApprovalPolicy: "never", SandboxMode: "read-only",
		},
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	sm.sessions[state.SessionID] = state
	return sm, state, backend, pty
}

func assertObserverReadOnly(t *testing.T, sessionID string, err error) {
	t.Helper()
	if !errors.Is(err, adapter.ErrObserverReadOnly) {
		t.Errorf("error = %v, want ErrObserverReadOnly", err)
	}
	if err == nil || !strings.Contains(err.Error(), sessionID) {
		t.Errorf("error = %v, want session_id %q", err, sessionID)
	}
}

func assertNoObserverTurn(t *testing.T, sm *SessionManager, sessionID string) {
	t.Helper()
	key := turn.ActorKey{SessionID: sessionID}
	if active, ok := sm.turns.Active(key); ok {
		t.Errorf("observer reserved active turn: %+v", active)
	}
	if last, ok := sm.turns.Last(key); ok {
		t.Errorf("observer persisted terminal turn: %+v", last)
	}
}

func waitObserverDriveGate(t *testing.T, gate *observerDriveGate, predicate func(*observerDriveGate) bool) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		gate.mu.Lock()
		defer gate.mu.Unlock()
		for !predicate(gate) {
			gate.changed.Wait()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for observer drive-gate barrier")
	}
}

func TestObserverPolicyCodexDesktopRejectsCreateBeforeAnySideEffect(t *testing.T) {
	var cliCalls, opencodeCalls, codexCalls int
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) {
		cliCalls++
		return "/unexpected/cli", nil
	}
	sm.createDeps.startOpencode = func(*SessionManager, context.Context, protocol.SessionConfig) (string, error) {
		opencodeCalls++
		return "unexpected", nil
	}
	sm.createDeps.startCodexManaged = func(*SessionManager, context.Context, protocol.SessionConfig, string, string, string, string, string) (string, bool, error) {
		codexCalls++
		return "unexpected", true, nil
	}

	missing := filepath.Join(t.TempDir(), "must-not-exist")
	_, err := sm.CreateSession(context.Background(), protocol.SessionConfig{
		Agent: adapter.AgentCodexDesktop, Cwd: missing, Worktree: true, AutoCreateDir: true,
	})
	if !errors.Is(err, adapter.ErrObserverReadOnly) {
		t.Errorf("CreateSession error = %v, want ErrObserverReadOnly", err)
	}
	if cliCalls != 0 || opencodeCalls != 0 || codexCalls != 0 {
		t.Errorf("observer create side effects: cli=%d opencode=%d codex=%d", cliCalls, opencodeCalls, codexCalls)
	}
	if _, statErr := os.Stat(missing); !os.IsNotExist(statErr) {
		t.Errorf("observer create touched cwd %q: %v", missing, statErr)
	}
}

func TestObserverPolicyAbortSessionRejectsBeforeDeletingOrCanceling(t *testing.T) {
	const sessionID = "pending-desktop-observer"
	cancelCalls := 0
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm.sessions[sessionID] = &ProcessState{
		SessionID: sessionID,
		Agent:     adapter.AgentCodexDesktop,
		Source:    "daemon",
		Status:    protocol.StatusRunning,
		Cancel:    func() { cancelCalls++ },
	}

	if aborted := sm.AbortSession(sessionID); aborted {
		t.Fatal("AbortSession reported success for Desktop observer")
	}
	if cancelCalls != 0 {
		t.Fatalf("AbortSession invoked observer cancel %d time(s)", cancelCalls)
	}
	if state := sm.sessions[sessionID]; state == nil {
		t.Fatal("AbortSession deleted observer pending state")
	}
}

func TestObserverPolicyAbortSessionWithErrorProtectsObserverAndKeepsManagedAbort(t *testing.T) {
	t.Run("observer", func(t *testing.T) {
		const sessionID = "pending-desktop-observer-checked"
		cancelCalls := 0
		proc := &observerAbortProcessSpy{alive: true}
		sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
		sm.proc = proc
		sm.sessions[sessionID] = &ProcessState{
			SessionID: sessionID, Agent: adapter.AgentCodexDesktop, Source: "daemon",
			Status: protocol.StatusRunning, Cancel: func() { cancelCalls++ },
			Cmd: &exec.Cmd{Process: &os.Process{Pid: 424242}},
		}
		sm.childPids[424242] = true

		aborted, err := sm.AbortSessionWithError(sessionID)
		assertObserverReadOnly(t, sessionID, err)
		if aborted || cancelCalls != 0 || proc.kills != 0 {
			t.Fatalf("observer abort side effects: aborted=%v cancel=%d kills=%d", aborted, cancelCalls, proc.kills)
		}
		if sm.sessions[sessionID] == nil || !sm.childPids[424242] {
			t.Fatal("observer abort removed pending session/process ownership")
		}
	})

	t.Run("managed", func(t *testing.T) {
		const sessionID = "pending-managed-codex"
		cancelCalls := 0
		proc := &observerAbortProcessSpy{alive: true}
		sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
		sm.proc = proc
		sm.sessions[sessionID] = &ProcessState{
			SessionID: sessionID, Agent: adapter.AgentCodex, Source: "daemon",
			ControlMode: protocol.ControlManaged, Status: protocol.StatusRunning,
			Cancel: func() { cancelCalls++ }, Cmd: &exec.Cmd{Process: &os.Process{Pid: 434343}},
		}
		sm.childPids[434343] = true

		aborted, err := sm.AbortSessionWithError(sessionID)
		if err != nil || !aborted {
			t.Fatalf("managed AbortSessionWithError=(%v,%v), want (true,nil)", aborted, err)
		}
		if cancelCalls != 1 || proc.kills != 1 {
			t.Fatalf("managed abort side effects: cancel=%d kills=%d", cancelCalls, proc.kills)
		}
		if sm.sessions[sessionID] != nil || sm.childPids[434343] {
			t.Fatal("managed abort did not clean pending session/process ownership")
		}
	})
}

func TestObserverPolicyAbortPendingClassificationWinsBeforeCancelDeleteOrKill(t *testing.T) {
	const sessionID = "pending-racing-observer"
	cancelCalls := 0
	proc := &observerAbortProcessSpy{alive: true}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm.proc = proc
	sm.sessions[sessionID] = &ProcessState{
		SessionID: sessionID, Agent: adapter.AgentCodex, Source: "terminal",
		Status: protocol.StatusRunning, Cancel: func() { cancelCalls++ },
		Cmd: &exec.Cmd{Process: &os.Process{Pid: 454545}},
	}
	sm.childPids[454545] = true
	_, release, err := sm.acquireObserverDrive(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	gate := sm.observerDriveGateFor(sessionID)
	classified := make(chan ObservedSessionRegistration, 1)
	go func() {
		classified <- sm.RegisterObservedSession(sessionID, "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop)
	}()
	waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.classificationPending })
	aborted := make(chan struct {
		ok  bool
		err error
	}, 1)
	go func() {
		ok, abortErr := sm.AbortSessionWithError(sessionID)
		aborted <- struct {
			ok  bool
			err error
		}{ok: ok, err: abortErr}
	}()
	waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.waitingDrives > 0 })
	release()
	if result := <-classified; result != ObservedSessionReclassified {
		t.Fatalf("classification result=%v", result)
	}
	result := <-aborted
	assertObserverReadOnly(t, sessionID, result.err)
	if result.ok || cancelCalls != 0 || proc.kills != 0 {
		t.Fatalf("racing observer abort side effects: aborted=%v cancel=%d kills=%d", result.ok, cancelCalls, proc.kills)
	}
	if sm.sessions[sessionID] == nil || !sm.childPids[454545] {
		t.Fatal("racing observer abort removed session/process ownership")
	}
}

func TestObserverDriveGatePendingClassificationWinsBeforeQueuedWrites(t *testing.T) {
	for _, mode := range []string{"backend", "pty", "resume process"} {
		t.Run(mode, func(t *testing.T) {
			sm, state, backend, pty := observerPolicyManager(adapter.AgentCodex)
			sm.turnMode = turnEnrichmentObserve
			state.Source = "terminal"
			state.ControlMode = protocol.ControlLegacyReadOnly
			resumeCalls := 0
			if mode == "pty" {
				state.Backend = nil
				state.Source = "daemon"
				state.Pid = os.Getpid()
			} else if mode == "resume process" {
				state.Backend = nil
				state.PTY = nil
				state.Status = protocol.StatusExited
				state.Pid = 0
				sm.setResumeStarter(func(context.Context, resumeLaunchSpec) (resumeProcess, error) {
					resumeCalls++
					return nil, errors.New("unexpected resume")
				})
			}

			_, release, err := sm.acquireObserverDrive(context.Background(), state.SessionID)
			if err != nil {
				t.Fatal(err)
			}
			released := false
			t.Cleanup(func() {
				if !released {
					release()
				}
			})
			gate := sm.observerDriveGateFor(state.SessionID)
			classified := make(chan ObservedSessionRegistration, 1)
			go func() {
				classified <- sm.RegisterObservedSession(
					state.SessionID, "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop,
				)
			}()
			waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.classificationPending })

			sendResult := make(chan error, 1)
			go func() {
				sendResult <- sm.SendMessageWithInput(context.Background(), UserMessageInput{
					SessionID: state.SessionID, Content: "must lose to pending classification", RequestID: "race-write",
				})
			}()
			waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.waitingDrives > 0 })

			release()
			released = true
			if result := <-classified; result != ObservedSessionReclassified {
				t.Fatalf("classification result=%v, want reclassified", result)
			}
			assertObserverReadOnly(t, state.SessionID, <-sendResult)
			assertNoObserverTurn(t, sm, state.SessionID)
			if backend.sends != 0 || pty.writes != 0 || resumeCalls != 0 {
				t.Fatalf("queued %s escaped gate: backend=%d pty=%d resume=%d", mode, backend.sends, pty.writes, resumeCalls)
			}
		})
	}
}

func TestObserverDriveGateActiveDriveFinishesBeforeClassificationWithoutDeadlock(t *testing.T) {
	sm, state, backend, _ := observerPolicyManager(adapter.AgentCodex)
	sm.turnMode = turnEnrichmentOff
	state.Source = "terminal"
	state.ControlMode = protocol.ControlLegacyReadOnly
	gate := sm.observerDriveGateFor(state.SessionID)
	leaseActive := make(chan struct{})
	finishDrive := make(chan struct{})
	driveDone := make(chan error, 1)
	go func() {
		driveDone <- sm.WithObserverDrive(context.Background(), state.SessionID, func(ctx context.Context) error {
			close(leaseActive)
			<-finishDrive
			return sm.SendMessageWithInput(ctx, UserMessageInput{
				SessionID: state.SessionID, Content: "authorized before classification", RequestID: "active-first",
			})
		})
	}()
	<-leaseActive

	classified := make(chan ObservedSessionRegistration, 1)
	go func() {
		classified <- sm.RegisterObservedSession(
			state.SessionID, "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop,
		)
	}()
	waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.classificationPending })
	select {
	case result := <-classified:
		t.Fatalf("classification committed during active drive: %v", result)
	default:
	}
	close(finishDrive)
	if err := <-driveDone; err != nil {
		t.Fatalf("active authorized drive failed: %v", err)
	}
	if backend.sends != 1 {
		t.Fatalf("active authorized backend sends=%d, want 1", backend.sends)
	}
	if result := <-classified; result != ObservedSessionReclassified {
		t.Fatalf("classification result=%v, want reclassified after drive", result)
	}
	if err := sm.SendMessage(context.Background(), state.SessionID, "after classification"); !errors.Is(err, adapter.ErrObserverReadOnly) {
		t.Fatalf("post-classification send error=%v, want ErrObserverReadOnly", err)
	}
}

func TestObserverDriveGateDoesNotSerializeIndependentSessions(t *testing.T) {
	sm, first, _, _ := observerPolicyManager(adapter.AgentCodex)
	first.Source = "terminal"
	first.ControlMode = protocol.ControlLegacyReadOnly
	secondBackend := &observerDriveBackendSpy{}
	secondID := "independent-managed-opencode"
	sm.sessions[secondID] = &ProcessState{
		SessionID: secondID, Agent: adapter.AgentOpencode, Source: "daemon",
		ControlMode: protocol.ControlManaged, Status: protocol.StatusIdle, Backend: secondBackend,
	}
	sm.turnMode = turnEnrichmentOff

	_, release, err := sm.acquireObserverDrive(context.Background(), first.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	gate := sm.observerDriveGateFor(first.SessionID)
	classified := make(chan ObservedSessionRegistration, 1)
	go func() {
		classified <- sm.RegisterObservedSession(first.SessionID, "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop)
	}()
	waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.classificationPending })

	secondDone := make(chan error, 1)
	go func() { secondDone <- sm.SendMessage(context.Background(), secondID, "independent") }()
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("independent session send: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("independent session serialized behind unrelated classification")
	}
	if secondBackend.sends != 1 {
		t.Fatalf("independent backend sends=%d, want 1", secondBackend.sends)
	}
	release()
	if result := <-classified; result != ObservedSessionReclassified {
		t.Fatalf("classification result=%v", result)
	}
}

func TestObserverDriveGatePendingClassificationWinsBeforeNativeResolver(t *testing.T) {
	tc := observerInteractionCases()[2]
	sm, broker, client, requestID := newObserverInteractionHarness(t, tc)
	state := sm.sessions["observer-session"]
	state.Agent = adapter.AgentCodex
	state.Source = "terminal"
	state.ControlMode = protocol.ControlLegacyReadOnly
	_, release, err := sm.acquireObserverDrive(context.Background(), state.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	gate := sm.observerDriveGateFor(state.SessionID)
	classified := make(chan ObservedSessionRegistration, 1)
	go func() {
		classified <- sm.RegisterObservedSession(state.SessionID, "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop)
	}()
	waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.classificationPending })
	resolved := make(chan error, 1)
	go func() { resolved <- tc.manager(sm, state.SessionID, requestID) }()
	waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.waitingDrives > 0 })
	release()
	if result := <-classified; result != ObservedSessionReclassified {
		t.Fatalf("classification result=%v", result)
	}
	assertObserverReadOnly(t, state.SessionID, <-resolved)
	if got := interactionResponseCount(client); got != 0 {
		t.Fatalf("pending classification allowed %d native response(s)", got)
	}
	if !tc.pending(broker, state.SessionID, requestID) {
		t.Fatal("pending classification consumed native resolver state")
	}
}

func TestObserverPolicyCodexDesktopRejectsUserInputBeforeBackendPTYResumeTurnAndState(t *testing.T) {
	t.Run("structured backend send", func(t *testing.T) {
		sm, state, backend, pty := observerPolicyManager(adapter.AgentCodexDesktop)
		before := state.LastActivityAt
		err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
			SessionID: state.SessionID, Content: "write through forged backend", RequestID: "req-1",
		})
		assertObserverReadOnly(t, state.SessionID, err)
		assertNoObserverTurn(t, sm, state.SessionID)
		if backend.sends != 0 || pty.writes != 0 {
			t.Errorf("observer input reached backend/PTY: sends=%d writes=%d", backend.sends, pty.writes)
		}
		if state.Status != protocol.StatusIdle || !state.LastActivityAt.Equal(before) {
			t.Errorf("observer input mutated state: status=%q last=%s", state.Status, state.LastActivityAt)
		}
	})

	t.Run("legacy PTY send", func(t *testing.T) {
		sm, state, backend, pty := observerPolicyManager(adapter.AgentCodexDesktop)
		state.Backend = nil
		before := state.LastActivityAt
		err := sm.SendMessage(context.Background(), state.SessionID, "write through forged PTY")
		assertObserverReadOnly(t, state.SessionID, err)
		assertNoObserverTurn(t, sm, state.SessionID)
		if backend.sends != 0 || pty.writes != 0 {
			t.Errorf("observer legacy input reached backend/PTY: sends=%d writes=%d", backend.sends, pty.writes)
		}
		if state.Status != protocol.StatusIdle || !state.LastActivityAt.Equal(before) {
			t.Errorf("observer legacy input mutated state: status=%q last=%s", state.Status, state.LastActivityAt)
		}
	})

	t.Run("native slash command", func(t *testing.T) {
		sm, state, backend, _ := observerPolicyManager(adapter.AgentCodexDesktop)
		err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
			SessionID: state.SessionID, Content: "/model gpt-5.6", RequestID: "req-model",
		})
		assertObserverReadOnly(t, state.SessionID, err)
		assertNoObserverTurn(t, sm, state.SessionID)
		if backend.sends != 0 {
			t.Errorf("observer slash command reached native backend %d time(s)", backend.sends)
		}
	})

	t.Run("dormant resume", func(t *testing.T) {
		sm, state, backend, pty := observerPolicyManager(adapter.AgentCodexDesktop)
		state.Backend = nil
		state.PTY = nil
		state.Source = "terminal"
		state.Status = protocol.StatusExited
		state.Pid = 0
		resumeCalls := 0
		sm.setResumeStarter(func(context.Context, resumeLaunchSpec) (resumeProcess, error) {
			resumeCalls++
			return nil, errors.New("unexpected observer resume")
		})
		err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
			SessionID: state.SessionID, Content: "resume", RequestID: "req-resume",
		})
		assertObserverReadOnly(t, state.SessionID, err)
		assertNoObserverTurn(t, sm, state.SessionID)
		if resumeCalls != 0 || backend.sends != 0 || pty.writes != 0 {
			t.Errorf("observer dormant resume side effects: resume=%d backend=%d pty=%d", resumeCalls, backend.sends, pty.writes)
		}
	})
}

func TestObserverPolicyCodexDesktopHistoricalResumeRejectsBeforeTurnOrProcess(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	const sessionID = "12121212-3434-5656-7878-909090909090"
	dir := filepath.Join(home, ".codex", "sessions", "2026", "09", "04")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(dir, "rollout-2026-09-04T09-08-07-"+sessionID+".jsonl")
	line := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"/work/desktop","originator":"Codex Desktop","source":"vscode"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(rollout, old, old); err != nil {
		t.Fatal(err)
	}

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	resumeCalls := 0
	sm.setResumeStarter(func(context.Context, resumeLaunchSpec) (resumeProcess, error) {
		resumeCalls++
		return nil, errors.New("unexpected historical observer resume")
	})
	err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: sessionID, Content: "must remain historical", RequestID: "req-history",
	})
	assertObserverReadOnly(t, sessionID, err)
	assertNoObserverTurn(t, sm, sessionID)
	if resumeCalls != 0 {
		t.Errorf("historical Desktop rollout launched %d resume process(es)", resumeCalls)
	}
	sm.mu.RLock()
	state := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if state == nil {
		t.Fatal("historical Desktop rollout was not hydrated for policy classification")
	}
	if state.Agent != adapter.AgentCodexDesktop || state.Source != "observer" ||
		state.ControlMode != protocol.ControlLegacyReadOnly || state.Backend != nil {
		t.Errorf("historical Desktop classification = %+v", state)
	}
	if state.Status != protocol.StatusExited || !state.LastActivityAt.Equal(old) {
		t.Errorf("historical observer state mutated: status=%q last=%s", state.Status, state.LastActivityAt)
	}
}

func writeObserverPolicyDesktopRollout(t *testing.T, codexHome string, index int) string {
	t.Helper()
	sessionID := fmt.Sprintf("12121212-3434-5656-7878-%012d", index)
	dir := filepath.Join(codexHome, "sessions", "2026", "09", "04")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(dir, "rollout-2026-09-04T09-08-07-"+sessionID+".jsonl")
	line := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"/work/desktop","originator":"Codex Desktop","source":"vscode"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	return sessionID
}

func TestObserverPolicyUnloadedHistoricalDesktopRejectsEveryControl(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("HOME", t.TempDir())

	tests := []struct {
		name   string
		invoke func(*SessionManager, string) error
	}{
		{name: "abort", invoke: func(sm *SessionManager, id string) error {
			_, err := sm.AbortSessionWithError(id)
			return err
		}},
		{name: "kill", invoke: func(sm *SessionManager, id string) error { return sm.KillSession(id) }},
		{name: "interrupt", invoke: func(sm *SessionManager, id string) error { return sm.InterruptSession(id) }},
		{name: "permission", invoke: func(sm *SessionManager, id string) error {
			return sm.SetPermissionConfig(id, &protocol.PermissionConfig{Agent: adapter.AgentCodex})
		}},
		{name: "effort", invoke: func(sm *SessionManager, id string) error { return sm.SetEffort(id, "high") }},
		{name: "approval", invoke: func(sm *SessionManager, id string) error { return sm.ResolveApproval(id, "req", true) }},
		{name: "approval action", invoke: func(sm *SessionManager, id string) error {
			return sm.ResolveApprovalAction(id, "req", "once")
		}},
		{name: "question response", invoke: func(sm *SessionManager, id string) error {
			return sm.ResolveQuestion(id, "req", [][]string{{"yes"}})
		}},
		{name: "question reject", invoke: func(sm *SessionManager, id string) error { return sm.RejectQuestion(id, "req") }},
		{name: "MCP elicitation", invoke: func(sm *SessionManager, id string) error {
			return sm.ResolveMcpElicitation(id, "req", "decline", nil)
		}},
		{name: "session agent", invoke: func(sm *SessionManager, id string) error {
			return sm.SetSessionAgent(context.Background(), id, "build")
		}},
		{name: "interactive response", invoke: func(sm *SessionManager, id string) error {
			return sm.ResolveInteractivePrompt(id, "req", "1")
		}},
	}

	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sessionID := writeObserverPolicyDesktopRollout(t, codexHome, i+100)
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
			if _, exists := sm.sessions[sessionID]; exists {
				t.Fatal("historical fixture unexpectedly preloaded")
			}
			err := tc.invoke(sm, sessionID)
			assertObserverReadOnly(t, sessionID, err)
		})
	}
}

func TestResolveInteractivePromptUnknownSessionReturnsErrorWithoutPanic(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	err := sm.ResolveInteractivePrompt("unknown-session", "request-1", "1")
	if err == nil || !strings.Contains(err.Error(), "session not found") {
		t.Fatalf("ResolveInteractivePrompt unknown error=%v, want session not found", err)
	}
}

func TestObserverPolicyCodexDesktopRejectsLifecyclePermissionAndInteractiveWrites(t *testing.T) {
	tests := []struct {
		name   string
		invoke func(*SessionManager, *ProcessState) error
	}{
		{name: "kill", invoke: func(sm *SessionManager, state *ProcessState) error {
			return sm.KillSession(state.SessionID)
		}},
		{name: "interrupt", invoke: func(sm *SessionManager, state *ProcessState) error {
			return sm.InterruptSession(state.SessionID)
		}},
		{name: "permission", invoke: func(sm *SessionManager, state *ProcessState) error {
			return sm.SetPermissionConfig(state.SessionID, &protocol.PermissionConfig{
				Agent: adapter.AgentCodex, Preset: "custom", ApprovalPolicy: "on-request", SandboxMode: "workspace-write",
			})
		}},
		{name: "effort", invoke: func(sm *SessionManager, state *ProcessState) error {
			return sm.SetEffort(state.SessionID, "high")
		}},
		{name: "interactive response", invoke: func(sm *SessionManager, state *ProcessState) error {
			return sm.ResolveInteractivePrompt(state.SessionID, "prompt-1", "1")
		}},
		{name: "session agent", invoke: func(sm *SessionManager, state *ProcessState) error {
			return sm.SetSessionAgent(context.Background(), state.SessionID, "plan")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sm, state, backend, pty := observerPolicyManager(adapter.AgentCodexDesktop)
			beforeTime := state.LastActivityAt
			beforePermission := *state.Permission
			beforeEffort := state.Effort
			beforeAgent := state.CurrentAgent
			beforePending := state.PendingRequestID
			err := tt.invoke(sm, state)
			assertObserverReadOnly(t, state.SessionID, err)
			if backend.interrupts != 0 || backend.closes != 0 || backend.sends != 0 || pty.writes != 0 {
				t.Errorf("observer %s invoked drive dependency: backend=%+v pty_writes=%d", tt.name, backend, pty.writes)
			}
			if state.Status != protocol.StatusIdle || !state.LastActivityAt.Equal(beforeTime) ||
				*state.Permission != beforePermission || state.Effort != beforeEffort ||
				state.CurrentAgent != beforeAgent || state.PendingRequestID != beforePending {
				t.Errorf("observer %s mutated state: %+v", tt.name, state)
			}
		})
	}
}

type observerInteractionCase struct {
	name      string
	method    string
	params    string
	eventType string
	manager   func(*SessionManager, string, string) error
	broker    func(*codexInteractions, string, string) error
	pending   func(*codexInteractions, string, string) bool
}

func newObserverInteractionHarness(t *testing.T, tc observerInteractionCase) (*SessionManager, *codexInteractions, *interactionCodexClient, string) {
	t.Helper()
	output := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 51, client)
	coord.interactions = interactions
	sm.codexProvider = &CodexRuntimeProvider{sm: sm, coordinator: coord}
	interactions.Handle(codexServerRequest(t, `51`, tc.method, tc.params))
	request := nextCodexEvent(t, output, tc.eventType)
	if request.RequestID == "" {
		t.Fatalf("%s request has no public id: %+v", tc.name, request)
	}
	if result := sm.RegisterObservedSession("observer-session", "/work/desktop", protocol.StatusIdle, adapter.AgentCodexDesktop); result != ObservedSessionReclassified {
		t.Fatalf("RegisterObservedSession result=%v, want reclassified", result)
	}
	return sm, interactions, client, request.RequestID
}

func observerInteractionCases() []observerInteractionCase {
	return []observerInteractionCase{
		{
			name: "approval boolean", method: "item/commandExecution/requestApproval", eventType: "approval_request",
			params:  `{"threadId":"observer-session","turnId":"turn-1","itemId":"cmd-1","command":"touch forbidden","availableDecisions":["accept","decline"]}`,
			manager: func(sm *SessionManager, sid, rid string) error { return sm.ResolveApproval(sid, rid, true) },
			broker: func(c *codexInteractions, sid, rid string) error {
				return c.ResolveApproval(context.Background(), sid, rid, "once")
			},
			pending: func(c *codexInteractions, sid, rid string) bool { return c.KnowsApproval(sid, rid) },
		},
		{
			name: "approval action", method: "item/fileChange/requestApproval", eventType: "approval_request",
			params:  `{"threadId":"observer-session","turnId":"turn-1","itemId":"patch-1","availableDecisions":["accept","decline"]}`,
			manager: func(sm *SessionManager, sid, rid string) error { return sm.ResolveApprovalAction(sid, rid, "once") },
			broker: func(c *codexInteractions, sid, rid string) error {
				return c.ResolveApproval(context.Background(), sid, rid, "once")
			},
			pending: func(c *codexInteractions, sid, rid string) bool { return c.KnowsApproval(sid, rid) },
		},
		{
			name: "question response", method: "item/tool/requestUserInput", eventType: "question_request",
			params: `{"threadId":"observer-session","turnId":"turn-1","itemId":"tool-1","questions":[{"id":"q","header":"Q","question":"Continue?","options":[{"label":"Yes","description":"continue"}]}]}`,
			manager: func(sm *SessionManager, sid, rid string) error {
				return sm.ResolveQuestion(sid, rid, [][]string{{"Yes"}})
			},
			broker: func(c *codexInteractions, sid, rid string) error {
				return c.ResolveQuestion(context.Background(), sid, rid, [][]string{{"Yes"}})
			},
			pending: func(c *codexInteractions, sid, rid string) bool { return c.KnowsQuestion(sid, rid) },
		},
		{
			name: "question reject", method: "item/tool/requestUserInput", eventType: "question_request",
			params:  `{"threadId":"observer-session","turnId":"turn-1","itemId":"tool-1","questions":[{"id":"q","header":"Q","question":"Continue?","options":[{"label":"Yes","description":"continue"}]}]}`,
			manager: func(sm *SessionManager, sid, rid string) error { return sm.RejectQuestion(sid, rid) },
			broker: func(c *codexInteractions, sid, rid string) error {
				return c.RejectQuestion(context.Background(), sid, rid)
			},
			pending: func(c *codexInteractions, sid, rid string) bool { return c.KnowsQuestion(sid, rid) },
		},
		{
			name: "MCP elicitation", method: "mcpServer/elicitation/request", eventType: "mcp_elicitation_request",
			params: `{"threadId":"observer-session","turnId":"turn-1","serverName":"github","mode":"url","message":"Authorize","elicitationId":"e1","url":"https://example.test/auth"}`,
			manager: func(sm *SessionManager, sid, rid string) error {
				return sm.ResolveMcpElicitation(sid, rid, "decline", json.RawMessage(nil))
			},
			broker: func(c *codexInteractions, sid, rid string) error {
				return c.ResolveMcpElicitation(context.Background(), sid, rid, "decline", json.RawMessage(nil))
			},
			pending: func(c *codexInteractions, sid, rid string) bool { return c.KnowsMcpElicitation(sid, rid) },
		},
	}
}

func interactionResponseCount(client *interactionCodexClient) int {
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	return len(client.responses)
}

func TestObserverPolicyCodexDesktopRejectsNativeInteractionResolversBeforeRespond(t *testing.T) {
	for _, tc := range observerInteractionCases() {
		t.Run(tc.name+" via manager", func(t *testing.T) {
			sm, broker, client, requestID := newObserverInteractionHarness(t, tc)
			state := sm.sessions["observer-session"]
			before := state.LastActivityAt
			err := tc.manager(sm, state.SessionID, requestID)
			assertObserverReadOnly(t, state.SessionID, err)
			if got := interactionResponseCount(client); got != 0 {
				t.Errorf("observer manager resolver wrote %d native response(s)", got)
			}
			if !tc.pending(broker, state.SessionID, requestID) {
				t.Error("observer manager resolver consumed pending interaction")
			}
			if state.Status != protocol.StatusIdle || !state.LastActivityAt.Equal(before) {
				t.Errorf("observer manager resolver mutated state: status=%q last=%s", state.Status, state.LastActivityAt)
			}
		})

		t.Run(tc.name+" via native broker", func(t *testing.T) {
			sm, broker, client, requestID := newObserverInteractionHarness(t, tc)
			state := sm.sessions["observer-session"]
			before := state.LastActivityAt
			err := tc.broker(broker, state.SessionID, requestID)
			assertObserverReadOnly(t, state.SessionID, err)
			if got := interactionResponseCount(client); got != 0 {
				t.Errorf("observer native broker wrote %d response(s)", got)
			}
			if !tc.pending(broker, state.SessionID, requestID) {
				t.Error("observer native broker consumed pending interaction")
			}
			if state.Status != protocol.StatusIdle || !state.LastActivityAt.Equal(before) {
				t.Errorf("observer native broker mutated state: status=%q last=%s", state.Status, state.LastActivityAt)
			}
		})
	}
}

func TestZcodeObserverPolicyRejectsForgedManagedDrive(t *testing.T) {
	sm, state, backend, pty := observerPolicyManager(adapter.AgentZcode)
	err := sm.SendMessageWithInput(context.Background(), UserMessageInput{
		SessionID: state.SessionID, Content: "must stay read only", RequestID: "req-zcode",
	})
	assertObserverReadOnly(t, state.SessionID, err)
	assertNoObserverTurn(t, sm, state.SessionID)
	if backend.sends != 0 || pty.writes != 0 {
		t.Errorf("forged ZCode drive reached backend/PTY: sends=%d writes=%d", backend.sends, pty.writes)
	}
}

func TestObserverPolicyManagedCodexDriveRemainsWritable(t *testing.T) {
	sm, state, backend, _ := observerPolicyManager(adapter.AgentCodex)
	sm.turnMode = turnEnrichmentOff
	if err := sm.SendMessage(context.Background(), state.SessionID, "managed input"); err != nil {
		t.Fatalf("managed Codex send: %v", err)
	}
	if err := sm.InterruptSession(state.SessionID); err != nil {
		t.Fatalf("managed Codex interrupt: %v", err)
	}
	if err := sm.KillSession(state.SessionID); err != nil {
		t.Fatalf("managed Codex kill: %v", err)
	}
	if backend.sends != 1 || backend.interrupts != 1 || backend.closes != 1 {
		t.Fatalf("managed Codex backend calls = %+v", backend)
	}
}

func TestObserverPolicyCommandMatrixPreservesReadOnlyAndRelayOnlyOperations(t *testing.T) {
	for _, commandType := range []string{
		"user_message",
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
		"interactive_response",
	} {
		if !IsObserverDriveCommand(commandType) {
			t.Errorf("IsObserverDriveCommand(%q) = false, want true", commandType)
		}
	}
	for _, commandType := range []string{
		"list_commands",
		"get_session_meta",
		"list_session_agents",
		"list_models",
		"replay",
		"replay_subagent",
		"pin",
		"session_pin",
		"session_delete",
	} {
		if IsObserverDriveCommand(commandType) {
			t.Errorf("IsObserverDriveCommand(%q) = true, want false", commandType)
		}
	}
}

func TestObserverPolicyProtocolMapsUserMessageToNackAndControlsToCorrelatedError(t *testing.T) {
	const sessionID = "desktop-observer-protocol"
	err := observerReadOnlyError(sessionID)
	receipt := ObserverReadOnlyEvent("user_message", sessionID, "req-1", "msg-1", err)
	if receipt.Type != "user_message_receipt" || receipt.SessionID != sessionID ||
		receipt.RequestID != "req-1" || receipt.MsgID != "msg-1" ||
		receipt.Status != "rejected" || receipt.Reason != ObserverReadOnlyCode ||
		receipt.Retryable == nil || *receipt.Retryable {
		t.Fatalf("observer user-message nack = %+v", receipt)
	}
	if receipt.Error != "" {
		t.Fatalf("observer user-message nack unexpectedly duplicated generic error: %+v", receipt)
	}

	control := ObserverReadOnlyEvent("session_interrupt", sessionID, "req-2", "", err)
	if control.Type != "error" || control.SessionID != sessionID || control.RequestID != "req-2" ||
		control.Operation != "session_interrupt" || control.Reason != ObserverReadOnlyCode ||
		!strings.Contains(control.Error, sessionID) {
		t.Fatalf("observer control error = %+v", control)
	}

	created := ObserverCreateRejectedEvent("req-create", "reservation-1")
	if created.Type != "session_create_failed" || created.RequestID != "req-create" ||
		created.ReservationID != "reservation-1" || created.Reason != ObserverReadOnlyCode ||
		created.Error != adapter.ErrObserverReadOnly.Error() {
		t.Fatalf("observer create rejection = %+v", created)
	}
}
