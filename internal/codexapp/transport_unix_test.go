//go:build !windows

package codexapp

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestDialUnixUsesWebSocketHTTPUpgrade(t *testing.T) {
	socketPath := filepath.Join(shortUnixTempDir(t), "a.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	upgrader := websocket.Upgrader{}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rpc" {
			t.Errorf("upgrade path=%q", r.URL.Path)
		}
		conn, upgradeErr := upgrader.Upgrade(w, r, nil)
		if upgradeErr != nil {
			return
		}
		defer conn.Close()
		_, raw, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		var request struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal(raw, &request)
		_ = conn.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{"ready": true}})
	})}
	go server.Serve(listener)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, err := DialUnix(ctx, socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var result struct {
		Ready bool `json:"ready"`
	}
	if err := client.Call(ctx, "initialize", map[string]any{}, &result); err != nil {
		t.Fatal(err)
	}
	if !result.Ready {
		t.Fatalf("result=%+v", result)
	}
}

func TestDialUnixReturnsResponseWhenServerClosesImmediately(t *testing.T) {
	for attempt := 0; attempt < 200; attempt++ {
		TestDialUnixUsesWebSocketHTTPUpgrade(t)
	}
}

func shortUnixTempDir(t *testing.T) string {
	t.Helper()
	base := os.TempDir()
	if runtime.GOOS == "darwin" {
		base = "/private/tmp"
	}
	dir, err := os.MkdirTemp(base, "pcx-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
