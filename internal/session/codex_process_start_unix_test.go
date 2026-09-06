//go:build !windows

package session

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
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
	if runtime.PID <= 0 || runtime.RemoteURI != "unix://"+runtime.Endpoint {
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
				ID json.RawMessage `json:"id"`
			}
			_ = json.Unmarshal(raw, &request)
			_ = conn.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{"userAgent": "fake"}})
		}
	})}
	_ = server.Serve(listener)
	os.Exit(0)
}
