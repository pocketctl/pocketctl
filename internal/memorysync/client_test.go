package memorysync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeGrantSource struct {
	mu     sync.Mutex
	calls  int
	tokens []string // returned in order; last repeats
}

func (f *fakeGrantSource) Grant(ctx context.Context, scopeInstallationID string) (Grant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if len(f.tokens) == 0 {
		return Grant{}, fmt.Errorf("no_installation")
	}
	token := f.tokens[len(f.tokens)-1]
	if f.calls-1 < len(f.tokens) {
		token = f.tokens[f.calls-1]
	}
	return Grant{Token: token, Origin: "origin-set-in-tests"}, nil
}

func (f *fakeGrantSource) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func smallSnapshot() *Snapshot {
	return &Snapshot{
		CommitSHA:          strings.Repeat("a", 40),
		GitObjectFormat:    "sha1",
		RepositoryKey:      "github.com/example/repo",
		CanonicalRemote:    "https://github.com/example/repo.git",
		ManifestSHA256:     strings.Repeat("b", 64),
		ParserMatrixVersion: ParserMatrixVersion,
		TotalBytes:         3,
		Entries: []CollectedEntry{{
			Path:       "src/a.ts",
			GitMode:    "100644",
			Language:   "typescript",
			Capability: "symbols_and_edges",
			BlobSHA256: strings.Repeat("c", 64),
			ByteCount:  3,
			Content:    []byte("abc"),
		}},
	}
}

func TestUploadClientRetriesTransientServerErrors(t *testing.T) {
	var attempts int32
	idempotencyKeys := sync.Map{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		var body map[string]any
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
		if key, ok := body["idempotency_key"].(string); ok {
			count, _ := idempotencyKeys.LoadOrStore(key, int32(0))
			idempotencyKeys.Store(key, count.(int32)+1)
		}
		switch {
		case r.URL.Path == "/api/v1/memory/code-snapshots" && r.Method == "POST":
			if atomic.LoadInt32(&attempts) == 1 {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"error":"upstream melted with secret detail"}`))
				return
			}
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"snapshot_id":"snap-1"}`))
		case r.URL.Path == "/api/v1/memory/code-snapshots/snap-1/files" && r.Method == "PUT":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"accepted":1}`))
		case r.URL.Path == "/api/v1/memory/code-snapshots/snap-1/finalize" && r.Method == "POST":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"snapshot_id":"snap-1","state":"ready"}`))
		default:
			t.Errorf("unexpected call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewUploadClient(UploadClientOptions{
		MemoryOrigin: server.URL,
		GrantSource:  &fakeGrantSource{tokens: []string{"grant-1"}},
		RetryWait:    time.Millisecond,
	})
	result, err := client.SyncSnapshot(context.Background(), "idem-1", smallSnapshot())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.SnapshotID != "snap-1" {
		t.Fatalf("snapshot id: %+v", result)
	}
	if atomic.LoadInt32(&attempts) < 2 {
		t.Fatalf("no retry happened: %d attempts", attempts)
	}
	// The same idempotency key must be reused across retries of start.
	reused := false
	idempotencyKeys.Range(func(key, value any) bool {
		if value.(int32) > 1 {
			reused = true
		}
		return true
	})
	if !reused {
		t.Fatal("idempotency key not reused across start retries")
	}
}

func TestUploadClientRefreshesGrantOnAuthorizationFailure(t *testing.T) {
	var grantMu sync.Mutex
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("authorization")
		grantMu.Lock()
		seen = append(seen, auth)
		valid := auth == "Bearer fresh-grant"
		grantMu.Unlock()
		if !valid {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":"unauthorized"}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"snapshot_id":"snap-2"}`))
	}))
	defer server.Close()

	source := &fakeGrantSource{tokens: []string{"stale-grant", "fresh-grant"}}
	client := NewUploadClient(UploadClientOptions{
		MemoryOrigin: server.URL,
		GrantSource:  source,
		RetryWait:    time.Millisecond,
	})
	result, err := client.SyncSnapshot(context.Background(), "idem-2", smallSnapshot())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.SnapshotID != "snap-2" {
		t.Fatalf("snapshot id: %+v", result)
	}
	if source.callCount() != 2 {
		t.Fatalf("grant refresh count: %d", source.callCount())
	}
	grantMu.Lock()
	defer grantMu.Unlock()
	// The full start/files/finalize sequence runs; every request after the
	// initial 401 must carry the refreshed grant.
	if len(seen) < 2 || seen[0] != "Bearer stale-grant" || seen[1] != "Bearer fresh-grant" {
		t.Fatalf("authorization sequence: %v", seen)
	}
	for _, auth := range seen[1:] {
		if auth != "Bearer fresh-grant" {
			t.Fatalf("stale grant reused: %v", seen)
		}
	}
}

func TestUploadClientRedactsServerErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("postgres password hunter2 at 10.0.0.1 exploded"))
	}))
	defer server.Close()

	client := NewUploadClient(UploadClientOptions{
		MemoryOrigin: server.URL,
		GrantSource:  &fakeGrantSource{tokens: []string{"g"}},
		RetryWait:    time.Millisecond,
		RetryMax:     1,
	})
	_, err := client.SyncSnapshot(context.Background(), "idem-3", smallSnapshot())
	if err == nil {
		t.Fatal("expected failure")
	}
	message := err.Error()
	for _, leak := range []string{"hunter2", "10.0.0.1", "postgres"} {
		if strings.Contains(message, leak) {
			t.Fatalf("error leaks server body: %s", message)
		}
	}
	if !strings.Contains(message, "500") {
		t.Fatalf("error lacks bounded status: %s", message)
	}
}

func TestUploadClientRejectsGrantRefusalWithBoundedCode(t *testing.T) {
	client := NewUploadClient(UploadClientOptions{
		MemoryOrigin: "http://127.0.0.1:1",
		GrantSource:  &fakeGrantSource{}, // returns no_installation
		RetryWait:    time.Millisecond,
	})
	_, err := client.SyncSnapshot(context.Background(), "idem-4", smallSnapshot())
	if err == nil || !strings.Contains(err.Error(), "no_installation") {
		t.Fatalf("bounded grant error expected: %v", err)
	}
}

func TestBatchingKeepsRequestsUnderTheBodyBudget(t *testing.T) {
	var bodies []int64
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"snapshot_id":"snap-5"}`))
			return
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		mu.Lock()
		bodies = append(bodies, int64(len(raw)))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	snap := &Snapshot{
		CommitSHA:           strings.Repeat("a", 40),
		GitObjectFormat:     "sha1",
		RepositoryKey:       "k",
		ManifestSHA256:      strings.Repeat("b", 64),
		ParserMatrixVersion: ParserMatrixVersion,
	}
	big := strings.Repeat("z", 512*1024) // 512 KiB payloads, base64 inflates ~4/3
	for i := 0; i < 6; i++ {
		snap.Entries = append(snap.Entries, CollectedEntry{
			Path:       fmt.Sprintf("src/file%02d.ts", i),
			GitMode:    "100644",
			Language:   "typescript",
			Capability: "symbols_and_edges",
			BlobSHA256: strings.Repeat(fmt.Sprint(i), 64),
			ByteCount:  int64(len(big)),
			Content:    []byte(big),
		})
	}

	client := NewUploadClient(UploadClientOptions{
		MemoryOrigin: server.URL,
		GrantSource:  &fakeGrantSource{tokens: []string{"g"}},
		RetryWait:    time.Millisecond,
	})
	if _, err := client.SyncSnapshot(context.Background(), "idem-5", snap); err != nil {
		t.Fatalf("sync: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) < 2 {
		t.Fatalf("expected multiple batches, got %d", len(bodies))
	}
	for _, size := range bodies {
		if size > MaxRequestBytes {
			t.Fatalf("batch body %d exceeds %d", size, MaxRequestBytes)
		}
	}
}
