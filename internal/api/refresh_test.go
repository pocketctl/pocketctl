package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRefreshFailureClassification(t *testing.T) {
	for _, tc := range []struct {
		name              string
		status            int
		body              string
		rejected, success bool
	}{
		{"expired", 401, `{"error":"invalid or expired refresh token"}`, true, false},
		{"missing user", 401, `{"error":"user not found"}`, true, false},
		{"throttled", 429, `{"error":"too many requests"}`, false, false},
		{"server unavailable", 503, `{"error":"unavailable"}`, false, false},
		{"proxy error", 502, `<html>bad gateway</html>`, false, false},
		{"malformed unauthorized", 401, `<html>unauthorized</html>`, false, false},
		{"missing rotation", 200, `{"access_token":"access"}`, false, false},
		{"malformed success", 200, `{`, false, false},
		{"success", 200, `{"access_token":"access","refresh_token":"rotated"}`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			at, rt, err := RefreshToken(srv.URL, "old", "machine")
			if errors.Is(err, ErrRefreshRejected) != tc.rejected {
				t.Fatalf("error=%v rejected=%v", err, tc.rejected)
			}
			if tc.success {
				if err != nil || at != "access" || rt != "rotated" {
					t.Fatalf("result=%q,%q,%v", at, rt, err)
				}
			} else if err == nil || at != "" || rt != "" {
				t.Fatalf("failure returned credentials: %q,%q,%v", at, rt, err)
			}
		})
	}
}

func TestRefreshRequestCancellation(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	defer srv.Close()
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, _, err := RefreshTokenContext(ctx, srv.URL, "old", "machine")
	if !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrRefreshRejected) {
		t.Fatalf("error=%v", err)
	}
}
