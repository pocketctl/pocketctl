package teamdelivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPClientUsesFreshTokenAndRejectsRedirects(t *testing.T) {
	var observed []string
	redirectReached := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed = append(observed, r.Header.Get("Authorization"))
		if r.URL.Path == "/redirect-target" {
			redirectReached = true
			return
		}
		if strings.Contains(r.URL.Path, "redirect") {
			http.Redirect(w, r, "/redirect-target", http.StatusTemporaryRedirect)
			return
		}
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":{"code":"team_not_found"}}`))
	}))
	defer server.Close()
	token := "first"
	client, err := NewClient(strings.Replace(server.URL, "http:", "ws:", 1)+"/ws", func() string { return token }, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if receipt, err := client.Receipt(context.Background(), "task", "key"); receipt != nil || err != nil {
		t.Fatalf("missing receipt: %v", err)
	}
	token = "refreshed"
	if _, err := client.Receipt(context.Background(), "task", "key"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Receipt(context.Background(), "redirect", "key"); err == nil {
		t.Fatal("redirect accepted")
	}
	if redirectReached || len(observed) != 3 || observed[0] != "Bearer first" || observed[1] != "Bearer refreshed" {
		t.Fatalf("token/redirect handling: %v", observed)
	}
}

func TestHTTPClientRejectsTruncatedSuccessAndWrongDaemonJobs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			_, _ = w.Write([]byte(`{"submission_id":`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"owner_user_id": 1, "jobs": []any{fixtureJob()}, "next_cursor": nil})
	}))
	defer server.Close()
	client, err := NewClient(server.URL, func() string { return "test" }, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := Collect(fixtureWorkspace(t), fixtureJob())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Prepare(context.Background(), "task", snapshot.Submission); err == nil {
		t.Fatal("truncated response treated as success")
	}
	if page, err := client.Jobs(context.Background(), "daemon-1", ""); err != nil || len(page.Jobs) != 1 {
		t.Fatalf("valid jobs rejected: %v", err)
	}
	if _, err := client.Jobs(context.Background(), "daemon-other", ""); err == nil {
		t.Fatal("other daemon jobs accepted")
	}
}

func TestHTTPClientRejectsCredentialAndQueryURLs(t *testing.T) {
	for _, value := range []string{"https://user:password@example.com/ws", "https://example.com/ws?token=secret", "https://example.com/ws#fragment", "file:///tmp/relay", "invalid"} {
		if _, err := NewClient(value, func() string { return "token" }, nil); err == nil {
			t.Errorf("accepted URL %s", value)
		}
	}
}
