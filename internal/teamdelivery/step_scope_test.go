package teamdelivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

const testAttemptID = "a1234567-1234-4234-8234-123456789abc"

func TestStepInvalidContributionsCanBeCorrectedBeforeSnapshot(t *testing.T) {
	job := fixtureJob()
	job.AttemptID = testAttemptID
	job.Authorization.Delivery.AttemptID = testAttemptID
	workspace := fixtureWorkspace(t)
	file := filepath.Join(workspace, protocol.TeamDeliveryDirectory(job.CallID), "submission.json")
	original, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err = json.Unmarshal(original, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["contribution_ids"] = []string{testSubmissionID}
	invalid, _ := json.Marshal(manifest)
	if err = os.WriteFile(file, invalid, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = Collect(workspace, job); err == nil || err.Error() != "delivery_contribution_invalid" {
		t.Fatalf("invalid step input collected: %v", err)
	}
	if err = os.WriteFile(file, original, 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := Collect(workspace, job)
	if err != nil {
		t.Fatal("corrected input rejected", err)
	}
	snapshot.Submission.ContributionIDs = []string{testSubmissionID}
	if err = snapshot.validate(); err == nil {
		t.Fatal("invalid persisted step input accepted")
	}
}

func TestStepReceiptUnknownNeverFallsBackOrPublishes(t *testing.T) {
	for _, response := range []struct {
		name   string
		status int
		body   string
	}{
		{"missing_route", 404, `{"error":{"code":"team_not_found"}}`},
		{"unavailable", 503, `{"error":{"code":"database_unavailable"}}`},
		{"missing_found", 200, `{}`},
		{"truncated", 200, `{"found":`},
		{"contradictory", 200, `{"found":true,"receipt":null}`},
	} {
		t.Run(response.name, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Method != "GET" || !strings.Contains(r.URL.Path, "/attempts/"+testAttemptID+"/delivery/receipt-lookup/") {
					t.Errorf("unsafe recovery request: %s %s", r.Method, r.URL.Path)
				}
				w.WriteHeader(response.status)
				_, _ = w.Write([]byte(response.body))
			}))
			defer server.Close()
			client, err := NewClient(server.URL, func() string { return "owner" }, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			job := fixtureJob()
			job.AttemptID = testAttemptID
			job.Authorization.Delivery.AttemptID = testAttemptID
			snapshot, err := Collect(fixtureWorkspace(t), job)
			if err != nil {
				t.Fatal(err)
			}
			journal, err := OpenJournal(t.TempDir(), "step-test")
			if err != nil {
				t.Fatal(err)
			}
			defer journal.Close()
			if _, err = journal.Save(context.Background(), snapshot); err != nil {
				t.Fatal(err)
			}
			if _, err = (&Publisher{Journal: journal, API: client}).Publish(context.Background(), job.CallID); err == nil {
				t.Fatal("unknown receipt treated as absent")
			}
			if requests != 1 {
				t.Fatalf("unexpected recovery retries: %d", requests)
			}
			if _, err = journal.Load(context.Background(), job.CallID); err != nil {
				t.Fatal("unknown publication lost snapshot", err)
			}
		})
	}
}

func TestStepSourceCannotChangeScopeOrUseLegacyAPI(t *testing.T) {
	job := fixtureJob()
	job.AttemptID = testAttemptID
	if validateJob(job) == nil {
		t.Fatal("job/auth scope mismatch accepted")
	}
	job.Authorization.Delivery.AttemptID = job.AttemptID
	if err := validateJob(job); err != nil {
		t.Fatal(err)
	}
	workspace := fixtureWorkspace(t)
	snapshot, err := Collect(workspace, job)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := OpenJournal(t.TempDir(), "step-test")
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	if _, err = journal.Save(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	api := newPublicationFixture()
	if _, err = (&Publisher{Journal: journal, API: api}).Publish(context.Background(), job.CallID); err == nil || err.Error() != "delivery_attempt_unsupported" {
		t.Fatalf("legacy API accepted step: %v", err)
	}
	if api.prepareCalls != 0 || api.uploadCalls != 0 || api.publishCalls != 0 {
		t.Fatal("legacy API received writes")
	}
	changed := fixtureJob()
	changedSnapshot, err := Collect(workspace, changed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = journal.Save(context.Background(), changedSnapshot); err == nil {
		t.Fatal("step journal changed to legacy scope")
	}
	changed.AttemptID = "b1234567-1234-4234-8234-123456789abc"
	changed.Authorization.Delivery.AttemptID = changed.AttemptID
	changedSnapshot, err = Collect(workspace, changed)
	if err != nil {
		t.Fatal(err)
	}
	if sameJobSource(job, changed) {
		t.Fatal("different attempts share source authority")
	}
	if _, err = journal.Save(context.Background(), changedSnapshot); err == nil {
		t.Fatal("step journal changed attempt")
	}
}

func TestStepClientBindingIsImmutableAndLegacyJobsFallbackIsReadOnly(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != "GET" || !strings.HasSuffix(r.URL.Path, "/delivery-jobs") {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("include_steps") != "" {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_request"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"owner_user_id": 1, "jobs": []any{fixtureJob()}, "next_cursor": nil})
	}))
	defer server.Close()
	client, err := NewClient(server.URL, func() string { return "owner" }, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	bound, err := client.ForAttempt(testAttemptID)
	if err != nil {
		t.Fatal(err)
	}
	if client.attemptID != "" || bound.(*Client).attemptID != testAttemptID {
		t.Fatal("binding mutated shared client")
	}
	for _, id := range []string{"../delivery", strings.ToUpper(testAttemptID), "invalid"} {
		if _, err := client.ForAttempt(id); err == nil {
			t.Fatal("noncanonical attempt accepted", id)
		}
	}
	page, err := client.Jobs(context.Background(), "daemon-1", "")
	if err != nil || len(page.Jobs) != 1 || requests != 2 {
		t.Fatalf("legacy read fallback failed: %v %+v requests=%d", err, page, requests)
	}
}
