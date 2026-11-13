//go:build !windows

package session

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestStartCodexAppServerWaitsForInitializedPrivateSocket(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
	factory := func(string, string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestCodexAppServerHelperProcess$")
		cmd.Env = append(os.Environ(), "POCKETCTL_CODEX_HELPER=1")
		return cmd
	}
	runtime, err := startCodexAppServerWithFactory(context.Background(), "/fake/codex", "0.144.1", 3, 2*time.Second, factory)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Stop()
	if runtime.PID <= 0 || runtime.ProcessStartIdentity == "" || !codexProcessBirthMatches(runtime.PID, runtime.ProcessStartIdentity) || runtime.RemoteURI != "unix://"+runtime.Endpoint {
		t.Fatalf("runtime=%+v", runtime)
	}
	info, err := os.Stat(runtime.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode=%o want 600", info.Mode().Perm())
	}
}

func TestStartCodexStdioAppServerHasNoRemoteEndpointAndReapsProcess(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", t.TempDir())
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCodexStdioHelperProcess$")
	cmd.Env = []string{"POCKETCTL_CODEX_STDIO_HELPER=1", "GORACE=atexit_sleep_ms=0"}
	runtime, err := startCodexStdioProcess(ctx, cmd, t.TempDir(), 7)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Stop()
	if !runtime.PrivateStdio || runtime.RemoteURI != "" || runtime.Endpoint != "" || runtime.PID <= 0 || !codexProcessBirthMatches(runtime.PID, runtime.ProcessStartIdentity) {
		t.Fatalf("invalid private app-server runtime: %+v", runtime)
	}
	if err := probeCodexAppServer(ctx, runtime); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Stop(); err != nil {
		t.Fatal(err)
	}
	if codexProcessBirthMatches(runtime.PID, runtime.ProcessStartIdentity) {
		t.Fatal("private app-server process was not reaped")
	}
}

func TestInstalledCodexPrivateStdioProcess(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_SMOKE") != "1" {
		t.Skip("set POCKETCTL_CODEX_SMOKE=1 to test the installed Codex CLI")
	}
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.Command(binary, "app-server", "--listen", "stdio://")
	cmd.Env = []string{"HOME=" + dir, "CODEX_HOME=" + dir}
	runtime, err := startCodexStdioProcess(ctx, cmd, dir, 8)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Stop() })
	if err := probeCodexAppServer(ctx, runtime); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Stop(); err != nil {
		t.Fatal(err)
	}
	if codexProcessBirthMatches(runtime.PID, runtime.ProcessStartIdentity) {
		t.Fatal("installed app-server process was not reaped")
	}
}

func TestInstalledCodexPrivateProjectCoordinator(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_SMOKE") != "1" {
		t.Skip("set POCKETCTL_CODEX_SMOKE=1 to test the installed Codex CLI")
	}
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", t.TempDir())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	capabilities, err := (agentcontrol.CodexProbe{}).Probe(ctx, binary, "0.167.1")
	if err != nil {
		t.Fatal(err)
	}
	if !capabilities.IdleOnlyContext {
		t.Skip("installed Codex lacks idle-only Context admission")
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	provider := newCodexRuntimeProvider(sm)
	project, err := provider.projectCoordinator(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = project.shutdown() })
	first, err := project.ensureStarted(ctx, binary, capabilities.Version, capabilities)
	if err != nil || first.RemoteURI != "" || !first.HiddenContext {
		t.Fatalf("private project start = %+v, %v", first, err)
	}
	client, _, ok := project.backendClient()
	if !ok {
		t.Fatal("project client unavailable")
	}
	backend := newCodexAppServerBackend(sm, project, client, first.Generation)
	threadID, err := backend.Start(ctx, protocol.SessionConfig{Cwd: project.projectCwd})
	if err != nil || threadID == "" {
		t.Fatalf("create durable project thread: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	for {
		current, generation, ok := project.backendClient()
		if ok && current != client && generation > first.Generation {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("private project did not restart the installed Codex process")
		case <-time.After(10 * time.Millisecond):
		}
	}
	second, ok := project.status()
	if !ok || second.PID == first.PID || second.RemoteURI != "" || !second.HiddenContext {
		t.Fatalf("private replacement = %+v", second)
	}
	if err := backend.Resume(ctx, threadID); err != nil {
		t.Fatalf("resume the same thread in the replacement generation: %v", err)
	}
}

func TestCodexStdioHelperProcess(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_STDIO_HELPER") != "1" {
		return
	}
	input := json.NewDecoder(os.Stdin)
	output := json.NewEncoder(os.Stdout)
	for {
		var request struct{ ID json.RawMessage }
		if err := input.Decode(&request); err != nil {
			os.Exit(0)
		}
		if len(request.ID) > 0 {
			_ = output.Encode(map[string]any{"id": request.ID, "result": map[string]any{}})
		}
	}
}

func TestStartCodexAppServerStripsInheritedDesktopOrigin(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
	t.Setenv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "Codex Desktop")
	factory := func(string, string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestCodexAppServerHelperProcess$")
		cmd.Env = append(os.Environ(),
			"POCKETCTL_CODEX_HELPER=1",
			"POCKETCTL_EXPECT_CODEX_ORIGIN_CLEARED=1",
		)
		return cmd
	}

	runtime, err := startCodexAppServerWithFactory(
		context.Background(), "/fake/codex", "0.144.1", 4, 2*time.Second, factory,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Stop()
}

func TestStartCodexAppServerPreservesSelectedCodexHome(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "/tmp/codex-primary")
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
	selectedHome := "/tmp/codex-proxy"
	factory := func(string, string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestCodexAppServerHelperProcess$")
		cmd.Env = []string{
			"POCKETCTL_CODEX_HELPER=1",
			"POCKETCTL_EXPECT_CODEX_HOME=" + selectedHome,
		}
		return cmd
	}

	runtime, err := startCodexAppServerWithFactoryForHome(
		context.Background(), "/fake/codex", "0.144.1", 5, "codex-home-proxy", selectedHome, 2*time.Second, factory,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Stop()
}

func TestCodexInitializeDoesNotOptIntoUnsupportedOpenAIForm(t *testing.T) {
	capabilities := codexInitializeParams()["capabilities"].(map[string]any)
	if capabilities["experimentalApi"] != true {
		t.Fatalf("capabilities=%v", capabilities)
	}
	if _, advertised := capabilities["mcpServerOpenaiFormElicitation"]; advertised {
		t.Fatalf("unsupported OpenAI form capability was advertised: %v", capabilities)
	}
}

func TestStartCodexAppServerTimesOutWhenSocketNeverAppears(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
	factory := func(string, string) *exec.Cmd { return exec.Command("sh", "-c", "sleep 5") }
	start := time.Now()
	_, err := startCodexAppServerWithFactory(context.Background(), "/fake/codex", "0.144.1", 1, 50*time.Millisecond, factory)
	if err == nil {
		t.Fatal("expected readiness timeout")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("timeout took %v", elapsed)
	}
}

func shortCodexRuntimeDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "pc-codex-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestCodexRuntimeDirUsesConfiguredRuntimeDirectory(t *testing.T) {
	runtimeDir := t.TempDir()
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", runtimeDir)

	dir, err := codexRuntimeDir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != runtimeDir {
		t.Fatalf("runtime dir=%q want %q", dir, runtimeDir)
	}
}

func TestCodexAppServerHelperProcess(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_HELPER") != "1" {
		return
	}
	if os.Getenv("POCKETCTL_EXPECT_CODEX_ORIGIN_CLEARED") == "1" &&
		os.Getenv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE") != "" {
		os.Exit(3)
	}
	if expected := os.Getenv("POCKETCTL_EXPECT_CODEX_HOME"); expected != "" && os.Getenv("CODEX_HOME") != expected {
		os.Exit(4)
	}
	socketPath := os.Getenv("POCKETCTL_CODEX_SOCKET")
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		os.Exit(2)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		os.Exit(2)
	}
	upgrader := websocket.Upgrader{}
	server := http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, upgradeErr := upgrader.Upgrade(w, r, nil)
		if upgradeErr != nil {
			return
		}
		defer conn.Close()
		for {
			_, raw, readErr := conn.ReadMessage()
			if readErr != nil {
				return
			}
			var request struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			_ = json.Unmarshal(raw, &request)
			if request.Method == "test/stderr" {
				_, _ = io.WriteString(os.Stderr, "actual session content /Users/private/session secret-token\n")
			}
			_ = conn.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{"userAgent": "fake"}})
		}
	})}
	_ = server.Serve(listener)
	os.Exit(0)
}

func TestCodexStartupFailureDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name, script, phase, diagnosis, errorText string
		timeout                                   time.Duration
	}{
		{"early_exit", "printf 'Error: CODEX_HOME points to /private/secret, but that path does not exist\\n' >&2; sleep 0.1; exit 1", "early_exit", "codex_home_missing", "exited before ready", 2 * time.Second},
		{"clean_exit", "printf 'unknown secret-token\\n' >&2; sleep 0.1; exit 0", "early_exit", "stderr_redacted", "exited before ready", 2 * time.Second},
		{"timeout", "printf 'Permission denied /private/secret Bearer secret-token\\n' >&2; exec sleep 5", "readiness_timeout", "permission_denied", "readiness timeout", 200 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
			logs := captureCodexStartupLogs(t)
			factory := func(string, string) *exec.Cmd { return exec.Command("sh", "-c", tc.script) }
			_, err := startCodexAppServerWithFactory(context.Background(), "/fake/codex", "test", 9, tc.timeout, factory)
			if err == nil || !strings.Contains(err.Error(), tc.errorText) {
				t.Fatalf("error=%v", err)
			}
			for _, want := range []string{`"phase":"` + tc.phase + `"`, `"diagnosis":"` + tc.diagnosis + `"`} {
				if !strings.Contains(logs.String(), want) {
					t.Fatalf("missing %s in %s", want, logs)
				}
			}
			for _, private := range []string{"secret-token", "/private/secret", "CODEX_HOME points to"} {
				if strings.Contains(logs.String(), private) || strings.Contains(runtimeProtocolError(err).Error(), private) {
					t.Fatalf("stderr leaked to logs or client: %s", private)
				}
			}
		})
	}
}

func TestCodexStartupIdentityFailureDiagnostics(t *testing.T) {
	for _, identityErr := range []error{errors.New("kernel query failed"), nil} {
		t.Run(fmtIdentityFailure(identityErr), func(t *testing.T) {
			t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
			logs := captureCodexStartupLogs(t)
			var cmd *exec.Cmd
			factory := func(string, string) *exec.Cmd {
				cmd = exec.Command("sleep", "5")
				return cmd
			}
			identify := func(int) (string, error) {
				_, _ = io.WriteString(cmd.Stderr, "Permission denied /Users/private secret-token")
				return "", identityErr
			}
			_, err := startCodexAppServerWithIdentity(context.Background(), "fake", 12, "", "", time.Second, factory, identify)
			if err == nil || !strings.Contains(err.Error(), "identify Codex app-server process") || strings.Contains(err.Error(), "%!w") {
				t.Fatalf("error=%v", err)
			}
			if cmd.ProcessState == nil || !strings.Contains(logs.String(), `"phase":"process_identity"`) || !strings.Contains(logs.String(), `"diagnosis":"permission_denied"`) {
				t.Fatalf("process not reaped or missing identity diagnostic: %s", logs)
			}
			if strings.Contains(logs.String(), "private") || strings.Contains(runtimeProtocolError(err).Error(), "secret-token") {
				t.Fatal("identity failure leaked stderr")
			}
		})
	}
}

func fmtIdentityFailure(err error) string {
	if err == nil {
		return "empty_identity"
	}
	return "query_failure"
}

func TestCodexStartupSuccessDisablesAttachedStderr(t *testing.T) {
	t.Setenv("POCKETCTL_CODEX_RUNTIME_DIR", shortCodexRuntimeDir(t))
	logs := captureCodexStartupLogs(t)
	var cmd *exec.Cmd
	factory := func(string, string) *exec.Cmd {
		cmd = exec.Command(os.Args[0], "-test.run=^TestCodexAppServerHelperProcess$")
		cmd.Env = []string{"POCKETCTL_CODEX_HELPER=1"}
		return cmd
	}
	runtime, err := startCodexAppServerWithIdentity(context.Background(), "fake", 13, "", "", 2*time.Second, factory, platform.ProcessStartIdentity)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runtime.Client.Call(ctx, "test/stderr", nil, nil); err != nil {
		t.Fatal(err)
	}
	_ = runtime.Stop() // joins exec's copying goroutine before inspecting state
	s := cmd.Stderr.(*codexStartupStderr)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stopped || s.buf != nil || logs.Len() != 0 {
		t.Fatal("post-initialize stderr was retained or logged")
	}
}
