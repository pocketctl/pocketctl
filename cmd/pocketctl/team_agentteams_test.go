package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/ws"
)

func TestAgentTeamsStartupDefaultOffAndExplicitPrivateInstallation(t *testing.T) {
	t.Setenv("POCKETCTL_AGENTTEAMS_CONFIG", "")
	if cleanup, err := startAgentTeams(context.Background(), "invalid", "", nil, nil, nil, nil); err != nil || cleanup == nil {
		t.Fatal("default changed")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("POCKETCTL_TURN_ENRICHMENT", "enforce")
	token := filepath.Join(home, "bridge.token")
	if err := os.WriteFile(token, []byte("own-token"), 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agentteams/capabilities" || r.Header.Get("Authorization") != "Bearer own-token" {
			t.Error("unexpected endpoint or credential")
		}
		w.Header().Set("X-PocketCtl-Installation", "installation")
		json.NewEncoder(w).Encode(session.ExternalCapabilities{IdempotentSubmit: true, LookupByRequest: true, Cancellation: true, ArtifactExport: true})
	}))
	defer server.Close()
	path := filepath.Join(home, "agentteams.json")
	data, _ := json.Marshal(teamAgentTeamsConfig{Installation: "installation", OwnerUserID: 7, BridgeEndpoint: server.URL, BridgeTokenFile: token})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("POCKETCTL_AGENTTEAMS_CONFIG", path)
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 32))
	client := &ws.Client{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := startAgentTeams(ctx, "ws://127.0.0.1:19020/ws", "daemon", client, sm, nil, logger); err == nil {
		t.Fatal("missing durable journal was silently initialized")
	}
	scope, err := session.AgentTeamsExecutionScope("ws://127.0.0.1:19020/ws", "daemon", 7, "installation")
	if err != nil {
		t.Fatal(err)
	}
	j, err := session.InitializeAgentTeamsJournal(filepath.Join(home, ".pocketctl", "team-agentteams"), scope, "installation")
	if err != nil {
		t.Fatal(err)
	}
	j.Close()
	cleanup, err := startAgentTeams(ctx, "ws://127.0.0.1:19020/ws", "daemon", client, sm, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	cleanup()
	if err = os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = teamAgentTeamsPrivateFile(path, 16384); err == nil {
		t.Fatal("public configuration accepted")
	}
}
