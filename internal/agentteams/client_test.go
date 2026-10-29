package agentteams

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var binding = TaskBinding{ProjectID: "project-1", TaskID: "task-1", TeamID: "team-1"}

func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	s := httptest.NewServer(handler)
	t.Cleanup(s.Close)
	c, err := NewClient(s.URL, func(context.Context) (string, error) { return "private-test-token", nil }, s.Client())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func taskJSON(submission string) string {
	return fmt.Sprintf(`{"task_id":"task-1","project_id":"project-1","status":"submitted","result_status":"SUCCESS","submission_id":%q,"result_path":"shared/tasks/task-1/result.md","deliverables":[{"type":"file","path":"shared/tasks/task-1/proof.txt"}]}`, submission)
}

func TestTaskReadsExactIdentityAndTeamWithoutPublishingAcceptance(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/api/v1/projects/project-1/tasks/task-1" || r.URL.Query().Get("team") != "team-1" || r.Header.Get("Authorization") != "Bearer private-test-token" {
			t.Errorf("wrong scoped request")
		}
		fmt.Fprint(w, taskJSON("submission-1"))
	})
	task, err := c.Task(context.Background(), binding)
	if err != nil || task.Status != "submitted" || task.SubmissionID != "submission-1" {
		t.Fatalf("%+v %v", task, err)
	}
}

func TestTaskRejectsWrongIdentityMalformedAndOversizedResponses(t *testing.T) {
	for name, body := range map[string]string{"identity": strings.Replace(taskJSON("s"), `"task-1"`, `"other"`, 1), "trailing": taskJSON("s") + `{}`, "oversized": strings.Repeat(" ", MaxMetadataBytes+1)} {
		t.Run(name, func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) })
			if _, err := c.Task(context.Background(), binding); err == nil {
				t.Fatal("untrusted response accepted")
			}
		})
	}
}

func TestHTTPFailureIsNotAuthoritativeAbsenceAndDoesNotExposeResponseSecrets(t *testing.T) {
	for _, status := range []int{401, 403, 404, 409, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				fmt.Fprint(w, "private-test-token remote-secret")
			})
			_, err := c.Task(context.Background(), binding)
			var remote *HTTPError
			if !errors.As(err, &remote) || remote.Status != status || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "remote-secret") {
				t.Fatalf("unsafe error: %v", err)
			}
		})
	}
}

func TestRedirectNeverForwardsCredentialsOrRepeatsCancellation(t *testing.T) {
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer target.Close()
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(307)
	})
	if err := c.Cancel(context.Background(), binding, "submission-1", "Owner cancellation"); err == nil || hits != 0 {
		t.Fatalf("redirect followed: %v, hits=%d", err, hits)
	}
}

func TestCancelFreezesSubmissionFenceAndChecksReturnedTask(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, taskJSON("submission-1"))
			return
		}
		if r.Method != "POST" || r.URL.Path != "/api/v1/projects/project-1/tasks/task-1/cancel" || r.URL.Query().Get("team") != "team-1" {
			t.Error("wrong cancellation target")
		}
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["submissionId"] != "submission-1" || body["reason"] != "Owner cancellation" || len(body) != 2 {
			t.Error("cancellation identity changed")
		}
		fmt.Fprint(w, `{"project_id":"project-1","nodes":[{"id":"task-1","status":"blocked"}]}`)
	})
	// Upstream normalizes cancelled to blocked in workflow. A follow-up exact
	// task read is needed; the ambiguous normalized node cannot prove cancel.
	if err := c.Cancel(context.Background(), binding, "submission-1", "Owner cancellation"); err == nil {
		t.Fatal("ambiguous cancellation accepted")
	}
}

func TestCancelRequiresExactPersistedReasonAndSubmission(t *testing.T) {
	for _, scenario := range []string{"ok", "changed-reason", "changed-submission"} {
		t.Run(scenario, func(t *testing.T) {
			posts := 0
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					posts++
					fmt.Fprint(w, `{"project_id":"project-1","nodes":[{"id":"task-1","status":"blocked"}]}`)
					return
				}
				reason, submission := "Owner cancellation", "s1"
				if scenario == "changed-reason" {
					reason = "Other actor"
				}
				if scenario == "changed-submission" {
					submission = "s2"
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"task_id": "task-1", "project_id": "project-1", "status": "cancelled", "submission_id": submission, "cancel_reason": reason})
			})
			err := c.Cancel(context.Background(), binding, "s1", "Owner cancellation")
			if (err == nil) != (scenario == "ok") || posts != 1 {
				t.Fatalf("result=%v posts=%d", err, posts)
			}
		})
	}
}

func TestArtifactRevocationAfterDownloadReturnsNoBytes(t *testing.T) {
	reads := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/artifact") {
			fmt.Fprint(w, "proof")
			return
		}
		reads++
		if reads > 1 {
			w.WriteHeader(403)
			return
		}
		fmt.Fprint(w, taskJSON("s1"))
	})
	data, err := c.Artifact(context.Background(), binding, "s1", "shared/tasks/task-1/proof.txt", 5)
	if err == nil || len(data) != 0 {
		t.Fatalf("revoked bytes returned: %q %v", data, err)
	}
}

func TestArtifactRequiresDeclaredPathAndStableSubmissionAndBoundedBytes(t *testing.T) {
	for _, scenario := range []string{"ok", "undeclared", "traversal", "oversized", "changed-submission"} {
		t.Run(scenario, func(t *testing.T) {
			metadata, downloads := 0, 0
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/artifact") {
					downloads++
					if r.URL.Query().Get("path") != "shared/tasks/task-1/proof.txt" {
						t.Error("wrong artifact path")
					}
					if scenario == "oversized" {
						fmt.Fprint(w, "too many bytes")
					} else {
						fmt.Fprint(w, "proof")
					}
					return
				}
				metadata++
				sub := "s1"
				if metadata > 1 && scenario == "changed-submission" {
					sub = "s2"
				}
				fmt.Fprint(w, taskJSON(sub))
			})
			path := "shared/tasks/task-1/proof.txt"
			if scenario == "undeclared" {
				path = "shared/tasks/task-1/other.txt"
			}
			if scenario == "traversal" {
				path = "shared/tasks/task-1/../secret"
			}
			data, err := c.Artifact(context.Background(), binding, "s1", path, 5)
			if scenario == "ok" {
				if err != nil || string(data) != "proof" || metadata != 2 {
					t.Fatalf("%q %v metadata=%d", data, err, metadata)
				}
			} else if err == nil || len(data) != 0 {
				t.Fatalf("unsafe artifact returned: %q %v", data, err)
			}
			if (scenario == "undeclared" || scenario == "traversal") && downloads != 0 {
				t.Fatal("invalid path reached file server")
			}
		})
	}
}

func TestInvalidConfigurationOrBindingMakesNoNetworkRequest(t *testing.T) {
	for _, base := range []string{"https://user:password@example.test", "https://example.test?token=secret", "file:///tmp/output", "https://example.test/prefix"} {
		if _, err := NewClient(base, func(context.Context) (string, error) { return "token", nil }, nil); err == nil {
			t.Fatal("unsafe endpoint accepted")
		}
	}
	hits := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) { hits++ })
	bad := binding
	bad.TaskID = "../task"
	if _, err := c.Task(context.Background(), bad); err == nil || hits != 0 {
		t.Fatal("invalid identity reached network")
	}
}
