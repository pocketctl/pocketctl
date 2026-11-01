package memorysync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestScopeDiscoveryJoinsAuthorizedNamesAndPermissions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer account-token" {
			t.Errorf("unexpected request")
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/extensions/v2/installations":
			_, _ = w.Write([]byte(`{"installations":[
              {"installation_id":"personal-id","provider_id":"pocketctl-memory","status":"active","owner_scope_kind":"personal","owner_scope_id":"unused-owner-id"},
              {"installation_id":"team-installation","provider_id":"pocketctl-memory","status":"paused","owner_scope_kind":"team","owner_scope_id":"team-scope"},
              {"installation_id":"org-installation","provider_id":"pocketctl-memory","status":"active","owner_scope_kind":"organization","owner_scope_id":"org-scope"},
              {"installation_id":"removed-team","provider_id":"pocketctl-memory","status":"active","owner_scope_kind":"team","owner_scope_id":"removed-scope"},
              {"installation_id":"other","provider_id":"other-provider","status":"active","owner_scope_kind":"personal"}
            ]}`))
		case "/api/extensions/v2/scopes":
			_, _ = w.Write([]byte(`{"scopes":[{"owner_scope_kind":"personal","owner_scope_id":"personal-id","name":"personal","permissions":[]},{"owner_scope_kind":"team","owner_scope_id":"team-scope","name":"工程团队","permissions":["read","contribute"]},{"owner_scope_kind":"organization","owner_scope_id":"org-scope","name":"只读组织","permissions":["read"]}]}`))
		default:
			t.Errorf("unexpected route: %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	result, err := NewGrantClient(server.URL, "account-token", server.Client()).ListScopes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.SharedScopesAvailable || len(result.Scopes) != 3 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.Scopes[0].InstallationID != "personal-id" || result.Scopes[1].Name != "工程团队" || strings.Join(result.Scopes[1].Permissions, ",") != "contribute,read" {
		t.Fatalf("bad metadata: %+v", result)
	}
	if result.Scopes[2].Kind != "organization" || strings.Join(result.Scopes[2].Permissions, ",") != "read" {
		t.Fatal("organization permissions changed")
	}
}

func TestScopeDiscoveryLegacyFallbackIsExplicit(t *testing.T) {
	for _, status := range []int{404, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/extensions/v2/installations" {
					w.WriteHeader(status)
					_, _ = w.Write([]byte(`{"error":{"code":"feature_disabled"}}`))
					return
				}
				if r.URL.Path != "/api/extensions/v1/installations" {
					t.Errorf("unexpected route: %s", r.URL.Path)
				}
				_, _ = w.Write([]byte(`{"installations":[{"installation_id":"mine","provider_id":"pocketctl-memory","status":"active"},{"installation_id":"old","provider_id":"pocketctl-memory","status":"revoked"}]}`))
			}))
			defer server.Close()
			result, err := NewGrantClient(server.URL, "token", server.Client()).ListScopes(context.Background())
			if err != nil || result.SharedScopesAvailable || len(result.Scopes) != 1 || result.Scopes[0].Kind != "personal" {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}

func TestScopeDiscoveryRejectsErrorsWithoutFallbackOrBodyEcho(t *testing.T) {
	for _, status := range []int{401, 403, 500, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":{"code":"unavailable","message":"credential-do-not-echo"}}`))
			}))
			defer server.Close()
			_, err := NewGrantClient(server.URL, "secret-token", server.Client()).ListScopes(context.Background())
			if err == nil || calls != 1 || strings.Contains(err.Error(), "credential") || strings.Contains(err.Error(), "secret-token") {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestScopeDiscoveryMalformedResponseIsNotAnEmptyScopeList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer server.Close()
	_, err := NewGrantClient(server.URL, "token", server.Client()).ListScopes(context.Background())
	if err == nil || err.Error() != "invalid_response" {
		t.Fatalf("unexpected error: %v", err)
	}
}
