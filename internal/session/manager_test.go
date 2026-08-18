package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestEnsureOpenCodeSessionLoadedBeforeDiscovery(t *testing.T) {
	repo := t.TempDir()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.Method == http.MethodGet && r.URL.Path == "/api/session/ses_1":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
				"id": "ses_1", "directory": repo, "agent": "build",
				"model": map[string]string{"providerID": "opencode", "id": "deepseek-v4-flash-free"},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"ses_1": map[string]string{"type": "idle"}})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			_ = json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/todo":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	})

	serve := startFakeOpenCodeServer(t, handler)
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	coord := newOpencodeCoordinator(sm)
	coord.ctx, coord.cancel = context.WithCancel(context.Background())
	coord.server, coord.started = serve, true
	sm.opencode = coord
	t.Cleanup(coord.cancel)

	if !sm.EnsureOpencodeSessionLoaded("ses_1") {
		t.Fatal("EnsureOpencodeSessionLoaded returned false")
	}
	if agent, ok := sm.GetSessionAgent("ses_1"); !ok || agent != adapter.AgentOpencode {
		t.Fatalf("agent=%q ok=%v, want opencode", agent, ok)
	}
	if cwd, ok := sm.GetSessionCwd("ses_1"); !ok || cwd != repo {
		t.Fatalf("cwd=%q ok=%v, want %q", cwd, ok, repo)
	}
	if model, ok := sm.GetSessionModel("ses_1"); !ok || model != "opencode/deepseek-v4-flash-free" {
		t.Fatalf("model=%q ok=%v", model, ok)
	}
	if got := sm.SessionControlMode("ses_1"); got != protocol.ControlLegacyReadOnly {
		t.Fatalf("control mode=%q", got)
	}
	if got := sm.OpenCodeInteractionCapabilities("ses_1"); len(got) != 0 {
		t.Fatalf("legacy capabilities=%v", got)
	}
	if got := sm.CurrentSessionAgent(context.Background(), "ses_1"); got != "build" {
		t.Fatalf("current agent=%q, want build", got)
	}
	if sm.CwdSessionCount(repo) != 1 {
		t.Fatalf("cwd registration count=%d, want 1", sm.CwdSessionCount("/repo"))
	}
	if !coord.isTracked("ses_1") {
		t.Fatal("session sync was not started")
	}
}

func TestEnsureOpenCodeSessionLoadedFallsBackOnlyAfter404(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	missingID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	errorID := "11111111-2222-3333-4444-555555555555"
	dir := filepath.Join(home, ".claude", "projects", "-repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{missingID, errorID} {
		if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(`{"type":"user","cwd":"/repo"}`+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	serve := startFakeOpenCodeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case r.URL.Path == "/api/session/"+missingID:
			http.NotFound(w, r)
		case r.URL.Path == "/api/session/"+errorID:
			http.Error(w, "serve unavailable status 404:", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	coord := newOpencodeCoordinator(sm)
	coord.ctx, coord.cancel = context.WithCancel(context.Background())
	coord.server, coord.started = serve, true
	sm.opencode = coord
	t.Cleanup(coord.cancel)

	if !sm.EnsureOpencodeSessionLoaded(missingID) {
		t.Fatal("404 did not fall back to JSONL history")
	}
	if agent, _ := sm.GetSessionAgent(missingID); agent != adapter.AgentClaude {
		t.Fatalf("404 fallback agent=%q, want claude", agent)
	}
	if sm.EnsureOpencodeSessionLoaded(errorID) {
		t.Fatal("500 unexpectedly fell back to JSONL history")
	}
	if _, ok := sm.GetSessionAgent(errorID); ok {
		t.Fatal("500 response classified the unknown session")
	}
}

func TestEnsureOpenCodeSessionLoadedRejectsMalformedMetadata(t *testing.T) {
	repo := t.TempDir()
	responses := map[string]string{
		"empty":        `{}`,
		"null":         `{"data":null}`,
		"wrong":        fmt.Sprintf(`{"data":{"id":"ses_other","directory":%q,"agent":"build","model":{"providerID":"opencode","id":"deepseek-v4-flash-free"}}}`, repo),
		"missing-cwd":  `{"data":{"id":"missing-cwd","agent":"build","model":{"providerID":"opencode","id":"deepseek-v4-flash-free"}}}`,
		"relative-cwd": `{"data":{"id":"relative-cwd","directory":"repo","agent":"build","model":{"providerID":"opencode","id":"deepseek-v4-flash-free"}}}`,
		"missing-meta": fmt.Sprintf(`{"data":{"id":"missing-meta","directory":%q}}`, repo),
		"valid":        fmt.Sprintf(`{"data":{"id":"valid","directory":%q,"agent":"build","model":{"providerID":"opencode","id":"deepseek-v4-flash-free"}}}`, repo),
	}
	serve := startFakeOpenCodeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/health" {
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/api/session/")
		if body, ok := responses[id]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		http.NotFound(w, r)
	}))
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	coord := newOpencodeCoordinator(sm)
	coord.ctx, coord.cancel = context.WithCancel(context.Background())
	coord.server, coord.started = serve, true
	sm.opencode = coord
	t.Cleanup(coord.cancel)

	for _, id := range []string{"empty", "null", "wrong", "missing-cwd", "relative-cwd", "missing-meta"} {
		t.Run(id, func(t *testing.T) {
			if sm.EnsureOpencodeSessionLoaded(id) {
				t.Fatalf("malformed %s response was loaded", id)
			}
			if _, ok := sm.GetSessionAgent(id); ok || coord.isTracked(id) || sm.CwdSessionCount(repo) != 0 {
				t.Fatalf("malformed %s response published state, cwd, or sync", id)
			}
		})
	}
	if !sm.EnsureOpencodeSessionLoaded("valid") {
		t.Fatal("valid response was rejected")
	}
}

func TestEnsureOpenCodeSessionLoadedConcurrentCallersWaitForSetup(t *testing.T) {
	repo := t.TempDir()
	var requestCount atomic.Int32
	firstRequest := make(chan struct{})
	release := make(chan struct{})
	serve := startFakeOpenCodeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"healthy": true})
		case "/api/session/ses_concurrent":
			if requestCount.Add(1) == 1 {
				close(firstRequest)
			}
			<-release
			_, _ = fmt.Fprintf(w, `{"data":{"id":"ses_concurrent","directory":%q,"agent":"build","model":{"providerID":"opencode","id":"deepseek-v4-flash-free"}}}`, repo)
		default:
			http.NotFound(w, r)
		}
	}))
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	coord := newOpencodeCoordinator(sm)
	coord.ctx, coord.cancel = context.WithCancel(context.Background())
	coord.server, coord.started = serve, true
	sm.opencode = coord
	t.Cleanup(coord.cancel)

	const callers = 8
	results := make(chan bool, callers)
	for range callers {
		go func() {
			loaded := sm.EnsureOpencodeSessionLoaded("ses_concurrent")
			if loaded && (sm.CwdSessionCount(repo) != 1 || !coord.isTracked("ses_concurrent")) {
				results <- false
				return
			}
			results <- loaded
		}()
	}
	<-firstRequest
	time.Sleep(50 * time.Millisecond)
	close(release)
	for range callers {
		if !<-results {
			t.Fatal("a successful concurrent caller returned before setup completed")
		}
	}
	if got := requestCount.Load(); got != 1 {
		t.Fatalf("GetSession requests=%d, want one", got)
	}
	if sm.CwdSessionCount(repo) != 1 || !coord.isTracked("ses_concurrent") {
		t.Fatal("final cwd/sync setup incomplete")
	}
}

func TestCreateSessionPermissionDefaults(t *testing.T) {
	stopBeforeSubprocess := errors.New("stop before subprocess startup")
	missingCwd := filepath.Join(t.TempDir(), "missing")
	tests := []struct {
		name            string
		agent           string
		permission      *protocol.PermissionConfig
		wantPermission  *protocol.PermissionConfig
		wantErr         string
		wantStartupStop bool
	}{
		{
			name:            "claude receives its default",
			agent:           adapter.AgentClaude,
			wantPermission:  &protocol.PermissionConfig{Agent: adapter.AgentClaude, Mode: "acceptEdits"},
			wantStartupStop: true,
		},
		{
			name:            "codex receives its default",
			agent:           adapter.AgentCodex,
			wantPermission:  &protocol.PermissionConfig{Agent: adapter.AgentCodex, Preset: "custom"},
			wantStartupStop: true,
		},
		{
			name:  "opencode keeps permission nil",
			agent: adapter.AgentOpencode,
		},
		{
			name:       "opencode rejects explicit permission",
			agent:      adapter.AgentOpencode,
			permission: &protocol.PermissionConfig{Agent: adapter.AgentOpencode},
			wantErr:    "opencode does not support permission configuration",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
			var capturedConfig *protocol.SessionConfig
			sm.createDeps.resolveAgentCLI = func(config protocol.SessionConfig) (string, error) {
				captured := config
				capturedConfig = &captured
				if config.Agent == adapter.AgentOpencode {
					return "/fake/opencode", nil
				}
				return "", stopBeforeSubprocess
			}
			sm.createDeps.startOpencode = func(_ *SessionManager, _ context.Context, config protocol.SessionConfig) (string, error) {
				captured := config
				capturedConfig = &captured
				return "opencode-session", nil
			}
			sid, err := sm.CreateSession(context.Background(), protocol.SessionConfig{
				Agent:      tt.agent,
				Cwd:        missingCwd,
				Permission: tt.permission,
			})
			if tt.agent == adapter.AgentOpencode && tt.permission == nil {
				if err != nil {
					t.Fatalf("CreateSession() error = %v", err)
				}
				if sid != "opencode-session" {
					t.Fatalf("CreateSession() id = %q, want opencode-session", sid)
				}
				if capturedConfig == nil || capturedConfig.Permission != nil {
					t.Fatalf("OpenCode permission = %+v, want nil", capturedConfig)
				}
				return
			}
			if tt.wantStartupStop && !errors.Is(err, stopBeforeSubprocess) {
				t.Fatalf("CreateSession() error = %v, want startup boundary", err)
			}
			if tt.wantErr != "" {
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("CreateSession() error = %q, want %q", err, tt.wantErr)
				}
				return
			}
			if capturedConfig == nil {
				t.Fatal("CreateSession() did not reach downstream lifecycle boundary")
			}
			if !reflect.DeepEqual(capturedConfig.Permission, tt.wantPermission) {
				t.Fatalf("CreateSession() permission = %+v, want %+v", capturedConfig.Permission, tt.wantPermission)
			}
			if strings.Contains(err.Error(), "permission") {
				t.Fatalf("CreateSession() rejected default permission: %v", err)
			}
		})
	}
}

type fixedProcessController struct {
	alive map[int]bool
}

func (f fixedProcessController) IsAlive(pid int) bool { return f.alive[pid] }
func (fixedProcessController) Terminate(int) error    { return nil }
func (fixedProcessController) Kill(int) error         { return nil }

// drainDiscovered consumes a session_discovered event if one is pending.
// RegisterTerminalSession no longer emits session_discovered itself — it's
// emitted later by handleWatcherEvents (cmd/pocketctl/main.go) once the JSONL
// tailer confirms the file exists, and by the opencode discovery loop. So this
// is a tolerant, non-blocking drain (nothing to consume in these unit tests).
func drainDiscovered(t *testing.T, ch <-chan protocol.DaemonEvent) {
	t.Helper()
	select {
	case evt := <-ch:
		if evt.Type != "session_discovered" {
			t.Errorf("expected session_discovered, got %q", evt.Type)
		}
	default:
		// no pending event — expected
	}
}

func TestSetSessionExited(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	// Register a terminal session
	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	// Set exited
	sm.SetSessionExited("test-sid", protocol.ExitReasonNormalExit)

	// Verify status is exited
	sm.mu.RLock()
	ps, ok := sm.sessions["test-sid"]
	sm.mu.RUnlock()
	if !ok {
		t.Fatal("session not found")
	}
	if ps.Status != protocol.StatusExited {
		t.Errorf("expected status %q, got %q", protocol.StatusExited, ps.Status)
	}
	if ps.ExitReason != protocol.ExitReasonNormalExit {
		t.Errorf("expected exit_reason %q, got %q", protocol.ExitReasonNormalExit, ps.ExitReason)
	}

	// Verify event was emitted
	select {
	case evt := <-outputCh:
		if evt.Type != "session_status" {
			t.Errorf("expected event type session_status, got %q", evt.Type)
		}
		if evt.Status != protocol.StatusExited {
			t.Errorf("expected event status %q, got %q", protocol.StatusExited, evt.Status)
		}
		if evt.ExitReason != protocol.ExitReasonNormalExit {
			t.Errorf("expected exit_reason %q, got %q", protocol.ExitReasonNormalExit, evt.ExitReason)
		}
		if evt.LastActivityAt == "" {
			t.Error("expected last_activity_at to be set")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for session_status event")
	}
}

func TestSetSessionExitedWithDifferentReasons(t *testing.T) {
	tests := []struct {
		name       string
		exitReason string
	}{
		{"user_interrupt", protocol.ExitReasonUserInterrupt},
		{"normal_exit", protocol.ExitReasonNormalExit},
		{"process_crash", protocol.ExitReasonProcessCrash},
		{"signal_kill", protocol.ExitReasonSignalKill},
		{"unknown", protocol.ExitReasonUnknown},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			outputCh := make(chan protocol.DaemonEvent, 16)
			sm := NewSessionManager(outputCh)
			sid := "test-" + tt.name

			sm.RegisterTerminalSession(sid, "/tmp", 12345, "/dev/ttys001", protocol.StatusIdle, "")
			sm.SetSessionExited(sid, tt.exitReason)

			sm.mu.RLock()
			ps := sm.sessions[sid]
			sm.mu.RUnlock()

			if ps.ExitReason != tt.exitReason {
				t.Errorf("expected exit_reason %q, got %q", tt.exitReason, ps.ExitReason)
			}
		})
	}
}

func TestSetSessionExitedNonexistent(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	// Should not panic on nonexistent session
	sm.SetSessionExited("nonexistent-sid", protocol.ExitReasonUnknown)

	// Should not emit event
	select {
	case evt := <-outputCh:
		t.Errorf("unexpected event: %+v", evt)
	default:
		// Expected: no event
	}
}

func TestSetSessionStatusIncludesLastActivityAt(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)
	sm.SetSessionStatus("test-sid", protocol.StatusIdle)

	select {
	case evt := <-outputCh:
		if evt.Type != "session_status" {
			t.Errorf("expected session_status, got %q", evt.Type)
		}
		if evt.LastActivityAt == "" {
			t.Error("expected last_activity_at to be set in session_status event")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for session_status event")
	}
}

func TestSetSessionExited_StatusTransition(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	// Transition: running → exited
	sm.SetSessionExited("test-sid", protocol.ExitReasonNormalExit)

	sm.mu.RLock()
	ps := sm.sessions["test-sid"]
	sm.mu.RUnlock()

	if ps.Status != protocol.StatusExited {
		t.Errorf("expected status %q, got %q — should NOT be 'idle'", protocol.StatusExited, ps.Status)
	}
	if ps.ExitReason != protocol.ExitReasonNormalExit {
		t.Errorf("expected exit_reason %q, got %q", protocol.ExitReasonNormalExit, ps.ExitReason)
	}

	// Drain the event
	select {
	case evt := <-outputCh:
		if _, err := time.Parse(time.RFC3339, evt.LastActivityAt); err != nil {
			t.Errorf("last_activity_at is not valid ISO 8601: %q", evt.LastActivityAt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestSetSessionExited_DoesNotAffectOtherSessions(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("session-a", "/tmp", 100, "/dev/ttys001", protocol.StatusRunning, "")
	sm.RegisterTerminalSession("session-b", "/tmp", 200, "/dev/ttys002", protocol.StatusRunning, "")

	// Only exit session-a
	sm.SetSessionExited("session-a", protocol.ExitReasonUnknown)

	sm.mu.RLock()
	psA := sm.sessions["session-a"]
	psB := sm.sessions["session-b"]
	sm.mu.RUnlock()

	if psA.Status != protocol.StatusExited {
		t.Errorf("session-a: expected exited, got %q", psA.Status)
	}
	if psB.Status != protocol.StatusRunning {
		t.Errorf("session-b: expected running (unchanged), got %q", psB.Status)
	}
}

func TestSendMessage_ExitedSession_Allowed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sentinel CLI fixture")
	}
	outputCh := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(outputCh)

	// Use a PID that is definitely dead (9999999 does not exist)
	sm.RegisterTerminalSession("exited-sid", "/tmp", 9999999, "", protocol.StatusExited, "")

	// Sentinel PATH proves no real claude/shim is ever executed; the fake
	// starter proves no real process is ever spawned.
	marker := installSentinelResumeCLI(t, "claude")
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := sm.SendMessage(ctx, "exited-sid", "hello")
	defer starter.finishAll()
	if err != nil {
		t.Fatalf("SendMessage returned error: %v", err)
	}
	specs, _ := starter.snapshot()
	if len(specs) != 1 {
		t.Fatalf("resume attempts=%d, want exactly one", len(specs))
	}
	assertClaudeResumeSpec(t, specs[0], "exited-sid", "hello")
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatalf("sentinel CLI was executed during resume: %v", err)
	}
}

func TestSendMessage_ExitedSession_InvalidPID(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sentinel CLI fixture")
	}
	outputCh := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(outputCh)

	// PID 0 — special case, isProcessAlive(0) returns true on some systems
	// Use a definitely-dead PID
	sm.RegisterTerminalSession("dead-sid", os.TempDir(), 9999999, "", protocol.StatusIdle, "")

	marker := installSentinelResumeCLI(t, "claude")
	starter := newRecordingResumeStarter()
	sm.setResumeStarter(starter.call)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := sm.SendMessage(ctx, "dead-sid", "test resume")
	defer starter.finishAll()
	if err != nil {
		t.Fatalf("SendMessage returned error: %v", err)
	}
	specs, _ := starter.snapshot()
	if len(specs) != 1 {
		t.Fatalf("resume attempts=%d, want exactly one", len(specs))
	}
	assertClaudeResumeSpec(t, specs[0], "dead-sid", "test resume")
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatalf("sentinel CLI was executed during resume: %v", err)
	}
}

func TestResolveCwd(t *testing.T) {
	home, err := config.HomeDir()
	if err != nil {
		t.Fatalf("cannot get home dir: %v", err)
	}

	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"empty string", "", home},
		{"tilde", "~", home},
		{"tilde-relative", "~/projects", filepath.Join(home, "projects")},
		{"absolute path", "/opt/workspace", "/opt/workspace"},
		{"another absolute", "/tmp", "/tmp"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := resolveCwd(tt.input)
			if result != tt.expected {
				t.Errorf("resolveCwd(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestValidateCwd(t *testing.T) {
	// Create a temp directory for testing
	tmpDir := t.TempDir()

	// Valid directory should pass
	if err := validateCwd(tmpDir); err != nil {
		t.Errorf("validateCwd(%q) should pass, got: %v", tmpDir, err)
	}

	// Non-existent path should fail
	if err := validateCwd("/nonexistent/path/xyz"); err == nil {
		t.Error("validateCwd for non-existent path should return error")
	}

	// Create a temp file (not a directory)
	tmpFile, err := os.CreateTemp("", "test-validate-cwd")
	if err != nil {
		t.Fatalf("cannot create temp file: %v", err)
	}
	tmpFile.Close()
	defer os.Remove(tmpFile.Name())

	if err := validateCwd(tmpFile.Name()); err == nil {
		t.Error("validateCwd for file should return error")
	}
}

func TestKillSession_SetsKilledStatus(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(outputCh)

	// Create a daemon session
	ctx := context.Background()
	sid, err := sm.CreateSession(ctx, protocol.SessionConfig{
		Agent:      "claude-code",
		Cwd:        os.TempDir(),
		Prompt:     "echo hello",
		Permission: &protocol.PermissionConfig{Agent: adapter.AgentClaude, Mode: "acceptEdits"},
	})
	if err != nil {
		t.Skipf("cannot create session (claude CLI may not be available): %v", err)
	}

	// Kill it
	if err := sm.KillSession(sid); err != nil {
		t.Fatalf("KillSession failed: %v", err)
	}

	sm.mu.RLock()
	ps := sm.sessions[sid]
	sm.mu.RUnlock()

	if ps.Status != protocol.StatusKilled {
		t.Errorf("expected status killed, got %q", ps.Status)
	}
}

func TestUpdateLastActivity(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("test-sid", "/tmp", 12345, "/dev/ttys001", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	sm.mu.RLock()
	before := sm.sessions["test-sid"].LastActivityAt
	sm.mu.RUnlock()

	time.Sleep(10 * time.Millisecond)

	sm.UpdateLastActivity("test-sid")

	sm.mu.RLock()
	after := sm.sessions["test-sid"].LastActivityAt
	sm.mu.RUnlock()

	if !after.After(before) {
		t.Errorf("expected LastActivityAt to be updated (before=%v after=%v)", before, after)
	}
}

func TestUpdateLastActivity_NonexistentSession(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	// should not panic
	sm.UpdateLastActivity("nonexistent")
}

func TestRemapSessionIDUpdatesSessionMapAndCwdRegistry(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	cwd := t.TempDir()

	sm.mu.Lock()
	sm.sessions["old-id"] = &ProcessState{
		SessionID: "old-id",
		Cwd:       cwd,
		Agent:     adapter.AgentCodex,
	}
	sm.mu.Unlock()
	sm.registerCwd("old-id", cwd)

	gotCwd, gotAgent, changed := sm.remapSessionID("old-id", "new-id")
	if !changed {
		t.Fatal("expected session id to change")
	}
	if gotCwd != cwd || gotAgent != adapter.AgentCodex {
		t.Fatalf("metadata = (%q, %q), want (%q, %q)", gotCwd, gotAgent, cwd, adapter.AgentCodex)
	}

	sm.mu.RLock()
	_, oldExists := sm.sessions["old-id"]
	ps, newExists := sm.sessions["new-id"]
	registry := sm.cwdSessions[normalizeCwd(cwd)]
	_, oldRegistered := registry["old-id"]
	_, newRegistered := registry["new-id"]
	sm.mu.RUnlock()

	if oldExists || !newExists {
		t.Fatalf("session map migration failed: old=%v new=%v", oldExists, newExists)
	}
	if ps.SessionID != "new-id" {
		t.Fatalf("process state session id = %q, want new-id", ps.SessionID)
	}
	if oldRegistered || !newRegistered {
		t.Fatalf("cwd registry migration failed: old=%v new=%v", oldRegistered, newRegistered)
	}
}

func TestRegisterTerminalSessionCodexWatcherDoesNotTakeOverDaemonSessionWithoutPID(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	sm.proc = fixedProcessController{alive: map[int]bool{4321: true}}
	sm.mu.Lock()
	sm.sessions["codex-session"] = &ProcessState{
		SessionID: "codex-session",
		Cwd:       "/tmp/project",
		Agent:     adapter.AgentCodex,
		Source:    "daemon",
		Status:    protocol.StatusRunning,
		Pid:       4321,
	}
	sm.childPids[4321] = true
	sm.mu.Unlock()

	startTailer := sm.RegisterTerminalSession(
		"codex-session",
		"/tmp/project",
		0, // Codex rollout discovery has no process id.
		"",
		protocol.StatusRunning,
		adapter.AgentCodex,
	)

	if startTailer {
		t.Fatal("codex watcher must not start a second tailer for a daemon-created session")
	}
	sm.mu.RLock()
	ps := sm.sessions["codex-session"]
	sm.mu.RUnlock()
	if ps.Source != "daemon" {
		t.Fatalf("session source = %q, want daemon", ps.Source)
	}
	if ps.Pid != 4321 {
		t.Fatalf("session pid = %d, want original daemon child pid 4321", ps.Pid)
	}
}

func TestRegisterTerminalSessionCodexWatcherDoesNotTailAppServerManagedSessionWithoutPID(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	backend := newCodexAppServerBackend(sm, newCodexCoordinator(sm), newFakeCodexRuntimeClient(), 1)
	sm.mu.Lock()
	sm.sessions["codex-managed"] = &ProcessState{
		SessionID:   "codex-managed",
		Cwd:         "/tmp/project",
		Agent:       adapter.AgentCodex,
		Source:      "daemon",
		Status:      protocol.StatusRunning,
		Backend:     backend,
		ControlMode: protocol.ControlManaged,
	}
	sm.mu.Unlock()

	startTailer := sm.RegisterTerminalSession(
		"codex-managed",
		"/tmp/project",
		0,
		"",
		protocol.StatusRunning,
		adapter.AgentCodex,
	)

	if startTailer {
		t.Fatal("Codex app-server managed session must not start a rollout tailer")
	}
	sm.mu.RLock()
	ps := sm.sessions["codex-managed"]
	sm.mu.RUnlock()
	if ps.Source != "daemon" || ps.Backend != backend || ps.ControlMode != protocol.ControlManaged {
		t.Fatalf("managed ownership changed: source=%q backend=%T control=%q", ps.Source, ps.Backend, ps.ControlMode)
	}

	if emitted := sm.SyncRediscoveredTerminalStatus("codex-managed", protocol.StatusCompleted); emitted {
		t.Fatal("managed app-server session must ignore watcher status synchronization")
	}
	sm.mu.RLock()
	status := sm.sessions["codex-managed"].Status
	sm.mu.RUnlock()
	if status != protocol.StatusRunning {
		t.Fatalf("managed status = %q, want app-server status %q", status, protocol.StatusRunning)
	}
	select {
	case evt := <-outputCh:
		t.Fatalf("managed watcher rediscovery emitted event: %+v", evt)
	default:
	}
}

func TestSyncRediscoveredTerminalStatusEmitsForTerminalSession(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	sm.RegisterTerminalSession(
		"codex-terminal", "/tmp/project", 0, "", protocol.StatusCompleted, adapter.AgentCodex,
	)

	if emitted := sm.SyncRediscoveredTerminalStatus("codex-terminal", protocol.StatusRunning); !emitted {
		t.Fatal("terminal rediscovery must synchronize watcher status")
	}
	select {
	case evt := <-outputCh:
		if evt.Type != "session_status" || evt.SessionID != "codex-terminal" || evt.Status != protocol.StatusRunning {
			t.Fatalf("terminal watcher status event = %+v", evt)
		}
	default:
		t.Fatal("terminal watcher rediscovery did not emit session_status")
	}
}

func TestObserveTerminalSessionStatusUpdatesStateWithoutEmitting(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 1)
	sm := NewSessionManager(outputCh)
	oldActivity := time.Now().Add(-time.Hour)
	sm.mu.Lock()
	sm.sessions["codex-terminal"] = &ProcessState{
		SessionID:      "codex-terminal",
		Agent:          adapter.AgentCodex,
		Source:         "terminal",
		Status:         protocol.StatusIdle,
		LastActivityAt: oldActivity,
	}
	sm.sessions["codex-managed"] = &ProcessState{
		SessionID: "codex-managed",
		Agent:     adapter.AgentCodex,
		Source:    "daemon",
		Status:    protocol.StatusIdle,
	}
	sm.mu.Unlock()

	if updated := sm.ObserveTerminalSessionStatus("codex-terminal", protocol.StatusRunning); !updated {
		t.Fatal("terminal lifecycle event did not update session state")
	}
	sm.mu.RLock()
	terminalStatus := sm.sessions["codex-terminal"].Status
	terminalActivity := sm.sessions["codex-terminal"].LastActivityAt
	turnStartedAt := sm.sessions["codex-terminal"].TurnStartedAt
	sm.mu.RUnlock()
	if terminalStatus != protocol.StatusRunning || !terminalActivity.After(oldActivity) || turnStartedAt.IsZero() {
		t.Fatalf("terminal state status=%q last_activity=%v turn_started=%v", terminalStatus, terminalActivity, turnStartedAt)
	}

	if updated := sm.ObserveTerminalSessionStatus("codex-terminal", protocol.StatusIdle); !updated {
		t.Fatal("terminal idle lifecycle event did not update session state")
	}
	sm.mu.RLock()
	turnStartedAt = sm.sessions["codex-terminal"].TurnStartedAt
	sm.mu.RUnlock()
	if !turnStartedAt.IsZero() {
		t.Fatalf("idle terminal session kept turn start %v", turnStartedAt)
	}

	if updated := sm.ObserveTerminalSessionStatus("codex-managed", protocol.StatusRunning); updated {
		t.Fatal("terminal lifecycle observer must not mutate a managed session")
	}
	sm.mu.RLock()
	managedStatus := sm.sessions["codex-managed"].Status
	sm.mu.RUnlock()
	if managedStatus != protocol.StatusIdle {
		t.Fatalf("managed status = %q, want idle", managedStatus)
	}
	select {
	case event := <-outputCh:
		t.Fatalf("lifecycle observation emitted a duplicate event: %+v", event)
	default:
	}
}

func TestRegisterTerminalSessionCodexWatcherTakesOverExitedDaemonSessionWithoutPID(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	sm.proc = fixedProcessController{alive: map[int]bool{4321: false}}
	sm.mu.Lock()
	sm.sessions["codex-session"] = &ProcessState{
		SessionID: "codex-session",
		Cwd:       "/tmp/project",
		Agent:     adapter.AgentCodex,
		Source:    "daemon",
		Status:    protocol.StatusCompleted,
		Pid:       4321,
	}
	sm.childPids[4321] = true
	sm.mu.Unlock()

	startTailer := sm.RegisterTerminalSession(
		"codex-session",
		"/tmp/project",
		0,
		"",
		protocol.StatusRunning,
		adapter.AgentCodex,
	)

	if !startTailer {
		t.Fatal("external Codex resume must start a JSONL tailer after daemon session exits")
	}
	sm.mu.RLock()
	ps := sm.sessions["codex-session"]
	sm.mu.RUnlock()
	if ps.Source != "terminal" {
		t.Fatalf("session source = %q, want terminal", ps.Source)
	}
	if ps.Pid != 0 {
		t.Fatalf("session pid = %d, want watcher pid 0", ps.Pid)
	}
}

func TestListSessions_SortedByLastActivity(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)

	sm.RegisterTerminalSession("old-sid", "/tmp", 100, "", protocol.StatusIdle, "")
	drainDiscovered(t, outputCh)
	time.Sleep(10 * time.Millisecond)
	sm.RegisterTerminalSession("new-sid", "/tmp", 101, "", protocol.StatusRunning, "")
	drainDiscovered(t, outputCh)

	// new-sid should have more recent LastActivityAt
	sessions := sm.ListSessions()
	if len(sessions) < 2 {
		t.Fatalf("expected at least 2 sessions, got %d", len(sessions))
	}
	// Active sessions sorted by last activity (most recent first)
	if sessions[0].SessionID != "new-sid" {
		t.Errorf("expected new-sid first, got %s", sessions[0].SessionID)
	}
	if sessions[1].SessionID != "old-sid" {
		t.Errorf("expected old-sid second, got %s", sessions[1].SessionID)
	}
}

func TestResyncSessionsMarksDiscoveryEvents(t *testing.T) {
	outputCh := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(outputCh)
	sm.mu.Lock()
	sm.sessions["session-a"] = &ProcessState{
		SessionID: "session-a",
		Cwd:       "/tmp/project",
		Agent:     adapter.AgentCodex,
		Source:    "daemon",
		Status:    protocol.StatusCompleted,
	}
	sm.mu.Unlock()

	sm.ResyncSessions()
	evt := <-outputCh
	if evt.Type != "session_discovered" || !evt.Resync {
		t.Fatalf("event = %#v, want resync session_discovered", evt)
	}
}

func TestTerminalProbeResponsesForCodexStartupQueries(t *testing.T) {
	chunk := []byte("\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c")
	got := terminalProbeResponses(chunk)
	want := [][]byte{
		[]byte("\x1b[1;1R"),
		[]byte("\x1b[?1;2c"),
		[]byte("\x1b[?0u"),
		[]byte("\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
		[]byte("\x1b]11;rgb:0000/0000/0000\x1b\\"),
	}
	if len(got) != len(want) {
		t.Fatalf("responses = %d, want %d: %q", len(got), len(want), got)
	}
	for i := range want {
		if string(got[i]) != string(want[i]) {
			t.Fatalf("response[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestSessionEffortCacheKeepsLatestNonEmptyValue(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.sessions["s1"] = &ProcessState{SessionID: "s1", Agent: adapter.AgentCodex}
	sm.SetSessionEffort("s1", "high")
	sm.SetSessionEffort("s1", "")
	if got := sm.GetSessionEffort("s1"); got != "high" {
		t.Fatalf("GetSessionEffort() = %q, want high", got)
	}
}

// TestCreateSessionZcodeObserverRejected verifies that a zcode (BackendObserver)
// agent is fail-closed rejected before any subprocess/PTY/worktree side effect.
// resolveAgentCLI, startOpencode and startCodexManaged must NOT be invoked.
func TestCreateSessionZcodeObserverRejected(t *testing.T) {
	cliCalled := false
	opencodeCalled := false
	codexManagedCalled := false

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	sm.createDeps.resolveAgentCLI = func(protocol.SessionConfig) (string, error) {
		cliCalled = true
		return "/should/not/be/called", nil
	}
	sm.createDeps.startOpencode = func(*SessionManager, context.Context, protocol.SessionConfig) (string, error) {
		opencodeCalled = true
		return "should-not-start", nil
	}
	sm.createDeps.startCodexManaged = func(*SessionManager, context.Context, protocol.SessionConfig, string, string, string, string, string) (string, bool, error) {
		codexManagedCalled = true
		return "", false, nil
	}

	tmp := t.TempDir()
	_, err := sm.CreateSession(context.Background(), protocol.SessionConfig{
		Agent: adapter.AgentZcode,
		Cwd:   tmp,
	})
	if !errors.Is(err, adapter.ErrObserverReadOnly) {
		t.Fatalf("CreateSession(zcode) err = %v, want ErrObserverReadOnly", err)
	}
	if cliCalled {
		t.Fatal("resolveAgentCLI was called for a zcode session; observer must be rejected before CLI resolution")
	}
	if opencodeCalled {
		t.Fatal("startOpencode was called for a zcode session")
	}
	if codexManagedCalled {
		t.Fatal("startCodexManaged was called for a zcode session")
	}
	// No session registered.
	if sm.CwdSessionCount(tmp) != 0 {
		t.Fatalf("CwdSessionCount = %d, want 0 (no session should be registered)", sm.CwdSessionCount(tmp))
	}
}
