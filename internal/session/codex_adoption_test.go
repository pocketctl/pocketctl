package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type adoptionTest struct {
	t                   *testing.T
	sm                  *SessionManager
	id, home, path, cwd string
	client              *fakeCodexRuntimeClient
}

func newAdoptionTest(t *testing.T) *adoptionTest {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_CODEX_HOMES", "")
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1024))
	sm.SetCodexAdoptionOwner("account", "host")
	allowCwdForTest(t, sm)
	f := &adoptionTest{t: t, sm: sm, id: uuid.NewString(), home: home, cwd: t.TempDir(), client: newFakeCodexRuntimeClient()}
	f.path = filepath.Join(home, "sessions", "2001", "01", "01", "rollout-test-"+f.id+".jsonl")
	f.writeMeta("codex-tui", "cli", "")
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	p := sm.CodexRuntimeProvider()
	p.resolve = func() (string, string, error) { return "/fake/codex", "0.172.0", nil }
	p.adoptionProbe = func(context.Context, string, string) (agentcontrol.CodexCapabilities, error) {
		return agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "adoption"}, nil
	}
	p.coordinator.start = func(context.Context, string, string, uint64) (*codexAppServerRuntime, error) {
		return &codexAppServerRuntime{Client: f.client, Endpoint: "/tmp/fixture", RemoteURI: "unix:///tmp/fixture", PID: os.Getpid()}, nil
	}
	p.coordinator.probe = func(context.Context, *codexAppServerRuntime) error { return nil }
	f.resumeResult(f.id, f.path, "on-request", "readOnly")
	t.Cleanup(func() {
		if err := sm.ShutdownCodex(); err != nil {
			t.Error(err)
		}
	})
	return f
}

func (f *adoptionTest) writeMeta(origin, source, parent string) {
	f.t.Helper()
	p := map[string]any{"id": f.id, "cwd": f.cwd, "originator": origin, "source": source}
	if parent != "" {
		p["thread_source"] = "subagent"
		p["parent_thread_id"] = parent
	}
	raw, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": p})
	if err := os.MkdirAll(filepath.Dir(f.path), 0700); err != nil {
		f.t.Fatal(err)
	}
	turn, _ := json.Marshal(map[string]any{"type": "turn_context", "payload": map[string]any{"approval_policy": "on-request", "cwd": f.cwd, "sandbox_policy": map[string]any{"type": "read-only"}}})
	raw = append(append(raw, '\n'), turn...)
	if err := os.WriteFile(f.path, append(raw, '\n'), 0600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *adoptionTest) resumeResult(id, path, approval, sandbox string) {
	raw, _ := json.Marshal(map[string]any{"thread": map[string]any{"id": id, "path": path}, "cwd": f.cwd, "model": "fixture", "approvalPolicy": approval, "sandbox": map[string]any{"type": sandbox}})
	f.client.results["thread/resume"] = raw
}

func (f *adoptionTest) start(request string, wait time.Duration) protocol.AdoptionReceipt {
	f.t.Helper()
	r, err := f.sm.AdoptCodex(context.Background(), protocol.AdoptionRequest{SessionID: f.id, RequestID: request, WaitMS: wait.Milliseconds()})
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}

func awaitAdoption(t *testing.T, sm *SessionManager, id, op string, phases ...string) protocol.AdoptionReceipt {
	t.Helper()
	end := time.Now().Add(45 * time.Second)
	for {
		r, err := sm.CodexAdoptionStatus(context.Background(), id, op)
		if err != nil {
			t.Fatal(err)
		}
		if slices.Contains(phases, r.Phase) {
			return r
		}
		if !adoptionActive(r.Phase) || time.Now().After(end) {
			t.Fatalf("want %v, got %+v", phases, r)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCodexAdoptionStrictOriginalThread(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		setup      func(*adoptionTest)
	}{
		{"success", "managed", func(*adoptionTest) {}},
		{"other-id", "unverified", func(f *adoptionTest) { f.resumeResult(uuid.NewString(), f.path, "on-request", "readOnly") }},
		{"wrong-rollout", "unverified", func(f *adoptionTest) { f.resumeResult(f.id, f.path+".missing", "on-request", "readOnly") }},
		{"missing-original-authority", "unverified", func(f *adoptionTest) {
			file, err := os.OpenFile(f.path, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				f.t.Fatal(err)
			}
			defer file.Close()
			if _, err := file.WriteString(`{"type":"turn_context","payload":{}}` + "\n"); err != nil {
				f.t.Fatal(err)
			}
		}},
		{"original-ceiling", "permission_denied", func(f *adoptionTest) {
			f.sm.SetRemotePermissionPolicy(adapter.RemotePermissionPolicy{AllowDangerous: true})
			f.resumeResult(f.id, f.path, "on-request", "workspaceWrite")
		}},
		{"dangerous", "permission_denied", func(f *adoptionTest) { f.resumeResult(f.id, f.path, "never", "dangerFullAccess") }},
		{"desktop", "unsupported_source", func(f *adoptionTest) { f.writeMeta("Codex Desktop", "cli", "") }},
		{"child", "subsession", func(f *adoptionTest) { f.writeMeta("codex-tui", "cli", uuid.NewString()) }},
		{"unknown", "unsupported_source", func(f *adoptionTest) { f.writeMeta("unclassified", "appServer", "") }},
		{"invalid-cwd", "cwd_not_authorized", func(f *adoptionTest) { f.sm.SetCwdPolicy(nil) }},
		{"provider", "provider_mismatch", func(f *adoptionTest) {
			f.client.errs["thread/resume"] = &codexapp.RPCError{Code: -32600, Message: "Cannot change this thread's model provider from a to b on resume"}
		}},
		{"probe", "probe_timeout", func(f *adoptionTest) {
			f.sm.CodexRuntimeProvider().adoptionProbe = func(context.Context, string, string) (agentcontrol.CodexCapabilities, error) {
				return agentcontrol.CodexCapabilities{}, agentcontrol.ErrCodexProbeTimeout
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAdoptionTest(t)
			tc.setup(f)
			r := f.start("one", 0)
			phase := "blocked"
			if tc.want == "managed" {
				phase = "managed"
			} else if tc.want == "unverified" {
				phase = "failed"
			}
			r = awaitAdoption(t, f.sm, f.id, r.OperationID, phase)
			if r.Reason != tc.want || r.RemoteReady || r.LocalManaged != (tc.want == "managed") {
				t.Fatalf("%+v", r)
			}
			f.client.mu.Lock()
			defer f.client.mu.Unlock()
			for _, call := range f.client.calls {
				if slices.Contains([]string{"thread/start", "thread/fork", "turn/start", "turn/startIfIdle"}, call.method) {
					t.Fatal(call.method)
				}
				if call.method == "thread/resume" {
					var p map[string]any
					json.Unmarshal(call.params, &p)
					if len(p) != 2 || p["threadId"] != f.id || p["excludeTurns"] != true {
						t.Fatal(string(call.params))
					}
				}
			}
		})
	}
}

func TestCodexAdoptionWaitJoinCancelRestart(t *testing.T) {
	f := newAdoptionTest(t)
	var count atomic.Int32
	s := f.sm.adoptionService()
	s.attempt = func(context.Context, adoptionOperation, func(bool) error) string {
		count.Add(1)
		return "active_writer"
	}
	one := f.start("initial", 5*time.Second)
	one = awaitAdoption(t, f.sm, f.id, one.OperationID, "waiting")
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.sm.AdoptCodex(context.Background(), protocol.AdoptionRequest{SessionID: f.id, RequestID: uuid.NewString()})
			if err != nil || r.OperationID != one.OperationID {
				t.Errorf("join %d: %+v %v", i, r, err)
			}
		}()
	}
	wg.Wait()
	s.stop()
	restarted := NewSessionManager(nil)
	restarted.SetCodexAdoptionOwner("account", "host")
	allowCwdForTest(t, restarted)
	ss := restarted.adoptionService()
	ss.attempt = func(context.Context, adoptionOperation, func(bool) error) string {
		count.Add(1)
		return "active_writer"
	}
	defer ss.stop()
	if err := ss.recover(); err != nil {
		t.Fatal(err)
	}
	got := awaitAdoption(t, restarted, f.id, one.OperationID, "waiting")
	if !got.Deadline.Equal(*one.Deadline) {
		t.Fatal("restart reset deadline")
	}
	got, err := restarted.CancelCodexAdoption(context.Background(), f.id, one.OperationID)
	if err != nil || got.Phase != "cancelled" {
		t.Fatalf("%+v %v", got, err)
	}
	before := count.Load()
	replay, err := restarted.AdoptCodex(context.Background(), protocol.AdoptionRequest{SessionID: f.id, RequestID: "initial"})
	if err != nil || replay.Revision != got.Revision || replay.Phase != "cancelled" || count.Load() != before {
		t.Fatal(replay, err)
	}
	foreign := NewSessionManager(nil)
	foreign.SetCodexAdoptionOwner("other", "host")
	if _, err := foreign.CodexAdoptionStatus(context.Background(), f.id, one.OperationID); err == nil {
		t.Fatal("another account could query operation")
	}
	if _, err := restarted.CancelCodexAdoption(context.Background(), uuid.NewString(), one.OperationID); err == nil {
		t.Fatal("wrong session could cancel")
	}
}

func TestCodexAdoptionDeadlineAndBindingWinsCancel(t *testing.T) {
	f := newAdoptionTest(t)
	s := f.sm.adoptionService()
	release := make(chan struct{})
	defer close(release)
	s.attempt = func(ctx context.Context, _ adoptionOperation, _ func(bool) error) string {
		select {
		case <-ctx.Done():
		case <-release:
		}
		return "active_writer"
	}
	op := f.start("first", 100*time.Millisecond)
	awaitAdoption(t, f.sm, f.id, op.OperationID, "binding")
	r, err := f.sm.CancelCodexAdoption(context.Background(), f.id, op.OperationID)
	if err != nil || r.Phase != "binding" {
		t.Fatal(r, err)
	}
	r = awaitAdoption(t, f.sm, f.id, op.OperationID, "expired")
	if r.Reason != "deadline_exceeded" {
		t.Fatal(r)
	}
}

func TestCodexAdoptionArchiveRecoveryAfterNativeMove(t *testing.T) {
	f := newAdoptionTest(t)
	active := f.path
	f.path = filepath.Join(f.home, "archived_sessions", filepath.Base(active))
	if err := os.MkdirAll(filepath.Dir(f.path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(active, f.path); err != nil {
		t.Fatal(err)
	}
	r := f.start("no-consent", 0)
	r = awaitAdoption(t, f.sm, f.id, r.OperationID, "blocked")
	if r.Reason != "archived" || r.ArchiveChanged {
		t.Fatal(r)
	}
	// Simulate death after the native move and before its receipt was saved.
	s := f.sm.adoptionService()
	op := adoptionOperation{AdoptionReceipt: protocol.AdoptionReceipt{Version: 1, SessionID: f.id, OperationID: uuid.NewString(), Phase: "binding", Revision: 2}, HomeID: adapter.CodexHomeProfiles()[0].ID, Created: time.Now().UTC(), Unarchive: true, ArchiveIntent: true}
	s.mu.Lock()
	err := s.saveLocked(op)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(f.path, active); err != nil {
		t.Fatal(err)
	}
	f.client.errs["thread/resume"] = errors.New("transport disconnected")
	if err := s.recover(); err != nil {
		t.Fatal(err)
	}
	r = awaitAdoption(t, f.sm, f.id, op.OperationID, "failed")
	if !r.ArchiveChanged || r.LocalManaged || r.Reason != "unverified" {
		t.Fatal(r)
	}
}

func TestCodexAdoptionSchemaCacheRequiresSameExecutableIdentity(t *testing.T) {
	dir := t.TempDir()
	binary, exe := filepath.Join(dir, "launcher"), filepath.Join(dir, "native")
	for _, path := range []string{binary, exe} {
		if err := os.WriteFile(path, []byte("v1"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	c := newCodexCoordinator(nil)
	c.runtime = &codexAppServerRuntime{PID: os.Getpid(), Client: newFakeCodexRuntimeClient(), ProcessExecutable: exe}
	c.binary, c.version, c.schemaHash = binary, "0.172.0", "original"
	caps := agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: c.schemaHash}
	c.setHiddenContextProofLocked(binary, c.version, caps)
	if got, ok := c.cachedAdoptionCapabilities(binary, c.version); !ok || got.SchemaHash != c.schemaHash {
		t.Fatal("matching live binary lost verified schema")
	}
	replacement := filepath.Join(dir, "replacement")
	if err := os.WriteFile(replacement, []byte("v2"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, exe); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.cachedAdoptionCapabilities(binary, c.version); ok {
		t.Fatal("replacement native binary reused old schema")
	}
}

func TestCodexAdoptionRecheckRepairedDiscovery(t *testing.T) {
	f := newAdoptionTest(t)
	if err := os.Remove(f.path); err != nil {
		t.Fatal(err)
	}
	op := f.start("missing", 0)
	if op.Reason != "source_missing" {
		t.Fatal(op)
	}
	f.writeMeta("codex-tui", "cli", "")
	current, err := f.sm.CodexAdoptionStatus(context.Background(), f.id, "")
	if err != nil || current.Phase != "available" || len(current.AllowedActions) != 1 || current.AllowedActions[0] != "adopt" {
		t.Fatal(current, err)
	}
	history, err := f.sm.CodexAdoptionStatus(context.Background(), f.id, op.OperationID)
	if err != nil || history.Reason != "source_missing" {
		t.Fatal(history, err)
	}
}

func TestCodexAdoptionRetainsWriterDuringIdleReading(t *testing.T) {
	f := newAdoptionTest(t)
	r := f.start("explicit", 0)
	r = awaitAdoption(t, f.sm, f.id, r.OperationID, "managed")
	c := f.sm.CodexRuntimeProvider().coordinator
	now := time.Now()
	c.reapIdleThreads(context.Background(), now)
	c.reapIdleThreads(context.Background(), now.Add(2*codexThreadIdleGrace))
	current, err := f.sm.CodexAdoptionStatus(context.Background(), f.id, r.OperationID)
	if err != nil || !current.LocalManaged || current.Revision != r.Revision || current.OperationID != r.OperationID || c.threadDetached(f.id) {
		t.Fatal(current, err)
	}
	f.client.mu.Lock()
	defer f.client.mu.Unlock()
	for _, call := range f.client.calls {
		if call.method == "thread/unsubscribe" || call.method == "turn/start" {
			t.Fatal(call.method)
		}
	}
}

func TestCodexAdoptionIdleResumeRechecksOriginalPermissions(t *testing.T) {
	f := newAdoptionTest(t)
	r := f.start("first", 0)
	awaitAdoption(t, f.sm, f.id, r.OperationID, "managed")
	c := f.sm.CodexRuntimeProvider().coordinator
	f.sm.mu.RLock()
	b := f.sm.sessions[f.id].Backend.(*CodexAppServerBackend)
	f.sm.mu.RUnlock()
	if err := b.Close(f.id); err != nil {
		t.Fatal(err)
	}
	if !c.threadDetached(f.id) {
		t.Fatal("expected native idle detachment")
	}
	f.sm.SetRemotePermissionPolicy(adapter.RemotePermissionPolicy{AllowDangerous: true})
	f.resumeResult(f.id, f.path, "never", "dangerFullAccess")
	if err := b.Send(context.Background(), f.id, "must not reach native"); err == nil {
		t.Fatal("detached sender bypassed original sandbox")
	}
	if mode := f.sm.SessionControlMode(f.id); mode != protocol.ControlLegacyReadOnly {
		t.Fatal(mode)
	}
	f.client.mu.Lock()
	defer f.client.mu.Unlock()
	for _, call := range f.client.calls {
		if call.method == "turn/start" {
			t.Fatal("a turn was submitted after a failed permission check")
		}
	}
}
