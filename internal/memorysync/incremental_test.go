package memorysync

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIncrementalTransferSendsOnlyMissingBodiesAndFullManifest(t *testing.T) {
	retained := map[string]bool{}
	uploaded := []string{}
	manifest := []string{}
	ready := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/memory/code-snapshots":
			state := "staging"
			if ready {
				state = "active"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"snapshot_id": "snapshot", "repository_id": "repo", "state": state})
		case strings.HasSuffix(r.URL.Path, "/manifest"):
			var request struct {
				Entries []ManifestFileEntry `json:"entries"`
			}
			_ = json.NewDecoder(r.Body).Decode(&request)
			missing := []string{}
			for _, e := range request.Entries {
				manifest = append(manifest, e.Path)
				if !retained[e.BlobSHA256] {
					missing = append(missing, e.Path)
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"missing_paths": missing})
		case strings.HasSuffix(r.URL.Path, "/files"):
			var request CodeSnapshotFileBatch
			_ = json.NewDecoder(r.Body).Decode(&request)
			if request.BatchKey == "" {
				t.Error("missing stable batch content key")
			}
			for _, e := range request.Entries {
				body, err := base64.StdEncoding.DecodeString(e.ContentBase64)
				if err != nil || fmt.Sprintf("%x", sha256.Sum256(body)) != e.BlobSHA256 {
					t.Error("invalid content")
				}
				retained[e.BlobSHA256] = true
				uploaded = append(uploaded, e.Path)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"accepted": len(request.Entries)})
		case strings.HasSuffix(r.URL.Path, "/finalize"):
			_ = json.NewEncoder(w).Encode(map[string]any{"snapshot_id": "snapshot", "state": "ready"})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	client := NewUploadClient(UploadClientOptions{MemoryOrigin: server.URL, GrantSource: &fakeGrantSource{tokens: []string{"test"}}, RetryWait: time.Millisecond})
	entry := func(path, content string) CollectedEntry {
		return CollectedEntry{Path: path, GitMode: "100644", Language: "typescript", Capability: "symbols_and_edges", Content: []byte(content), ByteCount: int64(len(content)), BlobSHA256: fmt.Sprintf("%x", sha256.Sum256([]byte(content)))}
	}
	snapshot := smallSnapshot()
	snapshot.Entries = []CollectedEntry{entry("a.ts", "export const a=1"), entry("b.ts", "export const b=1"), entry("deleted.ts", "export const gone=1")}
	first, err := client.SyncSnapshot(context.Background(), "first", snapshot)
	if err != nil || first.UploadedFiles != 3 || first.ReusedFiles != 0 {
		t.Fatalf("first: %+v %v", first, err)
	}
	uploaded = nil
	manifest = nil
	snapshot.Entries = []CollectedEntry{snapshot.Entries[0], entry("b.ts", "export const b=2")}
	second, err := client.SyncSnapshot(context.Background(), "second", snapshot)
	if err != nil || second.UploadedFiles != 1 || second.ReusedFiles != 1 || strings.Join(uploaded, ",") != "b.ts" || strings.Join(manifest, ",") != "a.ts,b.ts" {
		t.Fatalf("second: %+v %v uploaded=%v manifest=%v", second, err, uploaded, manifest)
	}
	uploaded = nil
	manifest = nil
	third, err := client.SyncSnapshot(context.Background(), "third", snapshot)
	if err != nil || third.UploadedFiles != 0 || third.ReusedFiles != 2 || len(manifest) != 2 {
		t.Fatalf("unchanged: %+v %v", third, err)
	}
	ready = true
	manifest = nil
	fourth, err := client.SyncSnapshot(context.Background(), "third", snapshot)
	if err != nil || fourth.State != "active" || len(manifest) != 0 {
		t.Fatalf("published replay: %+v %v", fourth, err)
	}
}

func TestIncrementalRequestsBoundEscapedPathWireBytes(t *testing.T) {
	manifestCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if int64(len(raw)) > MaxRequestBytes {
			t.Errorf("request exceeds budget: %d", len(raw))
			w.WriteHeader(413)
			return
		}
		switch {
		case r.URL.Path == "/api/v1/memory/code-snapshots":
			fmt.Fprint(w, `{"snapshot_id":"snapshot","repository_id":"repo","state":"staging"}`)
		case strings.HasSuffix(r.URL.Path, "/manifest"):
			manifestCalls++
			var request struct {
				Entries []ManifestFileEntry `json:"entries"`
			}
			_ = json.Unmarshal(raw, &request)
			paths := []string{}
			for _, e := range request.Entries {
				paths = append(paths, e.Path)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"missing_paths": paths})
		case strings.HasSuffix(r.URL.Path, "/files"):
			fmt.Fprint(w, `{"accepted":1}`)
		default:
			fmt.Fprint(w, `{"snapshot_id":"snapshot","state":"ready"}`)
		}
	}))
	defer server.Close()
	snapshot := smallSnapshot()
	entry := snapshot.Entries[0]
	snapshot.Entries = nil
	for index := 0; index < 450; index++ {
		e := entry
		e.Path = fmt.Sprintf("%s%03d.ts", strings.Repeat("<", 900), index)
		snapshot.Entries = append(snapshot.Entries, e)
	}
	snapshot.TotalBytes = int64(3 * len(snapshot.Entries))
	client := NewUploadClient(UploadClientOptions{MemoryOrigin: server.URL, GrantSource: &fakeGrantSource{tokens: []string{"test"}}, RetryWait: time.Millisecond})
	result, err := client.SyncSnapshot(context.Background(), "escaped", snapshot)
	if err != nil || result.UploadedFiles != 450 || manifestCalls < 3 {
		t.Fatalf("escaped wire budget: %+v %v manifests=%d", result, err, manifestCalls)
	}
}
