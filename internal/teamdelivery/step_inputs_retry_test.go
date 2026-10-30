package teamdelivery

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestStepInputReadTransientBusy(t *testing.T) {
	for _, path := range []string{"/manifest", "/artifacts/proof"} {
		t.Run(path, func(t *testing.T) {
			reads := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reads++
				if r.Method != "GET" || r.URL.Path != path || r.Header.Get("Authorization") != "Bearer token" {
					t.Errorf("changed request identity")
				}
				if reads < 3 {
					w.WriteHeader(503)
					_, _ = w.Write([]byte(`{"error":{"code":"source_busy","retryable":true}}`))
					return
				}
				_, _ = w.Write([]byte("frozen bytes"))
			}))
			defer server.Close()
			client, _ := NewClient(server.URL, func() string { return "token" }, server.Client())
			got, err := client.readInputBytes(context.Background(), path, 1024)
			if err != nil || string(got) != "frozen bytes" || reads != 3 {
				t.Fatalf("got %q, %v, reads %d", got, err, reads)
			}
		})
	}
}

func TestStepInputReadErrorBoundaries(t *testing.T) {
	for _, tc := range []struct {
		code      string
		status    int
		retryable bool
		reads     int
	}{
		{"source_busy", 503, true, 4}, {"source_busy", 503, false, 1},
		{"artifact_unavailable", 503, true, 1}, {"team_feature_disabled", 503, true, 1},
		{"authorization_required", 401, true, 1}, {"team_not_found", 404, true, 1},
		{"artifact_integrity", 400, false, 1}, {"revision_conflict", 409, true, 1},
	} {
		t.Run(tc.code+http.StatusText(tc.status), func(t *testing.T) {
			reads := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reads++
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": tc.code, "retryable": tc.retryable}})
			}))
			defer server.Close()
			client, _ := NewClient(server.URL, func() string { return "token" }, server.Client())
			_, err := client.readInputBytes(context.Background(), "/manifest", 1024)
			var failure *HTTPError
			if !errors.As(err, &failure) || failure.Code != tc.code || failure.Status != tc.status || reads != tc.reads {
				t.Fatalf("error %v, reads %d", err, reads)
			}
		})
	}
}

func TestStepInputReadCancellationDuringBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads++
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{"error":{"code":"source_busy","retryable":true}}`))
		cancel()
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, func() string { return "token" }, server.Client())
	start := time.Now()
	_, err := client.readInputBytes(ctx, "/manifest", 1024)
	if !errors.Is(err, context.Canceled) || reads != 1 || time.Since(start) > time.Second {
		t.Fatalf("error %v, reads %d", err, reads)
	}
}

func TestStepInputReadDoesNotRetryAmbiguousErrors(t *testing.T) {
	for _, body := range []string{
		`<html>unavailable</html>`,
		`{"error":{"code":"source_busy","retryable":"true"}}`,
		`{"error":{"code":"source_busy","retryable":true}} trailing`,
		`{"error":{"code":"private /path secret","retryable":true}}`,
	} {
		t.Run(body, func(t *testing.T) {
			reads := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reads++
				w.WriteHeader(503)
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			client, _ := NewClient(server.URL, func() string { return "token" }, server.Client())
			_, err := client.readInputBytes(context.Background(), "/manifest", 1024)
			if err == nil || err.Error() != "delivery_http_503:step_input_unavailable" || reads != 1 {
				t.Fatalf("error %v, reads %d", err, reads)
			}
		})
	}
}

func TestStepInputRetryRechecksAuthorization(t *testing.T) {
	reads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads++
		if reads == 1 {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"error":{"code":"source_busy","retryable":true}}`))
			return
		}
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"error":{"code":"access_denied","retryable":false}}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, func() string { return "token" }, server.Client())
	_, err := client.readInputBytes(context.Background(), "/manifest", 1024)
	if err == nil || err.Error() != "delivery_http_403:access_denied" || reads != 2 {
		t.Fatalf("error %v, reads %d", err, reads)
	}
}
