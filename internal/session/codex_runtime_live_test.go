//go:build !windows

package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexCoordinatorReplacesIncompatibleHandoffWithoutCodexLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	oldRuntime := exec.Command("sleep", "30")
	oldRuntime.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := oldRuntime.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = syscall.Kill(-oldRuntime.Process.Pid, syscall.SIGKILL)
		_, _ = oldRuntime.Process.Wait()
	}()
	state := &daemon.CodexAppServerState{
		PID: oldRuntime.Process.Pid, OwnerPID: 0,
		Endpoint: "/tmp/old-codex.sock", RemoteURI: "unix:///tmp/old-codex.sock",
		Binary: "/opt/codex", Version: "0.144.1", SchemaHash: "old-schema", Generation: 7,
		Threads: []string{"thr_managed"},
	}
	if err := daemon.WriteCodexAppServerState(state); err != nil {
		t.Fatal(err)
	}

	coord := newCodexCoordinator(nil)
	var startedGeneration uint64
	coord.start = func(_ context.Context, _, _ string, generation uint64) (*codexAppServerRuntime, error) {
		startedGeneration = generation
		return &codexAppServerRuntime{PID: os.Getpid(), Endpoint: "/tmp/new-codex.sock", RemoteURI: "unix:///tmp/new-codex.sock"}, nil
	}
	if _, err := coord.ensureStarted(context.Background(), state.Binary, state.Version, agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, SchemaHash: "new-schema"}); err != nil {
		t.Fatal(err)
	}
	if startedGeneration != 8 {
		t.Fatalf("generation=%d want 8", startedGeneration)
	}
	if threads := coord.managedThreadSnapshot(); len(threads) != 1 || threads[0] != "thr_managed" {
		t.Fatalf("managed threads=%v want persisted thread after runtime replacement", threads)
	}
}

func TestInstalledCodexRuntimeAcquireAndSecondClient(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_SMOKE") != "1" {
		t.Skip("set POCKETCTL_CODEX_SMOKE=1 to test the installed Codex CLI")
	}
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	// TestMain has already replaced HOME; its .codex need not exist. An
	// explicit CODEX_HOME must exist, and must not reuse developer credentials.
	t.Setenv("HOME", t.TempDir())
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	// Only the installed app-server and its real native acknowledgement are
	// under test. A synthetic loopback provider receives the model request.
	requested := make(chan struct{}, 1)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case requested <- struct{}{}:
		default:
		}
		http.Error(w, "local fixture complete", http.StatusBadRequest)
	}))
	defer model.Close()
	settings := fmt.Sprintf("model_provider = %q\nmodel = %q\n[model_providers.smoke]\nname = %q\nbase_url = %q\nwire_api = %q\nrequest_max_retries = 0\nstream_max_retries = 0\n", "smoke", "local-fixture", "Loopback", model.URL, "responses")
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(settings), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("POCKETCTL_CODEX_HOMES", "")
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	cfg.Codex.RealBinary = binary
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 512))
	provider := sm.CodexRuntimeProvider()
	provider.probe = (agentcontrol.CodexProbe{Timeout: 25 * time.Second}).Probe
	ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer cancel()
	result, err := provider.Acquire(ctx, agentcontrol.AcquireRequest{
		Agent: agentcontrol.AgentCodex, ClientPID: os.Getpid(),
		Payload: agentcontrol.AcquirePayload{CWD: t.TempDir(), Intent: agentcontrol.IntentNew, OperationID: "live-smoke"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = provider.Release(context.Background(), agentcontrol.ReleaseRequest{Agent: agentcontrol.AgentCodex, Payload: agentcontrol.ReleasePayload{LeaseID: result.LeaseID}})
		_ = sm.ShutdownCodex()
	}()
	if result.Mode != string(agentcontrol.LaunchManaged) || !strings.HasPrefix(result.RemoteURI, "unix://") {
		t.Fatalf("result=%+v", result)
	}
	second, err := codexapp.DialUnix(ctx, strings.TrimPrefix(result.RemoteURI, "unix://"))
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	var initialized map[string]any
	if err := second.Initialize(ctx, map[string]any{
		"clientInfo":   map[string]string{"name": "pocketctl-second", "title": "Pocketctl Second", "version": "0.1"},
		"capabilities": map[string]any{"experimentalApi": true},
	}, &initialized); err != nil {
		t.Fatal(err)
	}
	client, generation, ok := provider.coordinator.backendClient()
	if !ok {
		t.Fatal("daemon app-server client unavailable")
	}
	backend := newCodexAppServerBackend(sm, provider.coordinator, client, generation)
	threadID, err := backend.Start(ctx, protocol.SessionConfig{
		Agent: "codex", Cwd: t.TempDir(),
		Permission: &protocol.PermissionConfig{Agent: "codex", ApprovalPolicy: "never", SandboxMode: "workspace-write"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if threadID == "" {
		t.Fatal("thread/start returned an empty id")
	}
	// A second client creates a terminal thread, as the native TUI does.
	var terminal struct{ Thread struct{ ID string } }
	if err := second.Call(ctx, "thread/start", map[string]any{"cwd": t.TempDir(), "modelProvider": "smoke", "model": "local-fixture"}, &terminal); err != nil {
		t.Fatal(err)
	}
	id := terminal.Thread.ID
	// A new native thread writes its persistent rollout on the first turn.
	// Let the independent client submit first. Its user-looking notification
	// must not gain a direct input proof on the daemon connection.
	var first struct{ Turn struct{ ID string } }
	if err := second.Call(ctx, "turn/start", map[string]any{"threadId": id, "input": []map[string]string{{"type": "text", "text": "native fixture input"}}}, &first); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case <-ctx.Done():
			t.Fatal("native turn did not complete")
		case message := <-second.Events():
			var params struct {
				ThreadID string
				Turn     struct{ ID string }
			}
			if message.Method != "turn/completed" || json.Unmarshal(message.Params, &params) != nil || params.ThreadID != id || params.Turn.ID != first.Turn.ID {
				continue
			}
		}
		break
	}
	select {
	case <-requested:
	case <-ctx.Done():
		t.Fatal("native model fixture was not reached")
	}
	for !slices.Contains(sm.SessionCapabilities(id), CodexTerminalSubmitCapability) {
		select {
		case <-ctx.Done():
			t.Fatal("terminal did not register")
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err := sm.SendMessageWithInput(ctx, UserMessageInput{TerminalSubmit: true, SessionID: id, RequestID: "terminal-smoke", MsgID: "1227028c-a313-4802-a307-39d38cc9949f", Content: "loopback fixture input"}); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case <-ctx.Done():
			t.Fatal("missing accepted terminal input")
		case ev := <-sm.outputCh:
			if ev.Type != "user_text" || ev.RequestID != "terminal-smoke" {
				continue
			}
			if ev.SessionID != id || ev.SourceTurnID == "" || ev.TurnID != logicalCodexTurnID(id, ev.SourceTurnID) || ev.MemorySource == nil || !ev.MemorySource.LineageComplete {
				t.Fatalf("invalid native input receipt for thread %q", id)
			}
			t.Logf("accepted terminal input: native turn %s, source %s", ev.SourceTurnID, ev.MemorySource.EventID)
			select {
			case <-requested:
				return
			case <-ctx.Done():
				t.Fatal("local model fixture was not reached")
			}
		}
	}
}
