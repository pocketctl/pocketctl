package teamdelivery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestIsolatedRelayWorkerHTTP(t *testing.T) {
	if os.Getenv("TEAM_DELIVERY_RELAY_INTEGRATION") != "1" {
		t.Skip("requires dedicated loopback Relay fixture")
	}
	fixturePath := os.Getenv("TEAM_DELIVERY_FIXTURE")
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		URL, Team, Task, Call, Daemon string
		Attempt                       string
		AuthorToken                   string `json:"author_token"`
		ReviewerToken                 string `json:"reviewer_token"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if !(fixture.Attempt == "" && fixture.URL == "http://127.0.0.1:18996" || fixture.Attempt != "" && protocol.ValidTeamDeliveryAttemptID(fixture.Attempt) && fixture.URL == "http://127.0.0.1:18995") {
		t.Fatal("isolated Relay required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	api, err := NewClient(fixture.URL, func() string { return fixture.AuthorToken }, nil)
	if err != nil {
		t.Fatal(err)
	}
	reviewer, err := NewClient(fixture.URL, func() string { return fixture.ReviewerToken }, nil)
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	// Native execution is a seeded fixture. Private ownership validation is
	// independently covered by session tests, not claimed by this resolver.
	worker, err := NewWorker(api, t.TempDir(), fixture.URL, fixture.Daemon, func(job protocol.TeamDeliveryJob) (string, error) {
		if job.CallID != fixture.Call || job.TaskID != fixture.Task {
			return "", errors.New("unexpected source")
		}
		return workspace, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	deliveryURL := scopedDeliveryPath(fixture.Task, fixture.Attempt)
	if err = worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	var status struct {
		Executions []struct {
			ExportStatus struct {
				Phase string `json:"phase"`
				Code  string `json:"error_code"`
			} `json:"export_status"`
			StartedAt *string `json:"started_at"`
		}
	}
	if err = reviewer.request(ctx, "GET", deliveryURL+"/executions", nil, &status); err != nil {
		t.Fatal(err)
	}
	if len(status.Executions) != 1 || status.Executions[0].ExportStatus.Code != "manifest_unavailable" || status.Executions[0].StartedAt != nil {
		t.Fatal("missing durable file diagnostic or fabricated native start")
	}
	dir := filepath.Join(workspace, protocol.TeamDeliveryDirectory(fixture.Call))
	if err = os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	content := []byte("# Real HTTP worker artifact\nSynthetic native Call; no model ran.\n")
	if err = os.WriteFile(filepath.Join(dir, "proof.md"), content, 0600); err != nil {
		t.Fatal(err)
	}
	manifest := `{"schema_version":1,"publish_scope":"team","summary":"HTTP worker proof","code_revision":null,"contribution_ids":[],"artifacts":[{"id":"proof","path":"proof.md","mime_type":"text/markdown","required":true}],"evidence":[{"check_id":"unit","artifact_id":"proof","source_kind":"agent_claim","result":"unverified","code_revision":null}]}`
	if err = os.WriteFile(filepath.Join(dir, "submission.json"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	if err = worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	var delivery struct {
		Submissions []struct {
			ID       string                          `json:"submission_id"`
			State    string                          `json:"state"`
			Manifest []protocol.TeamDeliveryArtifact `json:"manifest"`
		}
	}
	if err = reviewer.request(ctx, "GET", deliveryURL, nil, &delivery); err != nil {
		t.Fatal(err)
	}
	if len(delivery.Submissions) != 1 || delivery.Submissions[0].State != "published" || len(delivery.Submissions[0].Manifest) != 1 {
		t.Fatal("real Relay did not publish exactly one submission")
	}
	hash := sha256.Sum256(content)
	if delivery.Submissions[0].Manifest[0].SHA256 != hex.EncodeToString(hash[:]) {
		t.Fatal("manifest hash mismatch")
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", fixture.URL+deliveryURL+"/submissions/"+delivery.Submissions[0].ID+"/artifacts/proof", nil)
	req.Header.Set("Authorization", "Bearer "+fixture.ReviewerToken)
	response, err := reviewer.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || string(bytes) != string(content) {
		t.Fatal("reviewer file readback mismatch")
	}
	if err = worker.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = worker.journal.Load(ctx, fixture.Call); !errors.Is(err, ErrSnapshotMissing) {
		t.Fatal("confirmed snapshot not reclaimed")
	}
	if err = reviewer.request(ctx, "GET", deliveryURL+"/executions", nil, &status); err != nil {
		t.Fatal(err)
	}
	if status.Executions[0].ExportStatus.Phase != "published" {
		t.Fatal("publication did not supersede diagnostic")
	}
	result := map[string]any{"task": fixture.Task, "call": fixture.Call, "submission": delivery.Submissions[0].ID, "sha256": hex.EncodeToString(hash[:]), "missing_manifest_persisted": true, "reviewer_bytes_match": true, "snapshot_reclaimed": true, "synthetic_native": true}
	if fixture.Attempt != "" {
		var decision struct {
			Decision string `json:"decision"`
		}
		if err = reviewer.request(ctx, "POST", deliveryURL+"/decisions", map[string]any{"request_id": "worker-step-review", "expected_revision": 2, "spec_revision": 1, "submission_id": delivery.Submissions[0].ID, "decision": "accepted", "reason": "Synthetic reviewer fixture checked exact bytes", "verified_checks": []string{"unit"}}, &decision); err != nil || decision.Decision != "accepted" {
			t.Fatalf("step review failed: %v", err)
		}
		result["attempt"] = fixture.Attempt
		result["accepted"] = true
	}
	proof, _ := json.MarshalIndent(result, "", "  ")
	if err = os.WriteFile(filepath.Join(filepath.Dir(fixturePath), "worker-results.json"), proof, 0600); err != nil {
		t.Fatal(err)
	}
}
