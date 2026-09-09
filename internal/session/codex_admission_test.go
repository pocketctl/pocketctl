package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Existing coordinator unit tests model already verified native sessions.
// Admission-specific tests below use the real filesystem proof instead.
func newVerifiedTestCodexCoordinator(sm *SessionManager) *codexCoordinator {
	c := newCodexCoordinator(sm)
	c.admissionProbe = func(string) bool { return true }
	return c
}

func writeAdmissionRollout(t *testing.T, id, origin string) {
	t.Helper()
	dir := adapter.CodexSessionsDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]any{"id": id, "cwd": "/repo", "originator": origin}})
	if err := os.WriteFile(filepath.Join(dir, "rollout-test-"+id+".jsonl"), append(data, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestCodexAdmissionUnmarkedHelperCannotRegisterThroughStatus(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	c := newCodexCoordinator(sm)
	p := newCodexProjection(1)
	id := "01a0837d-91a7-7b63-b2f0-b939415cf4b3"
	for _, method := range []string{"thread/started", "thread/status/changed", "turn/started", "item/agentMessage/delta"} {
		raw, _ := json.Marshal(map[string]any{"threadId": id, "thread": map[string]any{"id": id}, "status": map[string]string{"type": "active"}, "turn": map[string]string{"id": "helper-turn", "status": "inProgress"}, "turnId": "helper-turn", "itemId": "title", "delta": "auxiliary output"})
		c.handleAdmissionMessage(context.Background(), codexapp.Inbound{Method: method, Params: raw}, p, nil, time.Now())
	}
	// Defensive boundary also covers callers outside the live event pump.
	c.publishProjected([]protocol.DaemonEvent{{Type: "session_status", SessionID: id, Status: "running"}})
	c.applyProjectedEvent(protocol.DaemonEvent{Type: "session_meta", SessionID: id})
	if len(sm.outputCh) != 0 || sm.sessions[id] != nil {
		t.Fatal("unverified helper escaped admission")
	}
	if _, ok := sm.ActiveTurn(id); ok {
		t.Fatal("helper entered turn registry")
	}
}

func TestCodexAdmissionLateRolloutReplaysInOrderWithOriginalStart(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 32))
	c := newCodexCoordinator(sm)
	p := newCodexProjection(1)
	start := time.Now().Add(-time.Minute)
	for _, v := range []struct{ method, raw string }{
		{"thread/started", `{"thread":{"id":"real","cwd":"/repo","status":{"type":"idle"}}}`},
		{"turn/started", `{"threadId":"real","turn":{"id":"t1","status":"inProgress"}}`},
		{"item/agentMessage/delta", `{"threadId":"real","turnId":"t1","itemId":"a1","delta":"hello"}`},
	} {
		c.handleAdmissionMessage(context.Background(), codexNotification(v.method, v.raw), p, nil, start)
	}
	if len(sm.outputCh) != 0 {
		t.Fatal("published before persistence")
	}
	writeAdmissionRollout(t, "real", "codex-tui")
	c.retryAdmissions(context.Background(), p, nil, time.Now())
	events := drainEvents(sm.outputCh)
	if len(events) < 4 || events[0].Type != "session_discovered" || events[len(events)-1].Text != "hello" {
		t.Fatalf("events: %+v", events)
	}
	if got := sm.sessions["real"].TurnStartedAt; !got.Equal(start) {
		t.Fatalf("start=%v want %v", got, start)
	}
}

func TestCodexAdmissionRejectsWrongIDAndDesktopAndAllowsEmptyPersistentThread(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	c := newCodexCoordinator(NewSessionManager(make(chan protocol.DaemonEvent, 8)))
	writeAdmissionRollout(t, "desktop", "codex desktop")
	writeAdmissionRollout(t, "empty", "codex-tui")
	if c.admissionAllowed("desktop") || c.admissionAllowed("missing") {
		t.Fatal("unverified or observer thread admitted")
	}
	if !c.admissionAllowed("empty") {
		t.Fatal("legitimate empty persisted thread rejected")
	}
	dir := adapter.CodexSessionsDir()
	data, _ := os.ReadFile(filepath.Join(dir, "rollout-test-empty.jsonl"))
	if err := os.WriteFile(filepath.Join(dir, "rollout-test-wrong.jsonl"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if c.admissionAllowed("wrong") {
		t.Fatal("filename substituted for complete metadata identity")
	}
}

func TestCodexAdmissionExpiryDoesNotBlacklistAndOldGenerationCannotPublish(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	c := newCodexCoordinator(sm)
	p := newCodexProjection(2)
	now := time.Now()
	msg := codexNotification("thread/started", `{"thread":{"id":"late","status":{"type":"idle"}}}`)
	c.handleAdmissionMessage(context.Background(), msg, p, nil, now.Add(-2*codexAdmissionTTL))
	c.retryAdmissions(context.Background(), p, nil, now)
	writeAdmissionRollout(t, "late", "codex-tui")
	c.handleAdmissionMessage(context.Background(), msg, newCodexProjection(1), nil, now)
	if len(sm.outputCh) != 0 {
		t.Fatal("old generation admitted")
	}
	c.handleAdmissionMessage(context.Background(), msg, p, nil, now)
	if sm.sessions["late"] == nil {
		t.Fatal("expired candidate permanently lost")
	}
}

func TestCodexAdmissionBoundsAndEphemeralIdentity(t *testing.T) {
	c := newCodexCoordinator(NewSessionManager(make(chan protocol.DaemonEvent, 8)))
	c.admissionProbe = func(string) bool { return false }
	p := newCodexProjection(1)
	now := time.Now()
	for i := 0; i <= codexAdmissionMaxThreads; i++ {
		msg := codexNotification("thread/status/changed", fmt.Sprintf(`{"threadId":"pending-%d"}`, i))
		c.handleAdmissionMessage(context.Background(), msg, p, nil, now)
	}
	if len(c.admissionPending) != codexAdmissionMaxThreads || c.admissionBytes > codexAdmissionTotalBytes {
		t.Fatal("pending capacity unbounded")
	}
	params, _ := json.Marshal(map[string]string{"threadId": "large", "delta": strings.Repeat("x", codexAdmissionMaxBytes)})
	c.handleAdmissionMessage(context.Background(), codexapp.Inbound{Method: "item/agentMessage/delta", Params: params}, p, nil, now)
	if c.admissionPending["large"] != nil {
		t.Fatal("oversized frame retained")
	}
	c.handleAdmissionMessage(context.Background(), codexNotification("thread/started", `{"threadId":"aux","thread":{"id":"aux","ephemeral":true}}`), p, nil, now)
	if c.admissionIgnored["aux"].IsZero() || c.admissionPending["aux"] != nil {
		t.Fatal("explicit ephemeral identity not filtered")
	}
	c.retryAdmissions(context.Background(), p, nil, now.Add(2*codexAdmissionTTL))
	if c.admissionBytes != 0 || len(c.admissionPending) != 0 {
		t.Fatal("expiry leaked buffered bytes")
	}
}

func TestCodexAdmissionUnknownInteractionFailsExplicitly(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	c := newCodexCoordinator(sm)
	client := newInteractionCodexClient()
	i := newCodexInteractions(sm, 1, client)
	msg := codexServerRequest(t, "42", "item/commandExecution/requestApproval", `{"threadId":"aux","turnId":"t","itemId":"cmd","command":"echo test"}`)
	c.handleAdmissionMessage(context.Background(), msg, newCodexProjection(1), i, time.Now())
	if len(client.responses) != 1 || client.responses[0].err == nil || client.responses[0].err.Code != -32800 {
		t.Fatalf("request was not rejected explicitly: %+v", client.responses)
	}
	if len(sm.outputCh) != 0 || sm.sessions["aux"] != nil || len(c.admissionPending) != 0 {
		t.Fatal("unknown approval caused a registration or buffered request")
	}
}

func TestCodexAdmissionRetiredResumeCannotPublish(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	writeAdmissionRollout(t, "real", "codex-tui")
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	client := &blockingResumeClient{
		fakeCodexRuntimeClient: newFakeCodexRuntimeClient(), blockedThread: "real",
		entered: make(chan struct{}), release: make(chan struct{}),
		responses: map[string]json.RawMessage{"real": json.RawMessage(`{"thread":{"id":"real","status":{"type":"idle"}}}`)},
	}
	c := newCodexCoordinator(sm)
	c.runtime = &codexAppServerRuntime{Client: client}
	c.generation = 1
	done := make(chan struct{})
	go func() {
		c.subscribeTerminalThread(context.Background(), client, 1, "real", newCodexProjection(1))
		close(done)
	}()
	select {
	case <-client.entered:
	case <-time.After(time.Second):
		t.Fatal("resume did not start")
	}
	c.mu.Lock()
	c.runtime.Client = newFakeCodexRuntimeClient() // reconnect can retain generation
	c.mu.Unlock()
	close(client.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("retired resume did not finish")
	}
	if len(sm.outputCh) != 0 {
		t.Fatal("retired client published resume data")
	}
}

func TestCodexAdmissionManagedCacheIsNotOwnershipAndRollbackIsExplicit(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	sm.sessions["old-helper"] = &ProcessState{SessionID: "old-helper", Agent: adapter.AgentCodex, Source: "terminal", ControlMode: protocol.ControlManaged}
	c := newCodexCoordinator(sm)
	if c.admissionAllowed("old-helper") {
		t.Fatal("old managed metadata bypassed persistent proof")
	}
	t.Setenv("POCKETCTL_CODEX_ADMISSION", "off")
	if !newCodexCoordinator(sm).admissionAllowed("old-helper") {
		t.Fatal("explicit rollback did not restore legacy admission")
	}
}
