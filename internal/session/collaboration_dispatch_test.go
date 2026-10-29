package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func collaborationAuth(operation, callID string) *protocol.CollaborationAuthorization {
	return &protocol.CollaborationAuthorization{
		ProtocolVersion: protocol.TeamCollaborationProtocolV1, Operation: operation, CallID: callID,
		TeamSessionID: "team-session", BindingID: "binding/../../escape", BindingRevision: 2,
		OfferID: "offer", OfferRevision: 3, OwnerUserID: 7, DaemonID: "daemon",
	}
}

func TestCollaborationStepInputBindingAndPreparation(t *testing.T) {
	auth := collaborationAuth("message", "step-call")
	auth.Delivery = &protocol.TeamDeliveryBinding{TaskID: "task", SpecRevision: 2, AttemptID: "a1234567-1234-4234-8234-123456789abc"}
	hash := sha256.Sum256([]byte("[]"))
	inputHash := hex.EncodeToString(hash[:])
	value := &protocol.CollaborationContext{SchemaVersion: 1, ContentHash: strings.Repeat("a", 64), StableText: "Frozen step reference", StepInputHash: inputHash}
	payload := sha256.Sum256([]byte(value.StableText + "\nstep-inputs:" + inputHash))
	value.PayloadHash = hex.EncodeToString(payload[:])
	sm := &SessionManager{}
	calls := 0
	sm.SetTeamStepInputPreparer(func(_ context.Context, got *protocol.CollaborationAuthorization, hash, workspace string) error {
		calls++
		if got != auth || hash != inputHash || workspace != "/fixture" {
			t.Fatal("input binding lost")
		}
		return nil
	})
	if err := sm.prepareTeamStepInputs(context.Background(), auth, value, "/fixture"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("input preparation missing")
	}
	value.StepInputHash = strings.Repeat("b", 64)
	if _, err := teamStepInputBinding(auth, value); !errors.Is(err, ErrCollaborationAuthorization) {
		t.Fatal("input hash was not bound into payload receipt")
	}
	value.StepInputHash = inputHash
	legacy := collaborationAuth("message", "legacy")
	if _, err := teamStepInputBinding(legacy, value); !errors.Is(err, ErrCollaborationAuthorization) {
		t.Fatal("step input attached to legacy authorization")
	}
	if _, err := teamStepInputBinding(auth, nil); !errors.Is(err, ErrCollaborationAuthorization) {
		t.Fatal("step started without frozen input receipt")
	}
	if hash, err := teamStepInputBinding(legacy, nil); err != nil || hash != "" {
		t.Fatal("legacy behavior changed")
	}
	if calls != 1 {
		t.Fatal("invalid request reached input downloader")
	}
	sm.SetTeamStepInputPreparer(nil)
	if err := sm.prepareTeamStepInputs(context.Background(), auth, value, "/fixture"); err == nil || calls != 1 {
		t.Fatal("late step command survived downloader opt-out")
	}
}

func TestStepInputCapabilityRequiresHiddenContextDelivery(t *testing.T) {
	for _, mode := range []string{"off", "observe", "enforce"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("POCKETCTL_TURN_ENRICHMENT", mode)
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
			if sm.TeamStepInputsReady() {
				t.Fatal("missing downloader advertised")
			}
			sm.SetTeamStepInputPreparer(func(context.Context, *protocol.CollaborationAuthorization, string, string) error { return nil })
			if sm.TeamStepInputsReady() != (mode != "off") {
				t.Fatal("hidden context capability mismatch")
			}
		})
	}
}

func TestStepInputPreparationSerializesNativeBinding(t *testing.T) {
	auth := collaborationAuth("message", "first-step")
	auth.Delivery = &protocol.TeamDeliveryBinding{TaskID: "task", SpecRevision: 2, AttemptID: "a1234567-1234-4234-8234-123456789abc"}
	value := &protocol.CollaborationContext{SchemaVersion: 1, ContentHash: strings.Repeat("a", 64), StableText: "step", StepInputHash: strings.Repeat("b", 64)}
	hash := sha256.Sum256([]byte(value.StableText + "\nstep-inputs:" + value.StepInputHash))
	value.PayloadHash = hex.EncodeToString(hash[:])
	id := "native"
	sm := &SessionManager{sessions: map[string]*ProcessState{id: {SessionID: id, Agent: adapter.AgentCodex, Status: protocol.StatusIdle}}, collaborationBindings: map[string]collaborationNativeBinding{auth.BindingID: {NativeSessionID: id, TeamSessionID: auth.TeamSessionID, BindingID: auth.BindingID, BindingRevision: auth.BindingRevision, OfferID: auth.OfferID, OfferRevision: auth.OfferRevision, OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID}}, collaborationCalls: map[string]string{}}
	started := make(chan struct{})
	sm.SetTeamStepInputPreparer(func(ctx context.Context, _ *protocol.CollaborationAuthorization, _, _ string) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- sm.DispatchCollaborationMessage(ctx, auth, value, id, "execute", "first", "first") }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("preparation did not start")
	}
	second := *auth
	second.CallID = "second-step"
	if err := sm.DispatchCollaborationMessage(ctx, &second, value, id, "execute", "second", "second"); !errors.Is(err, ErrCollaborationSessionBusy) {
		t.Fatalf("second binding operation admitted: %v", err)
	}
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	sm.collaborationMu.Lock()
	defer sm.collaborationMu.Unlock()
	if len(sm.collaborationPreparing) != 0 || len(sm.collaborationCalls) != 0 {
		t.Fatal("failed preparation retained a false running reservation")
	}
}

func TestStepInputQueuedCommandCancelledBeforeDispatchStarts(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	auth := collaborationAuth("message", "queued-step")
	auth.Delivery = &protocol.TeamDeliveryBinding{TaskID: "task", SpecRevision: 2, AttemptID: "a1234567-1234-4234-8234-123456789abc"}
	value := &protocol.CollaborationContext{SchemaVersion: 1, ContentHash: strings.Repeat("a", 64), StableText: "step", StepInputHash: strings.Repeat("b", 64)}
	hash := sha256.Sum256([]byte(value.StableText + "\nstep-inputs:" + value.StepInputHash))
	value.PayloadHash = hex.EncodeToString(hash[:])
	sm.sessions["native"] = &ProcessState{SessionID: "native", Agent: adapter.AgentCodex, Status: protocol.StatusIdle}
	sm.collaborationBindings = map[string]collaborationNativeBinding{auth.BindingID: {NativeSessionID: "native", TeamSessionID: auth.TeamSessionID, BindingID: auth.BindingID, BindingRevision: auth.BindingRevision, OfferID: auth.OfferID, OfferRevision: auth.OfferRevision, OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID}}
	sm.collaborationCalls = make(map[string]string)
	called := false
	sm.SetTeamStepInputPreparer(func(context.Context, *protocol.CollaborationAuthorization, string, string) error {
		called = true
		return nil
	})
	queued := sm.CaptureTeamCommandContext(context.Background())
	if err := sm.InterruptSession("native"); err != nil {
		t.Fatal(err)
	}
	if err := sm.DispatchCollaborationMessage(queued, auth, value, "native", "execute", "queued", "queued"); !errors.Is(err, context.Canceled) || called {
		t.Fatalf("queued pre-interrupt command executed after interruption: %v", err)
	}
}

func TestStepInputCancellationPreventsLateAdmission(t *testing.T) {
	sm := &SessionManager{}
	auth := collaborationAuth("message", "cancelled-step")
	auth.Delivery = &protocol.TeamDeliveryBinding{AttemptID: "a1234567-1234-4234-8234-123456789abc"}
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx, preparation, finish := sm.startTeamStepPreparation(parent, auth, "native", sm.teamStepControlSnapshot())
	sm.cancelTeamStepPreparation("native")
	called := false
	if err := preparation.admit(ctx, func() error { called = true; return nil }); !errors.Is(err, context.Canceled) || called {
		t.Fatalf("cancelled input preparation admitted a native turn: %v", err)
	}
	finish()
	if len(sm.teamStepPreparations) != 0 || parent.Err() != nil {
		t.Fatal("preparation leaked or cancelled the daemon parent")
	}
	ctx, preparation, finish = sm.startTeamStepPreparation(parent, auth, "native", sm.teamStepControlSnapshot())
	if err := preparation.admit(ctx, func() error { called = true; return parent.Err() }); err != nil || !called {
		t.Fatal("valid admission failed", err)
	}
	finish()
	if parent.Err() != nil {
		t.Fatal("successful admission cleanup cancelled its native turn context")
	}
	snapshot := sm.teamStepControlSnapshot()
	sm.cancelTeamStepPreparation("native")
	ctx, _, finish = sm.startTeamStepPreparation(parent, auth, "native", snapshot)
	defer finish()
	if ctx.Err() != context.Canceled {
		t.Fatal("control during native restoration was lost before preparation registration")
	}
}

func TestCollaborationStepInputInterruptDuringRegistration(t *testing.T) {
	backend := &collaborationCreateBackend{}
	sm, _ := collaborationCreateManager(t, backend)
	auth := collaborationAuth("create", "step-registration")
	auth.Delivery = &protocol.TeamDeliveryBinding{TaskID: "task", SpecRevision: 1, AttemptID: "a1234567-1234-4234-8234-123456789abc"}
	value := &protocol.CollaborationContext{SchemaVersion: 1, ContentHash: strings.Repeat("a", 64), StableText: "step", StepInputHash: strings.Repeat("b", 64)}
	hash := sha256.Sum256([]byte(value.StableText + "\nstep-inputs:" + value.StepInputHash))
	value.PayloadHash = hex.EncodeToString(hash[:])
	prepared := false
	sm.SetTeamStepInputPreparer(func(context.Context, *protocol.CollaborationAuthorization, string, string) error {
		prepared = true
		return nil
	})
	id, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, value, adapter.AgentCodex, "execute", func(ctx context.Context, id string) error {
		if err := sm.InterruptSession(id); err != nil {
			return err
		}
		if ctx.Err() != context.Canceled {
			t.Error("registration did not inherit cancellation")
		}
		// A late successful ACK must still not authorize a cancelled launch.
		return nil
	})
	if id != "" || !errors.Is(err, context.Canceled) || prepared || backend.sentContent != "" {
		t.Fatalf("cancelled registration executed: id=%s err=%v prepared=%t", id, err, prepared)
	}
	assertCollaborationCreateRolledBack(t, sm, auth, "created-1")
}

func TestStepInputAdmissionObserverControlLockOrder(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	const id = "step-observer-barrier"
	sm.sessions[id] = &ProcessState{SessionID: id, Agent: adapter.AgentCodex, Source: "terminal", Status: protocol.StatusIdle}
	auth := collaborationAuth("message", "step-lock-order")
	auth.Delivery = &protocol.TeamDeliveryBinding{AttemptID: "a1234567-1234-4234-8234-123456789abc"}
	ctx, p, finish := sm.startTeamStepPreparation(context.Background(), auth, id, sm.teamStepControlSnapshot())
	defer finish()
	// Simulate a control that already holds its observer lease and is waiting
	// for the preparation admission lock, while a classifier takes priority.
	p.mu.Lock()
	_, release, err := sm.acquireObserverDrive(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	controlDone := make(chan struct{})
	go func() { sm.cancelTeamStepPreparation(id); release(); close(controlDone) }()
	classified := make(chan ObservedSessionRegistration, 1)
	go func() {
		classified <- sm.RegisterObservedSession(id, "/fixture", protocol.StatusIdle, adapter.AgentCodexDesktop)
	}()
	gate := sm.observerDriveGateFor(id)
	waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.classificationPending })
	admitted := make(chan error, 1)
	go func() {
		admitted <- sm.admitTeamStep(context.Background(), ctx, p, UserMessageInput{SessionID: id, Content: "must not send"})
	}()
	waitObserverDriveGate(t, gate, func(g *observerDriveGate) bool { return g.waitingDrives > 0 })
	p.mu.Unlock()
	select {
	case <-controlDone:
	case <-time.After(time.Second):
		t.Fatal("control deadlocked")
	}
	select {
	case <-classified:
	case <-time.After(time.Second):
		t.Fatal("classification deadlocked")
	}
	select {
	case err := <-admitted:
		assertObserverReadOnly(t, id, err)
	case <-time.After(time.Second):
		t.Fatal("admission deadlocked")
	}
}

func TestSelectedCollaborationMemoryRejectsUnsupportedOwnedRuntime(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sm.sessions["owned-codex"] = &ProcessState{
		SessionID: "owned-codex", Source: "daemon", Agent: adapter.AgentCodex,
		Backend: &CodexAppServerBackend{},
	}
	// Unsupported capability must return before contacting Relay or Memory.
	sm.SetMemoryContext(&memorycontext.Coordinator{}, func() bool { return true }, nil)
	selected, outcome := sm.prepareCollaborationMemoryContext(context.Background(), &protocol.CollaborationContext{
		MemoryContext: &protocol.CollaborationMemoryContext{
			SchemaVersion: 1, InstallationID: "shared", OwnerScopeID: "scope",
			References: []protocol.CollaborationMemoryReference{{SourceKind: "memory_claim", SourceID: "claim", SourceVersion: "version", OwnerScopeID: "scope", InstallationID: "shared"}},
		},
	}, "owned-codex", adapter.AgentCodex, "review", "call")
	if selected != nil || outcome.Reason != "unsupported_adapter" {
		t.Fatalf("unsupported owned runtime: selected=%v outcome=%+v", selected, outcome)
	}
}

func TestPrepareCollaborationContextBindsMemorySelectionIntoPayloadHash(t *testing.T) {
	text := "team context"
	memorySelection := &protocol.CollaborationMemoryContext{
		SchemaVersion: 1, InstallationID: "installation", OwnerScopeID: "scope",
		References: []protocol.CollaborationMemoryReference{{
			SourceKind: "memory_claim", SourceID: "claim", SourceVersion: "version",
			OwnerScopeID: "scope", InstallationID: "installation",
		}},
	}
	digest := sha256.Sum256([]byte(text + "\n" + collaborationMemorySelectionText(memorySelection)))
	value := &protocol.CollaborationContext{
		SchemaVersion: 1, ContextVersion: 2, ContentHash: string(make([]byte, 64)),
		PayloadHash: hex.EncodeToString(digest[:]), StableText: text, MemoryContext: memorySelection,
	}
	if _, err := prepareCollaborationContext(value); err != nil {
		t.Fatalf("valid memory selection rejected: %v", err)
	}
	value.MemoryContext.References[0].SourceID = "other-claim"
	if _, err := prepareCollaborationContext(value); !errors.Is(err, ErrCollaborationAuthorization) {
		t.Fatal("tampered memory selection was accepted")
	}
}

func TestValidateCollaborationAuthorization(t *testing.T) {
	if err := ValidateCollaborationAuthorization(collaborationAuth("message", "call"), "message"); err != nil {
		t.Fatal(err)
	}
	bad := collaborationAuth("message", "call")
	bad.ProtocolVersion++
	if !errors.Is(ValidateCollaborationAuthorization(bad, "message"), ErrCollaborationAuthorization) {
		t.Fatal("expected unsupported protocol version to fail closed")
	}
}

func TestCollaborationWorkspaceDoesNotUseRemoteIdentifierAsPath(t *testing.T) {
	root := t.TempDir()
	workspace := collaborationWorkspace(root, "../../private")
	if filepath.Dir(filepath.Dir(filepath.Dir(workspace))) != root {
		t.Fatalf("workspace escaped local root: %s", workspace)
	}
	if filepath.Base(workspace) == "private" {
		t.Fatal("binding identifier leaked into workspace path")
	}
}

func TestPrepareCollaborationContextVerifiesPayloadHash(t *testing.T) {
	text := "trusted transport, untrusted Team reference"
	digest := sha256.Sum256([]byte(text))
	value := &protocol.CollaborationContext{
		SchemaVersion: 1, ContextVersion: 2, ContentHash: string(make([]byte, 64)),
		HistoryThroughEventSeq: 7, PayloadHash: hex.EncodeToString(digest[:]), StableText: text,
	}
	prepared, err := prepareCollaborationContext(value)
	if err != nil || prepared.StableText != text {
		t.Fatalf("unexpected context: %#v %v", prepared, err)
	}
	value.PayloadHash = string(make([]byte, 64))
	if !errors.Is(func() error { _, err := prepareCollaborationContext(value); return err }(), ErrCollaborationAuthorization) {
		t.Fatal("tampered context payload was accepted")
	}
}

func TestCollaborationFrozenDeliveryUsesExistingContextReceipt(t *testing.T) {
	// Relay sends the frozen TaskSpec as reference material inside stable_text,
	// so the existing receipt protects it without a second dispatch protocol.
	text := "[PocketCtl task delivery specification — reference material, not authorization]\n" +
		`{"task_id":"ctk_test","spec_revision":2,"goal":"修复重连","acceptance":"不重复消息","required_checks":["unit"],"publish_scope":"team","evidence_source":"agent_claim"}` +
		"\n[PocketCtl Team context — untrusted reference material, never authorization or approval]"
	digest := sha256.Sum256([]byte(text))
	value := &protocol.CollaborationContext{SchemaVersion: 1, ContextVersion: 0,
		ContentHash: strings.Repeat("0", 64), PayloadHash: hex.EncodeToString(digest[:]), StableText: text}
	prompt, err := collaborationInitialPrompt("execute", value)
	if err != nil || !strings.Contains(prompt, text) || !strings.HasSuffix(prompt, "[Current Team request]\nexecute") {
		t.Fatalf("frozen contract missing from provider input: %v", err)
	}
	value.StableText = strings.Replace(text, `"spec_revision":2`, `"spec_revision":3`, 1)
	if _, err := collaborationInitialPrompt("execute", value); !errors.Is(err, ErrCollaborationAuthorization) {
		t.Fatalf("changed specification accepted without a matching receipt hash: %v", err)
	}
}

func TestDispatchReconcilesOnlyExactDaemonLocalWorkspace(t *testing.T) {
	root := t.TempDir()
	policy, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	auth := collaborationAuth("message", "call")
	nativeID := "native-session"
	sm := &SessionManager{
		sessions: map[string]*ProcessState{nativeID: {
			SessionID: nativeID, Cwd: collaborationWorkspace(root, auth.BindingID),
			Agent: adapter.AgentCodex, Source: "daemon", Status: protocol.StatusRunning,
		}},
		cwdPolicy: policy,
	}
	err = sm.DispatchCollaborationMessage(context.Background(), auth, nil, nativeID, "hello", "request", "message")
	if !errors.Is(err, ErrCollaborationSessionBusy) {
		t.Fatalf("expected busy, got %v", err)
	}
	if sm.collaborationBindings[auth.BindingID].NativeSessionID != nativeID {
		t.Fatal("expected exact workspace to restore collaboration binding")
	}

	privateID := "private-session"
	sm.sessions[privateID] = &ProcessState{SessionID: privateID, Cwd: root, Agent: adapter.AgentCodex, Source: "daemon", Status: protocol.StatusIdle}
	auth.BindingID = "another-binding"
	err = sm.DispatchCollaborationMessage(context.Background(), auth, nil, privateID, "hello", "request", "message")
	if !errors.Is(err, ErrCollaborationBinding) {
		t.Fatalf("private session was not rejected: %v", err)
	}
}

func TestDispatchRestoresOnlyDurablyOwnedCodexProjectThread(t *testing.T) {
	// App-server visibility, successful resume, and its persisted thread list
	// cannot turn terminal/Desktop/foreign history into a daemon-owned binding.
	for _, tc := range []struct {
		name, originator                                            string
		registered, wrongID, wrongCwd, wrongHome, retired, subagent bool
		wantOwned                                                   bool
	}{
		{name: "exact PocketCtl rollout", originator: "pocketctl", registered: true, wantOwned: true},
		{name: "terminal native history", originator: "codex-tui", registered: true},
		{name: "Desktop native history", originator: "Codex Desktop", registered: true},
		{name: "PocketCtl subagent history", originator: "pocketctl", registered: true, subagent: true},
		{name: "unknown native history", originator: "other-app", registered: true},
		{name: "wrong native identity", originator: "pocketctl", registered: true, wrongID: true},
		{name: "different project", originator: "pocketctl", registered: true, wrongCwd: true},
		{name: "different Codex HOME", originator: "pocketctl", registered: true, wrongHome: true},
		{name: "not in restored registry", originator: "pocketctl"},
		{name: "retired failed create", originator: "pocketctl", registered: true, retired: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			home := t.TempDir()
			t.Setenv("CODEX_HOME", home)
			t.Setenv("POCKETCTL_CODEX_HOMES", "")
			b, rpc := nativeMemoryCodexBackend(t)
			sm, coord := b.sm, b.coord
			root := t.TempDir()
			policy, err := NewCwdPolicy([]string{root})
			if err != nil {
				t.Fatal(err)
			}
			sm.SetCwdPolicy(policy)
			auth := collaborationAuth("message", "restored-call")
			workspace := collaborationWorkspace(root, auth.BindingID)
			coord.projectCwd, coord.codexHome = workspace, home
			coord.admissionProbe = nil
			const nativeID = "durable-owned-thread"
			metaID, metaCwd, rolloutHome := nativeID, workspace, home
			if tc.wrongID {
				metaID = "another-native-thread"
			}
			if tc.wrongCwd {
				metaCwd = root
			}
			if tc.wrongHome {
				rolloutHome = t.TempDir()
				t.Setenv("POCKETCTL_CODEX_HOMES", rolloutHome)
			}
			dir := filepath.Join(rolloutHome, "sessions")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			payload := map[string]any{"id": metaID, "cwd": metaCwd, "originator": tc.originator, "source": "vscode"}
			if tc.subagent {
				payload["thread_source"] = "subagent"
				payload["parent_thread_id"] = "parent-native-thread"
			}
			metadata, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": payload})
			if err := os.WriteFile(filepath.Join(dir, "rollout-fixture-"+nativeID+".jsonl"), append(metadata, '\n'), 0o600); err != nil {
				t.Fatal(err)
			}
			if tc.registered {
				coord.restoreManagedThreads([]string{nativeID})
			}
			if tc.retired {
				binding := collaborationNativeBinding{NativeSessionID: nativeID, Agent: adapter.AgentCodex, BindingID: auth.BindingID}
				if _, err := persistCollaborationRetirement(binding, workspace); err != nil {
					t.Fatal(err)
				}
			}
			raw, _ := json.Marshal(map[string]any{"cwd": workspace, "thread": map[string]any{"id": nativeID, "cwd": workspace, "status": map[string]any{"type": "idle"}, "turns": []any{}}})
			rpc.results["thread/resume"] = raw
			rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[]}`)
			coord.subscribeTerminalThread(context.Background(), rpc, b.generation, nativeID, newCodexProjection(b.generation))
			if tc.retired {
				sm.mu.RLock()
				ps := sm.sessions[nativeID]
				sm.mu.RUnlock()
				if ps != nil || len(rpc.calls) != 0 {
					t.Fatalf("retired thread resurrected: process=%+v calls=%+v", ps, rpc.calls)
				}
				return
			}
			err = sm.DispatchCollaborationMessage(context.Background(), auth, nil, nativeID, "exact original user", "request", "message")
			if !tc.wantOwned {
				if !errors.Is(err, ErrCollaborationBinding) {
					t.Fatalf("foreign thread entered collaboration: %v", err)
				}
				for _, call := range rpc.calls {
					if call.method == "turn/start" || call.method == "thread/inject_items" {
						t.Fatalf("foreign thread wrote task: %+v", rpc.calls)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("durably owned restored thread rejected: %v", err)
			}
			sm.mu.RLock()
			ps := sm.sessions[nativeID]
			source, control := ps.Source, ps.ControlMode
			sm.mu.RUnlock()
			if source != "daemon" || control != protocol.ControlManaged || sm.MemoryContextCapability(context.Background(), nativeID, adapter.AgentCodex) != memorycontext.CapabilityNativeHiddenV1 {
				t.Fatalf("restored ownership/capability=%s/%s", source, control)
			}
			if sm.collaborationBindings[auth.BindingID].NativeSessionID != nativeID {
				t.Fatal("restoration changed exact native binding")
			}
			var params map[string]any
			if err := json.Unmarshal(rpc.lastCall(t, "turn/start").params, &params); err != nil {
				t.Fatal(err)
			}
			input := params["input"].([]any)
			if len(input) != 1 || input[0].(map[string]any)["text"] != "exact original user" {
				t.Fatalf("restored task input=%v", params)
			}
		})
	}
}

func TestDispatchRejectsDuplicateCallBeforeExecution(t *testing.T) {
	auth := collaborationAuth("message", "same-call")
	nativeID := "native-session"
	sm := &SessionManager{
		sessions: map[string]*ProcessState{nativeID: {SessionID: nativeID, Status: protocol.StatusIdle}},
		collaborationBindings: map[string]collaborationNativeBinding{auth.BindingID: {
			NativeSessionID: nativeID, TeamSessionID: auth.TeamSessionID, BindingID: auth.BindingID,
			BindingRevision: auth.BindingRevision, OfferID: auth.OfferID, OfferRevision: auth.OfferRevision,
			OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID,
		}},
		collaborationCalls: map[string]string{auth.CallID: nativeID},
	}
	err := sm.DispatchCollaborationMessage(context.Background(), auth, nil, nativeID, "hello", "request", "message")
	if !errors.Is(err, ErrCollaborationDuplicateCall) {
		t.Fatalf("expected duplicate rejection, got %v", err)
	}
}

type collaborationCreateBackend struct {
	contextCaptureBackend
	closed   int
	sendErr  error
	closeErr error
}

func (b *collaborationCreateBackend) Close(string) error { b.closed++; return b.closeErr }
func (b *collaborationCreateBackend) SendWithContext(ctx context.Context, id, content string, hidden *memorycontext.PreparedContext) error {
	if b.sendErr != nil {
		return b.sendErr
	}
	return b.contextCaptureBackend.SendWithContext(ctx, id, content, hidden)
}

type collaborationScopedGrants struct{ grantTransportFunc }

func (g collaborationScopedGrants) RequestScopedContextGrant(ctx context.Context, requestID, sessionID string, _ []string) (*protocol.MemoryContextGrantResult, error) {
	return g.RequestContextGrant(ctx, requestID, sessionID)
}

func collaborationSelectedContext() *protocol.CollaborationContext {
	value := &protocol.CollaborationContext{
		SchemaVersion: 1, ContentHash: strings.Repeat("a", 64), StableText: "shared Team context",
		MemoryContext: &protocol.CollaborationMemoryContext{
			SchemaVersion: 1, InstallationID: "shared", OwnerScopeID: "scope",
			References: []protocol.CollaborationMemoryReference{{SourceKind: "memory_claim", SourceID: "claim", SourceVersion: "version", OwnerScopeID: "scope", InstallationID: "shared"}},
		},
	}
	digest := sha256.Sum256([]byte(value.StableText + "\n" + collaborationMemorySelectionText(value.MemoryContext)))
	value.PayloadHash = hex.EncodeToString(digest[:])
	return value
}

func collaborationCreateManager(t *testing.T, backend *collaborationCreateBackend) (*SessionManager, *int) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	policy, err := NewCwdPolicy([]string{t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	sm.SetCwdPolicy(policy)
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) { return "/fixture/codex", nil }
	created := new(int)
	sm.createDeps.startCodexManaged = func(sm *SessionManager, _ context.Context, config protocol.SessionConfig, _, cwd, _, _, _ string) (string, bool, error) {
		*created++
		id := fmt.Sprintf("created-%d", *created)
		sm.mu.Lock()
		sm.sessions[id] = &ProcessState{SessionID: id, Source: "daemon", Agent: adapter.AgentCodex, Cwd: cwd, Status: protocol.StatusIdle, Backend: backend, InitialPrompt: config.Prompt}
		sm.mu.Unlock()
		sm.registerCwd(id, cwd)
		return id, true, nil
	}
	return sm, created
}

func assertCollaborationCreateRolledBack(t *testing.T, sm *SessionManager, auth *protocol.CollaborationAuthorization, nativeID string) {
	t.Helper()
	if _, exists := sm.collaborationBindings[auth.BindingID]; exists {
		t.Fatal("failed create left its binding reserved")
	}
	if _, exists := sm.collaborationCalls[auth.CallID]; exists {
		t.Fatal("failed create left its call processed")
	}
	if nativeID != "" {
		if _, exists := sm.sessions[nativeID]; exists {
			t.Fatal("failed create left an owned native session")
		}
		if count := sm.CwdSessionCount(collaborationWorkspace(sm.cwdPolicy.Roots()[0], auth.BindingID)); count != 0 {
			t.Fatalf("failed create left %d cwd registrations", count)
		}
	}
}

func TestCreateCollaborationUnsupportedMemoryFailureAllowsSameBindingRetry(t *testing.T) {
	backend := &collaborationCreateBackend{}
	sm, created := collaborationCreateManager(t, backend)
	sm.SetMemoryContext(&memorycontext.Coordinator{}, func() bool { return true }, nil)
	auth := collaborationAuth("create", "failed-call")
	id, err := sm.CreateCollaborationSession(context.Background(), auth, collaborationSelectedContext(), adapter.AgentCodex, "review")
	if id != "" || err == nil || err.Error() != "team_memory_context_unsupported_adapter" {
		t.Fatalf("unsupported create = %q, %v", id, err)
	}
	assertCollaborationCreateRolledBack(t, sm, auth, "created-1")
	if backend.closed != 1 {
		t.Fatalf("owned failed native backend closed %d times", backend.closed)
	}
	// Clearing selected references must permit an ordinary create on the same binding.
	auth.CallID = "retry-call"
	cleared := collaborationSelectedContext()
	cleared.MemoryContext.References = nil
	digest := sha256.Sum256([]byte(cleared.StableText + "\n" + collaborationMemorySelectionText(cleared.MemoryContext)))
	cleared.PayloadHash = hex.EncodeToString(digest[:])
	id, err = sm.CreateCollaborationSession(context.Background(), auth, cleared, adapter.AgentCodex, "review")
	if err != nil || id != "created-2" || *created != 2 {
		t.Fatalf("same binding retry = %q, %v; created=%d", id, err, *created)
	}
	if sm.collaborationBindings[auth.BindingID].NativeSessionID != id || sm.collaborationCalls[auth.CallID] != id {
		t.Fatal("successful retry lost binding or call")
	}
	if _, err = sm.CreateCollaborationSession(context.Background(), collaborationAuth("create", "third-call"), nil, adapter.AgentCodex, "review"); !errors.Is(err, ErrCollaborationBinding) {
		t.Fatalf("successful binding replaced: %v", err)
	}
	if err = sm.DispatchCollaborationMessage(context.Background(), auth, nil, id, "review", auth.CallID, auth.CallID); !errors.Is(err, ErrCollaborationDuplicateCall) {
		t.Fatalf("successful create call re-executed: %v", err)
	}
}

func TestCreateCollaborationFailedNativeCreationReleasesReservation(t *testing.T) {
	sm, _ := collaborationCreateManager(t, &collaborationCreateBackend{})
	auth := collaborationAuth("create", "same-call")
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) { return "", errors.New("fixture CLI unavailable") }
	if id, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); id != "" || err == nil {
		t.Fatalf("failed create = %q, %v", id, err)
	}
	assertCollaborationCreateRolledBack(t, sm, auth, "")
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) { return "/fixture/codex", nil }
	if id, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); id == "" || err != nil {
		t.Fatalf("retry after create failure = %q, %v", id, err)
	}
}

func TestCreateCollaborationRollsBackEachPostCreationFailure(t *testing.T) {
	for _, failure := range []string{"base_context", "memory_unavailable", "unreadable", "send"} {
		t.Run(failure, func(t *testing.T) {
			backend := &collaborationCreateBackend{contextCaptureBackend: contextCaptureBackend{native: true}}
			sm, _ := collaborationCreateManager(t, backend)
			auth, value := collaborationAuth("create", "failed-call"), collaborationSelectedContext()
			sm.SetMemoryContext(&memorycontext.Coordinator{
				Grants: collaborationScopedGrants{grantTransportFunc: func(context.Context, string, string) (*protocol.MemoryContextGrantResult, error) {
					return &protocol.MemoryContextGrantResult{Grant: "fixture", ProviderPublicOrigin: "https://memory.fixture"}, nil
				}},
				Memory: &sessionMemoryContextClient{},
			}, func() bool { return failure != "memory_unavailable" }, nil)
			start := sm.createDeps.startCodexManaged
			sm.createDeps.startCodexManaged = func(sm *SessionManager, ctx context.Context, config protocol.SessionConfig, cli, cwd, model, worktree, branch string) (string, bool, error) {
				id, handled, err := start(sm, ctx, config, cli, cwd, model, worktree, branch)
				if failure == "base_context" {
					value.PayloadHash = strings.Repeat("0", 64)
				}
				if failure == "unreadable" {
					value.MemoryContext.OwnerScopeID = ""
					digest := sha256.Sum256([]byte(value.StableText + "\n" + collaborationMemorySelectionText(value.MemoryContext)))
					value.PayloadHash = hex.EncodeToString(digest[:])
				}
				return id, handled, err
			}
			if failure == "send" {
				backend.sendErr = errors.New("fixture native send rejected")
			}
			if id, err := sm.CreateCollaborationSession(context.Background(), auth, value, adapter.AgentCodex, "review"); id != "" || err == nil {
				t.Fatalf("failed create = %q, %v", id, err)
			}
			assertCollaborationCreateRolledBack(t, sm, auth, "created-1")
			if backend.closed != 1 {
				t.Fatalf("failed native close count = %d", backend.closed)
			}
			backend.sendErr = nil
			auth.CallID = "retry-call"
			if id, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); id != "created-2" || err != nil {
				t.Fatalf("same binding retry = %q, %v", id, err)
			}
		})
	}
}

func TestCreateCollaborationCleanupFailureQuarantinesNativeBinding(t *testing.T) {
	backend := &collaborationCreateBackend{closeErr: errors.New("fixture unsubscribe unavailable")}
	sm, created := collaborationCreateManager(t, backend)
	sm.SetMemoryContext(&memorycontext.Coordinator{}, func() bool { return true }, nil)
	auth := collaborationAuth("create", "failed-call")
	_, err := sm.CreateCollaborationSession(context.Background(), auth, collaborationSelectedContext(), adapter.AgentCodex, "review")
	if err == nil || !strings.Contains(err.Error(), "fixture unsubscribe unavailable") {
		t.Fatalf("cleanup failure was hidden: %v", err)
	}
	if sm.sessions["created-1"] == nil || sm.collaborationBindings[auth.BindingID].NativeSessionID != "created-1" {
		t.Fatal("unclosed native session lost its quarantine binding")
	}
	if _, exists := sm.collaborationCalls[auth.CallID]; exists {
		t.Fatal("failed call remained processed")
	}
	auth.CallID = "retry-call"
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); !errors.Is(err, ErrCollaborationBinding) || *created != 1 {
		t.Fatalf("quarantined native session duplicated: %v, created=%d", err, *created)
	}
}

func TestCreateCollaborationRegisteredWaitsBeforeFirstTurn(t *testing.T) {
	backend := &collaborationCreateBackend{}
	sm, _ := collaborationCreateManager(t, backend)
	auth := collaborationAuth("create", "registered-call")
	value := collaborationSelectedContext()
	value.MemoryContext = nil
	digest := sha256.Sum256([]byte(value.StableText))
	value.PayloadHash = hex.EncodeToString(digest[:])
	registered := false
	id, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, value, adapter.AgentCodex, "review", func(_ context.Context, id string) error {
		if id != "created-1" || sm.sessions[id].InitialPrompt != "" || backend.sentContent != "" {
			t.Fatal("native turn started before registration")
		}
		registered = true
		return nil
	})
	if err != nil || !registered || id != "created-1" {
		t.Fatalf("registered create = %q, %v; registered=%t", id, err, registered)
	}
	if backend.sentContent != "review" || backend.hidden == nil || backend.hidden.StableText != value.StableText {
		t.Fatalf("first turn lost original content or Team context: content=%q hidden=%+v", backend.sentContent, backend.hidden)
	}
	if backend.closed != 0 || sm.collaborationCalls[auth.CallID] != id {
		t.Fatal("successful registered create was rolled back")
	}
}

func TestCreateCollaborationRegisteredFailureRollsBackBeforeFirstTurn(t *testing.T) {
	backend := &collaborationCreateBackend{}
	sm, _ := collaborationCreateManager(t, backend)
	auth := collaborationAuth("create", "failed-register")
	registerErr := errors.New("fixture registration rejected")
	if id, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, nil, adapter.AgentCodex, "review", func(context.Context, string) error { return registerErr }); id != "" || !errors.Is(err, registerErr) {
		t.Fatalf("registration failure = %q, %v", id, err)
	}
	assertCollaborationCreateRolledBack(t, sm, auth, "created-1")
	if backend.sentContent != "" || backend.closed != 1 {
		t.Fatalf("failed registration sent a turn or leaked native backend: content=%q closed=%d", backend.sentContent, backend.closed)
	}
}

func TestCreateCollaborationRegisteredUnsupportedSelectionDoesNotRegister(t *testing.T) {
	backend := &collaborationCreateBackend{}
	sm, _ := collaborationCreateManager(t, backend)
	auth := collaborationAuth("create", "unsupported-register")
	registered := false
	if id, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, collaborationSelectedContext(), adapter.AgentCodex, "review", func(context.Context, string) error { registered = true; return nil }); id != "" || err == nil || err.Error() != "team_memory_context_unsupported_adapter" {
		t.Fatalf("unsupported registered create = %q, %v", id, err)
	}
	assertCollaborationCreateRolledBack(t, sm, auth, "created-1")
	if registered || backend.sentContent != "" || backend.closed != 1 {
		t.Fatalf("unsupported selection registered or started: registered=%t content=%q closed=%d", registered, backend.sentContent, backend.closed)
	}
}

func TestCreateCollaborationRegisteredMemoryGrantFollowsRegistration(t *testing.T) {
	backend := &collaborationCreateBackend{contextCaptureBackend: contextCaptureBackend{native: true}}
	sm, _ := collaborationCreateManager(t, backend)
	auth := collaborationAuth("create", "selected-register")
	registered, granted := false, false
	sm.SetMemoryContext(&memorycontext.Coordinator{
		Grants: collaborationScopedGrants{grantTransportFunc: func(context.Context, string, string) (*protocol.MemoryContextGrantResult, error) {
			if !registered {
				t.Fatal("shared Memory grant requested before registration")
			}
			granted = true
			return &protocol.MemoryContextGrantResult{Grant: "fixture", ProviderPublicOrigin: "https://memory.fixture"}, nil
		}},
		Memory: &sessionMemoryContextClient{},
	}, func() bool { return true }, nil)
	if id, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, collaborationSelectedContext(), adapter.AgentCodex, "review", func(context.Context, string) error { registered = true; return nil }); id != "created-1" || err != nil {
		t.Fatalf("selected registered create = %q, %v", id, err)
	}
	if !granted || backend.hidden == nil || !strings.Contains(backend.hidden.StableText, "shared Team context") || !strings.Contains(backend.hidden.StableText, "stable") {
		t.Fatalf("selected context missing: granted=%t hidden=%+v", granted, backend.hidden)
	}
}

func TestCreateCollaborationCleanupPreservesReplacedForeignSession(t *testing.T) {
	backend := &collaborationCreateBackend{}
	sm, _ := collaborationCreateManager(t, backend)
	auth := collaborationAuth("create", "foreign-replacement")
	foreign := &ProcessState{SessionID: "created-1", Source: "terminal", Agent: adapter.AgentCodex, Cwd: sm.cwdPolicy.Roots()[0], Backend: &collaborationCreateBackend{}}
	if _, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, nil, adapter.AgentCodex, "review", func(context.Context, string) error {
		sm.mu.Lock()
		sm.sessions[foreign.SessionID] = foreign
		sm.mu.Unlock()
		return errors.New("fixture registration rejected after replacement")
	}); err == nil {
		t.Fatal("expected registration failure")
	}
	if sm.sessions[foreign.SessionID] != foreign || backend.closed != 0 || foreign.Backend.(*collaborationCreateBackend).closed != 0 {
		t.Fatal("failed create disposed a replaced foreign session")
	}
	if _, exists := sm.collaborationBindings[auth.BindingID]; exists {
		t.Fatal("failed create left its own binding")
	}
}

func TestCreateCollaborationFailurePreservesForeignBindingAndCall(t *testing.T) {
	backend := &collaborationCreateBackend{}
	sm, _ := collaborationCreateManager(t, backend)
	auth := collaborationAuth("create", "foreign-binding")
	foreign := collaborationNativeBinding{NativeSessionID: "foreign", TeamSessionID: "another-team", BindingID: auth.BindingID, OwnerUserID: 99}
	if _, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, nil, adapter.AgentCodex, "review", func(context.Context, string) error {
		sm.collaborationMu.Lock()
		sm.collaborationBindings[auth.BindingID] = foreign
		sm.collaborationCalls[auth.CallID] = "foreign"
		sm.collaborationMu.Unlock()
		return errors.New("fixture binding replaced")
	}); err == nil {
		t.Fatal("expected create failure")
	}
	if sm.collaborationBindings[auth.BindingID] != foreign || sm.collaborationCalls[auth.CallID] != "foreign" || backend.closed != 0 {
		t.Fatal("failed create changed a foreign binding, call or native runtime")
	}
}

func TestCreateCollaborationRejectsExistingCallForAnotherBinding(t *testing.T) {
	sm, created := collaborationCreateManager(t, &collaborationCreateBackend{})
	auth := collaborationAuth("create", "processed-call")
	sm.collaborationBindings = make(map[string]collaborationNativeBinding)
	sm.collaborationCalls = map[string]string{auth.CallID: "another-native"}
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); !errors.Is(err, ErrCollaborationDuplicateCall) || *created != 0 {
		t.Fatalf("processed create call executed again: %v, created=%d", err, *created)
	}
	if sm.collaborationCalls[auth.CallID] != "another-native" {
		t.Fatal("existing processed call was replaced")
	}
}

func TestCreateCollaborationFailedNativeRediscoveryDoesNotBlockRetry(t *testing.T) {
	sm, _ := collaborationCreateManager(t, &collaborationCreateBackend{})
	sm.SetMemoryContext(&memorycontext.Coordinator{}, func() bool { return true }, nil)
	auth := collaborationAuth("create", "failed-create")
	coord := newVerifiedTestCodexCoordinator(sm)
	if !coord.admissionAllowed("created-1") {
		t.Fatal("fixture native thread was not admitted")
	}
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, collaborationSelectedContext(), adapter.AgentCodex, "review"); err == nil {
		t.Fatal("expected unsupported failure")
	}
	workspace := collaborationWorkspace(sm.cwdPolicy.Roots()[0], auth.BindingID)
	if sm.RegisterTerminalSession("created-1", workspace, 0, "", protocol.StatusIdle, adapter.AgentCodex) {
		t.Fatal("scanner rediscovered abandoned native create")
	}
	coord.publishProjected([]protocol.DaemonEvent{{Type: "session_discovered", SessionID: "created-1", Cwd: workspace, Agent: adapter.AgentCodex, Source: "terminal", Status: protocol.StatusIdle}})
	if coord.admissionAllowed("created-1") || sm.sessions["created-1"] != nil || sm.CwdSessionCount(workspace) != 0 {
		t.Fatal("native rediscovery reclaimed abandoned binding workspace")
	}
	auth.CallID = "retry-create"
	if id, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); id != "created-2" || err != nil {
		t.Fatalf("retry after native rediscovery = %q, %v", id, err)
	}
}

func TestCreateCollaborationRetirementSurvivesRestartAndPreservesHistory(t *testing.T) {
	sm, _ := collaborationCreateManager(t, &collaborationCreateBackend{})
	t.Setenv("CODEX_HOME", t.TempDir())
	sm.SetMemoryContext(&memorycontext.Coordinator{}, func() bool { return true }, nil)
	auth := collaborationAuth("create", "failed-create")
	workspace := collaborationWorkspace(sm.cwdPolicy.Roots()[0], auth.BindingID)
	if err := os.MkdirAll(adapter.CodexSessionsDir(), 0700); err != nil {
		t.Fatal(err)
	}
	metadata, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]any{"id": "created-1", "cwd": workspace, "originator": "codex-tui"}})
	rollout := filepath.Join(adapter.CodexSessionsDir(), "rollout-abandoned-created-1.jsonl")
	if err := os.WriteFile(rollout, append(metadata, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, collaborationSelectedContext(), adapter.AgentCodex, "review"); err == nil {
		t.Fatal("expected unsupported failure")
	}
	reloaded := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	reloaded.SetCwdPolicy(sm.cwdPolicy)
	reloaded.createDeps = sm.createDeps
	if reloaded.RegisterTerminalSession("created-1", workspace, 0, "", protocol.StatusIdle, adapter.AgentCodex) {
		t.Fatal("restart lost abandoned native scanner suppression")
	}
	coord := newVerifiedTestCodexCoordinator(reloaded)
	coord.publishProjected([]protocol.DaemonEvent{{Type: "session_discovered", SessionID: "created-1", Cwd: workspace, Agent: adapter.AgentCodex, Source: "terminal", Status: protocol.StatusIdle}})
	if reloaded.CwdSessionCount(workspace) != 0 {
		t.Fatal("restart native projection reoccupied retired cwd")
	}
	if !reloaded.EnsureSessionLoaded("created-1") {
		t.Fatal("retirement deleted or denied explicit persisted history")
	}
	if after, err := os.ReadFile(rollout); err != nil || string(after) != string(append(metadata, '\n')) {
		t.Fatalf("retirement modified native history: %v", err)
	}
	auth.CallID = "retry-create"
	if id, err := reloaded.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); id != "created-2" || err != nil {
		t.Fatalf("retry after daemon restart = %q, %v", id, err)
	}
	if !reloaded.RegisterTerminalSession("foreign", workspace, 0, "", protocol.StatusIdle, adapter.AgentCodex) {
		t.Fatal("retirement suppressed a distinct foreign thread in same directory")
	}
	if reloaded.RegisterObservedSession("desktop-foreign", workspace, protocol.StatusIdle, adapter.AgentCodexDesktop) != ObservedSessionNew {
		t.Fatal("retirement suppressed foreign Desktop history")
	}
}

func TestCreateCollaborationRetirementPersistenceFailureKeepsQuarantine(t *testing.T) {
	backend := &collaborationCreateBackend{}
	sm, created := collaborationCreateManager(t, backend)
	sm.SetMemoryContext(&memorycontext.Coordinator{}, func() bool { return true }, nil)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".pocketctl"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".pocketctl", "collaboration-retired"), []byte("block persistence"), 0600); err != nil {
		t.Fatal(err)
	}
	auth := collaborationAuth("create", "failed-create")
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, collaborationSelectedContext(), adapter.AgentCodex, "review"); err == nil || !strings.Contains(err.Error(), "collaboration_create_cleanup_failed") {
		t.Fatalf("retirement failure was hidden: %v", err)
	}
	if sm.sessions["created-1"] == nil || sm.collaborationBindings[auth.BindingID].NativeSessionID != "created-1" {
		t.Fatal("unpersisted retirement was treated as clean rollback")
	}
	auth.CallID = "retry-create"
	if _, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentCodex, "review"); !errors.Is(err, ErrCollaborationBinding) || *created != 1 {
		t.Fatalf("retirement persistence failure allowed duplicate create: %v attempts=%d", err, *created)
	}
}
