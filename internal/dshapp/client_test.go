package dshapp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestLoopbackCredentialFence(t *testing.T) {
	for _, raw := range []string{"https://example.com/?token=secret", "http://localhost:3000/", "http://127.0.0.1.evil.test/", "http://user@127.0.0.1/", "http://127.0.0.1/api/session/create", "file:///tmp/dsh"} {
		if _, err := ValidateURL(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:3000/?token=secret", "http://[::1]:3000/"} {
		if _, err := ValidateURL(raw); err != nil {
			t.Error(err)
		}
	}
}

func TestNativeCookieHandshakeRPCAndMux(t *testing.T) {
	var origin string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			if r.URL.Query().Get("token") != "secret" {
				t.Error("bootstrap token absent")
			}
			http.SetCookie(w, &http.Cookie{Name: "dsh", Value: "accepted", Path: "/"})
			http.Redirect(w, r, "/", 302)
			return
		}
		cookie, err := r.Cookie("dsh")
		if err != nil || cookie.Value != "accepted" {
			t.Error("missing cookie")
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("Origin") != origin {
			t.Error("origin mismatch")
		}
		if r.URL.Path == "/api/remote.mux" {
			upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
			ws, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			var value map[string]any
			if err := ws.ReadJSON(&value); err != nil {
				t.Error(err)
				return
			}
			if value["endpoint"] != "$events" {
				t.Error("wrong stream")
			}
			ws.WriteJSON(map[string]any{"type": "item"})
			return
		}
		var req struct {
			Type    string `json:"type"`
			RPCID   string `json:"rpcId"`
			Method  string `json:"method"`
			Payload struct {
				Args map[string]any `json:"args"`
			} `json:"payload"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if req.Type != "client-request" || req.RPCID == "" || req.Payload.Args == nil {
			t.Error("bad RPC envelope")
		}
		json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"ok": true, "value": map[string]any{"accepted": true}}})
	}))
	defer server.Close()
	origin = server.URL
	client, err := Connect(context.Background(), Config{URL: origin + "/?token=secret"})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ws, err := client.Mux(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err := Open(ws, "events", "$events", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	var frame any
	if err := ws.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
}

func TestConfigPrivateAndTransportErrorsRedactToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := Config{URL: "http://127.0.0.1:1/?token=never-print-this"}
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(ConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	_, err = Connect(context.Background(), cfg)
	if err == nil || strings.Contains(err.Error(), "never-print-this") {
		t.Fatalf("credential leaked or missing error: %v", err)
	}
}
