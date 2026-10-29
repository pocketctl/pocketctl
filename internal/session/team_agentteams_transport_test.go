package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentTeamsBridgeTransportPreservesOriginalAcrossTwoJournals(t *testing.T) {
	ctx := context.Background()
	f := &agentTeamsRemoteFixture{loseDelegate: true}
	bridgeJournal, executor, r := agentTeamsFixture(t, t.TempDir(), f)
	defer bridgeJournal.Close()
	token := func(context.Context) (string, error) { return "dedicated-private-token", nil }
	h, err := NewAgentTeamsBridgeHandler(executor, "fixed-installation", token)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h)
	defer server.Close()
	client, err := NewAgentTeamsBridgeClient(server.URL, "fixed-installation", token, nil)
	if err != nil {
		t.Fatal(err)
	}
	local, err := OpenExternalJournal(t.TempDir(), r.Identity.Scope)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	coordinator, err := NewExternalCoordinator(local, client, externalAllow)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = coordinator.Start(ctx, r); !errors.Is(err, ErrExternalUnknown) {
		t.Fatal("lost response not preserved", err)
	}
	receipt, err := coordinator.Start(ctx, r)
	if err != nil || receipt.Identity != r.Identity {
		t.Fatal(receipt, err)
	}
	if len(f.calls) != 4 {
		t.Fatal("HTTP recovery delegated twice", f.calls)
	}
	if err = coordinator.Revoke(ctx, r.Identity.CallID); err == nil {
		t.Fatal("unconfirmed cancellation hidden")
	}
	if _, err = coordinator.Recover(ctx, r.Identity.CallID); !errors.Is(err, ErrExternalRevoked) {
		t.Fatal("revoked HTTP result exposed", err)
	}
}
func TestAgentTeamsBridgeTransportAbsenceRequiresExactInstallationAndReceipt(t *testing.T) {
	ctx := context.Background()
	token := func(context.Context) (string, error) { return "token", nil }
	r, _ := externalRequestFixture()
	for _, tc := range []struct {
		name, installation, code string
		status                   int
		want                     error
	}{
		{"real-absence", "installation-1", "request_absent", 404, ErrExternalNotFound},
		{"wrong-installation", "installation-2", "request_absent", 404, ErrExternalUnknown},
		{"generic-404", "installation-1", "route_not_found", 404, ErrExternalUnknown},
		{"unauthorized", "installation-1", "request_absent", 401, ErrExternalUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("X-PocketCtl-Installation", tc.installation)
				w.WriteHeader(tc.status)
				json.NewEncoder(w).Encode(map[string]string{"code": tc.code})
			}))
			defer server.Close()
			client, err := NewAgentTeamsBridgeClient(server.URL, "installation-1", token, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = client.Lookup(ctx, r.Identity); !errors.Is(err, tc.want) {
				t.Fatal(err)
			}
		})
	}
}
func TestAgentTeamsBridgeTransportRejectsWrongCredentialBeforeMutation(t *testing.T) {
	f := &agentTeamsRemoteFixture{}
	j, e, r := agentTeamsFixture(t, t.TempDir(), f)
	defer j.Close()
	h, err := NewAgentTeamsBridgeHandler(e, "installation-1", func(context.Context) (string, error) { return "correct", nil })
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h)
	defer server.Close()
	client, err := NewAgentTeamsBridgeClient(server.URL, "installation-1", func(context.Context) (string, error) { return "wrong", nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Submit(context.Background(), r); err == nil {
		t.Fatal("wrong credentials submitted")
	}
	if len(f.calls) != 0 {
		t.Fatal("unauthenticated mutation", f.calls)
	}
}

// Frozen P1 bundles are JSON encoded twice (including base64 request bytes).
// Exercise real HTTP above the old 8 MiB client ceiling and check exact bytes.
func TestAgentTeamsBridgeSubmitLargeFrozenRequest(t *testing.T) {
	r, _ := externalRequestFixture()
	r.Input = []byte(`{"payload":"` + strings.Repeat("x", 9*1024*1024) + `"}`)
	r.InputDigest = externalPayloadDigest(r.Input)
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		posts++
		var received ExternalExecutionRequest
		if err := json.NewDecoder(req.Body).Decode(&received); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if received.Identity != r.Identity || !bytes.Equal(received.Input, r.Input) || received.InputDigest != externalPayloadDigest(received.Input) {
			t.Error("frozen request changed")
		}
		w.Header().Set("X-PocketCtl-Installation", "installation")
		json.NewEncoder(w).Encode(ExternalExecutionReceipt{Identity: r.Identity, InputDigest: r.InputDigest, RemoteTaskID: "original-task", Sequence: 1, State: ExternalRunning})
	}))
	defer server.Close()
	client, err := NewAgentTeamsBridgeClient(server.URL, "installation", func(context.Context) (string, error) { return "dedicated-token", nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := client.Submit(context.Background(), r)
	if err != nil || posts != 1 || receipt.Identity != r.Identity {
		t.Fatalf("large frozen submit: posts=%d err=%v", posts, err)
	}
}
