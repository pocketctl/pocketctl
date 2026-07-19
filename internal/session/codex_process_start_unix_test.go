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

func TestCodexAppServerHelperProcess(t *testing.T) {
	if os.Getenv("POCKETCTL_CODEX_HELPER") != "1" {
		return
	}
	socketPath := os.Getenv("POCKETCTL_CODEX_SOCKET")
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		os.Exit(2)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		os.Exit(2)
	}
	_ = os.Chmod(socketPath, 0o600)
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
