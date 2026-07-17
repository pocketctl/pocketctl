package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type mutableProcessInspector struct {
	mu        sync.Mutex
	processes []platform.ProcessSnapshot
}

func (i *mutableProcessInspector) List() ([]platform.ProcessSnapshot, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]platform.ProcessSnapshot(nil), i.processes...), nil
}

func (i *mutableProcessInspector) set(processes []platform.ProcessSnapshot) {
	i.mu.Lock()
	i.processes = append([]platform.ProcessSnapshot(nil), processes...)
	i.mu.Unlock()
}

func TestOpenCodeControlModeBaselineClassifiesLegacySessions(t *testing.T) {
	activeRepo := t.TempDir()
	legacyRepo := t.TempDir()
	now := time.Now().UnixMilli()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/session" {
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
				{"id": "ses_active", "time": map[string]int64{"updated": now}, "location": map[string]string{"directory": activeRepo}},
				{"id": "ses_legacy", "time": map[string]int64{"updated": now}, "location": map[string]string{"directory": legacyRepo}},
			}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	inspector := &mutableProcessInspector{processes: []platform.ProcessSnapshot{{
		PID: 42, Executable: "/opt/opencode", Args: []string{"/opt/opencode"}, CWD: activeRepo,
	}}}
	coord.processInspector = inspector
	if err := coord.initializeControlBaseline(context.Background()); err != nil {
		t.Fatal(err)
	}
	coord.discoverOnce(context.Background())
	if got := sm.SessionControlMode("ses_active"); got != protocol.ControlUnmanagedActive {
		t.Fatalf("active mode=%q", got)
	}
	if got := sm.SessionControlMode("ses_legacy"); got != protocol.ControlLegacyReadOnly {
		t.Fatalf("legacy mode=%q", got)
	}
	if caps := sm.OpenCodeInteractionCapabilities("ses_active"); len(caps) != 0 {
		t.Fatalf("active capabilities=%v", caps)
	}
}

func TestOpenCodeAdoptContinueAndResumeAfterNativeProcessExits(t *testing.T) {
	for _, intent := range []string{agentcontrol.IntentContinue, agentcontrol.IntentResume} {
		t.Run(intent, func(t *testing.T) {
			repo := t.TempDir()
			now := time.Now().UnixMilli()
			sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/session":
					json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{
						"id": "ses_adopt", "time": map[string]int64{"updated": now}, "location": map[string]string{"directory": repo},
					}}})
				case "/api/session/ses_adopt":
					json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_adopt", "directory": repo}})
				default:
					json.NewEncoder(w).Encode([]any{})
				}
			}), nil)
			inspector := &mutableProcessInspector{}
			inspector.set([]platform.ProcessSnapshot{{PID: 42, Executable: "/opt/opencode", Args: []string{"/opt/opencode"}, CWD: repo}})
			coord.processInspector = inspector
			if err := coord.initializeControlBaseline(context.Background()); err != nil {
				t.Fatal(err)
			}
			sessionID := ""
			if intent == agentcontrol.IntentResume {
				sessionID = "ses_adopt"
			}
			_, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, intent, sessionID, false, "busy-op"))
			var protocolErr *agentcontrol.ProtocolError
			if !errors.As(err, &protocolErr) || protocolErr.Code != agentcontrol.ErrSessionBusy {
				t.Fatalf("busy error=%v", err)
			}
			inspector.set(nil)
			result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, intent, sessionID, false, "adopt-op"))
			if err != nil || result.ResolvedSessionID != "ses_adopt" {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			if got := sm.SessionControlMode("ses_adopt"); got != protocol.ControlManaged {
				t.Fatalf("mode=%q", got)
			}
			caps := sm.OpenCodeInteractionCapabilities("ses_adopt")
			if !containsCapability(caps, "shared_runtime") || !containsCapability(caps, "terminal_coapproval") || !containsCapability(caps, "questions") {
				t.Fatalf("capabilities=%v", caps)
			}
		})
	}
}

func TestOpenCodeControlModeNormalizesProcessCWD(t *testing.T) {
	repo := t.TempDir()
	inspector := &mutableProcessInspector{processes: []platform.ProcessSnapshot{{
		PID: 42, Executable: "/opt/opencode", Args: []string{"/opt/opencode"}, CWD: filepath.Join(repo, "."),
	}}}
	if !hasUnmanagedOpenCodeProcess(inspector, repo, "http://127.0.0.1:4096") {
		t.Fatal("normalized cwd did not match active process")
	}
}

func TestOpenCodeAdoptRejectsKnownLiveSessionPID(t *testing.T) {
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/session/ses_pid" {
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_pid", "directory": repo}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	coord.processInspector = &mutableProcessInspector{}
	sm.sessions["ses_pid"] = &ProcessState{
		SessionID: "ses_pid", Agent: adapter.AgentOpencode, Cwd: repo, Pid: os.Getpid(), ControlMode: protocol.ControlUnmanagedActive,
	}
	_, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentResume, "ses_pid", false, "live-pid"))
	var protocolErr *agentcontrol.ProtocolError
	if !errors.As(err, &protocolErr) || protocolErr.Code != agentcontrol.ErrSessionBusy {
		t.Fatalf("live pid error=%v", err)
	}
	sm.sessions["ses_pid"].Pid = 99999999
	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentResume, "ses_pid", false, "dead-pid"))
	if err != nil || result.ResolvedSessionID != "ses_pid" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestOpenCodeAdoptIgnoresCoordinatorServeProcess(t *testing.T) {
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/session/ses_serve" {
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_serve", "directory": repo}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	coord.processInspector = &mutableProcessInspector{processes: []platform.ProcessSnapshot{{
		PID: coord.srv().PID(), Executable: "/opt/opencode", Args: []string{"/opt/opencode", "serve", "--port", "0"}, CWD: repo,
	}}}
	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentResume, "ses_serve", false, "owned-serve"))
	if err != nil || result.ResolvedSessionID != "ses_serve" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestOpenCodeAdoptIgnoresLauncherClientProcess(t *testing.T) {
	repo := t.TempDir()
	sm, coord := newOpenCodeRuntimeTestManagerWithHealth(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/session/ses_launcher" {
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "ses_launcher", "directory": repo}})
			return
		}
		json.NewEncoder(w).Encode([]any{})
	}), nil)
	coord.processInspector = &mutableProcessInspector{processes: []platform.ProcessSnapshot{{
		PID: os.Getpid(), Executable: "/opt/pocketctl",
		Args: []string{"/opt/pocketctl", "__agent-launch", "opencode", "-s", "ses_launcher"}, CWD: repo,
	}}}

	result, err := sm.Acquire(context.Background(), runtimeAcquireRequest(repo, agentcontrol.IntentResume, "ses_launcher", false, "launcher-client"))
	if err != nil || result.ResolvedSessionID != "ses_launcher" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestOpenCodeControlModeRestoresManagedRegistryAfterRestart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	state := &daemon.OpenCodeServeState{
		PID: 42, BaseURL: "http://127.0.0.1:4096", Password: "secret", Version: "1.17.11", Generation: 9,
		ManagedSessions: map[string]daemon.OpenCodeManagedSessionState{
			"ses_managed": {CWD: "/repo", Generation: 9, ControlMode: protocol.ControlManaged},
		},
	}
	if err := daemon.WriteOpenCodeServeState(state); err != nil {
		t.Fatal(err)
	}
	restored, err := daemon.ReadOpenCodeServeState()
	if err != nil {
		t.Fatal(err)
	}
	coord := newOpencodeCoordinator(NewSessionManager(make(chan protocol.DaemonEvent, 1)))
	coord.restoreControlRegistry(restored)
	if !coord.isManagedSession("ses_managed") {
		t.Fatal("managed session was lost across handoff state round trip")
	}
	coord.managedMu.RLock()
	entry := coord.managedSessions["ses_managed"]
	coord.managedMu.RUnlock()
	if entry.CWD != "/repo" || entry.Generation != 9 {
		t.Fatalf("restored entry=%+v", entry)
	}
}

func TestOpenCodeControlModeLegacySessionDoesNotSurfaceInteractions(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 2))
	sm.sessions["ses_legacy"] = &ProcessState{
		SessionID: "ses_legacy", Agent: adapter.AgentOpencode, ControlMode: protocol.ControlLegacyReadOnly,
		PendingPermissions: make(map[string]PendingOpenCodePermission), PendingQuestions: make(map[string]PendingOpenCodeQuestion),
	}
	if sm.handleOpencodePermission(adapter.PermissionAsked{ID: "per_1", SessionID: "ses_legacy", Permission: "bash"}) {
		t.Fatal("legacy permission was surfaced as remotely actionable")
	}
	if sm.handleOpencodeQuestion(adapter.QuestionAsked{ID: "que_1", SessionID: "ses_legacy", Questions: []protocol.QuestionInfo{{Question: "Continue?"}}}) {
		t.Fatal("legacy question was surfaced as remotely actionable")
	}
}

func containsCapability(capabilities []string, want string) bool {
	for _, capability := range capabilities {
		if capability == want {
			return true
		}
	}
	return false
}
