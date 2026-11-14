package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestDownloadReportsVerificationFailureAndFallback(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("bad")) }))
	defer bad.Close()
	good := []byte("official-binary")
	safe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(good) }))
	defer safe.Close()
	var path string
	var err error
	out := captureProgress(t, func() {
		path, err = DownloadAndVerify(&BinaryInfo{URL: bad.URL, FallbackURLs: []string{safe.URL}, SHA: hexSHA(good)})
	})
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	for _, want := range []string{"SHA256 mismatch", strings.TrimPrefix(bad.URL, "http://"), strings.TrimPrefix(safe.URL, "http://")} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing source/failure diagnostic %q in %q", want, out)
		}
	}
}

func TestDownloadDiagnosticsDoNotExposeURLCredentials(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	defer s.Close()
	raw := strings.Replace(s.URL, "://", "://user:private-password@", 1) + "/private-token?secret=private-query"
	var err error
	out := captureProgress(t, func() { _, err = DownloadAndVerify(&BinaryInfo{URL: raw, SHA: hexSHA([]byte("x"))}) })
	if err == nil {
		t.Fatal("expected failure")
	}
	for _, secret := range []string{"private-password", "private-token", "private-query"} {
		if strings.Contains(out+err.Error(), secret) {
			t.Fatalf("URL secret exposed: %q", secret)
		}
	}
}

func TestDownloadMalformedRedirectDoesNotExposeURLCredentials(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "https://user:private-password@example.com/private-token%zz?secret=private-query")
		w.WriteHeader(http.StatusFound)
	}))
	defer s.Close()
	var err error
	out := captureProgress(t, func() {
		_, err = downloadWithPolicy(context.Background(), &BinaryInfo{URL: s.URL, SHA: hexSHA([]byte("x"))}, shortDownloadPolicy(), os.Stderr)
	})
	if err == nil {
		t.Fatal("expected malformed redirect failure")
	}
	for _, secret := range []string{"private-password", "private-token", "private-query"} {
		if strings.Contains(out+err.Error(), secret) {
			t.Fatalf("redirect URL secret exposed: %q", secret)
		}
	}
}

func TestDownloadReportsEachTransientRetry(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte("official"))
	}))
	defer s.Close()
	var path string
	var err error
	out := captureProgress(t, func() {
		path, err = downloadWithPolicy(context.Background(), &BinaryInfo{URL: s.URL, SHA: hexSHA([]byte("official"))}, shortDownloadPolicy(), os.Stderr)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	if calls != 3 || !strings.Contains(out, "3/3") || strings.Count(out, "503") != 2 {
		t.Fatalf("retry trace incomplete: calls=%d output=%q", calls, out)
	}
}

func TestDownloadFailureRetainsEverySourceReason(t *testing.T) {
	missing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotFound) }))
	defer missing.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("bad")) }))
	defer bad.Close()
	_, err := DownloadAndVerify(&BinaryInfo{URL: missing.URL, FallbackURLs: []string{bad.URL}, SHA: hexSHA([]byte("official"))})
	if err == nil || !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), "SHA256 mismatch") {
		t.Fatalf("source failure history lost: %v", err)
	}
}
