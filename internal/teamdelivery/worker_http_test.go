package teamdelivery

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestHTTPWorkerLostPublishResponseReconcilesAfterRestart(t *testing.T) {
	for _, step := range []bool{false, true} {
		name := "legacy"
		if step {
			name = "step"
		}
		t.Run(name, func(t *testing.T) { testHTTPWorkerRecovery(t, step) })
	}
}

func testHTTPWorkerRecovery(t *testing.T, step bool) {
	ctx := context.Background()
	workspace, private := fixtureWorkspace(t), t.TempDir()
	job := fixtureJob()
	if step {
		job.AttemptID = "a1234567-1234-4234-8234-123456789abc"
		job.Authorization.Delivery.AttemptID = job.AttemptID
	}
	backend := newPublicationFixture()
	backend.dropPublish = true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-owner" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasSuffix(r.URL.Path, "/delivery-jobs") && !strings.HasPrefix(r.URL.Path, scopedDeliveryPath(job.TaskID, job.AttemptID)+"/") {
			t.Errorf("request escaped delivery scope: %s", r.URL.Path)
			w.WriteHeader(400)
			return
		}
		var value any
		var err error
		switch {
		case strings.HasSuffix(r.URL.Path, "/status"):
			value = map[string]any{"revision": 1, "phase": "published"}
		case strings.HasSuffix(r.URL.Path, "/delivery-jobs"):
			jobs := []protocol.TeamDeliveryJob{}
			if backend.publishEffects == 0 {
				jobs = append(jobs, job)
			}
			value = JobPage{OwnerUserID: 1, Jobs: jobs}
		case strings.Contains(r.URL.Path, "/receipt-lookup/"):
			key := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			receipt := backend.receipts[key]
			value = map[string]any{"found": receipt != nil, "receipt": receipt}
		case strings.Contains(r.URL.Path, "/receipts/"):
			key := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			receipt := backend.receipts[key]
			if receipt == nil {
				w.WriteHeader(404)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "team_not_found"}})
				return
			}
			value = receipt
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/submissions"):
			var input protocol.TeamDeliverySubmission
			if err = json.NewDecoder(r.Body).Decode(&input); err == nil {
				value, err = backend.Prepare(r.Context(), job.TaskID, input)
			}
		case r.Method == "PUT" && strings.Contains(r.URL.Path, "/artifacts/"):
			var input struct {
				Content string `json:"content_base64"`
			}
			err = json.NewDecoder(r.Body).Decode(&input)
			if err == nil {
				data, decodeErr := base64.StdEncoding.DecodeString(input.Content)
				err = decodeErr
				if err == nil {
					err = backend.Upload(r.Context(), job.TaskID, testSubmissionID, protocol.TeamDeliveryArtifact{}, data)
					digest := sha256.Sum256(data)
					value = map[string]string{"artifact_id": "report", "state": "ready", "sha256": hex.EncodeToString(digest[:])}
				}
			}
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/publish"):
			var input Mutation
			if err = json.NewDecoder(r.Body).Decode(&input); err == nil {
				value, err = backend.Publish(r.Context(), job.TaskID, testSubmissionID, input)
			}
			if err != nil && backend.publishEffects == 1 {
				// A successful HTTP status with a truncated response after commit.
				_, _ = w.Write([]byte(`{"submission_id":`))
				return
			}
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		_ = json.NewEncoder(w).Encode(value)
	}))
	defer server.Close()
	client, err := NewClient(server.URL, func() string { return "test-owner" }, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	newWorker := func() *Worker {
		worker, err := NewWorker(client, private, server.URL, "daemon-1", func(protocol.TeamDeliveryJob) (string, error) { return workspace, nil }, nil)
		if err != nil {
			t.Fatal(err)
		}
		return worker
	}
	first := newWorker()
	if err := first.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := first.journal.Load(ctx, job.CallID); err != nil {
		t.Fatal("unknown write lost durable snapshot", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second := newWorker()
	defer second.Close()
	if err := second.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := second.journal.Load(ctx, job.CallID); !errors.Is(err, ErrSnapshotMissing) {
		t.Fatalf("receipt did not reclaim snapshot: %v", err)
	}
	if retired, err := second.journal.Retired(ctx, job.CallID); err != nil || !retired {
		t.Fatal("missing durable completion tombstone", err)
	}
	if backend.prepareEffects != 1 || backend.publishEffects != 1 || backend.publishCalls != 1 || backend.uploadCalls != 1 {
		t.Fatal("HTTP recovery repeated a write")
	}
}
