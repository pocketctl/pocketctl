package memorysync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGrantClientPersonalFlowResolvesActiveInstallationAndMints(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer user-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/extensions/v1/installations":
			_, _ = w.Write([]byte(`{"installations":[
				{"installation_id":"i-paused","status":"paused","enabled_services":["memory.codegraph.write"]},
				{"installation_id":"i-active","status":"active","enabled_services":["memory.search","memory.codegraph.write"]},
				{"installation_id":"i-noservice","status":"active","enabled_services":["memory.search"]}
			]}`))
		case r.Method == "POST" && r.URL.Path == "/api/extensions/v1/grants":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["installation_id"] != "i-active" {
				t.Errorf("wrong installation: %v", body["installation_id"])
			}
			services, _ := body["services"].([]any)
			if len(services) != 1 || services[0] != "memory.codegraph.write" {
				t.Errorf("wrong services: %v", body["services"])
			}
			_, _ = w.Write([]byte(`{"token":"grant-token","token_type":"extension_capability","expires_in":60,"installation_id":"i-active","provider_public_origin":"https://memory.example"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	relayURL := strings.Replace(server.URL, "http://", "ws://", 1) + "/ws"
	client := NewGrantClient(relayURL, "user-token", server.Client())
	grant, err := client.CodegraphGrant(context.Background(), "")
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if grant.Token != "grant-token" || grant.InstallationID != "i-active" {
		t.Fatalf("grant: %+v", grant)
	}
	if grant.Origin != "https://memory.example" {
		t.Fatalf("origin: %q", grant.Origin)
	}
}

func TestGrantClientReportsBoundedErrorsWithoutBodyEcho(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"membership details follow: user 7 of team X"}`))
	}))
	defer server.Close()

	client := NewGrantClient(server.URL, "user-token", server.Client())
	_, err := client.CodegraphGrant(context.Background(), "")
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "membership") || strings.Contains(err.Error(), "user 7") {
		t.Fatalf("error leaks body: %s", err.Error())
	}
}

func TestGrantClientNoInstallationFailsClosed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if r.Method == "GET" {
			_, _ = w.Write([]byte(`{"installations":[]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := NewGrantClient(server.URL, "user-token", server.Client())
	_, err := client.CodegraphGrant(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "no_installation") {
		t.Fatalf("bounded no_installation expected: %v", err)
	}
}

func TestGrantClientScopedSelectionUsesV2Route(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if r.Method == "POST" && r.URL.Path == "/api/extensions/v2/grants" {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			ids, _ := body["installation_ids"].([]any)
			if len(ids) != 1 || ids[0] != "22222222-2222-4222-8222-222222222222" {
				t.Errorf("wrong scope: %v", body["installation_ids"])
			}
			services, _ := body["services"].([]any)
			if len(services) != 1 || services[0] != "memory.codegraph.write" {
				t.Errorf("wrong services: %v", body["services"])
			}
			_, _ = w.Write([]byte(`{"grant":"v2-token","token_type":"extension_capability_v2","expires_in":60,"provider_public_origin":"https://memory.example"}`))
			return
		}
		t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := NewGrantClient(server.URL, "user-token", server.Client())
	grant, err := client.CodegraphGrant(context.Background(), "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if grant.Token != "v2-token" || grant.InstallationID != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("grant: %+v", grant)
	}
}
