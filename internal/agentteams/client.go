// Package agentteams implements the pinned upstream Controller protocol.
// This client is not an execution submitter, scheduler, or acceptance authority.
// Callers must enforce the current PocketCtl grant before and after remote I/O.
package agentteams

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxMetadataBytes = 1024 * 1024
const MaxArtifactBytes = 32 * 1024 * 1024

var (
	ErrConfiguration = errors.New("agentteams_configuration_invalid")
	ErrIdentity      = errors.New("agentteams_identity_invalid")
	ErrResponse      = errors.New("agentteams_response_invalid")
	ErrCredential    = errors.New("agentteams_credential_unavailable")
	ErrTransport     = errors.New("agentteams_transport_unknown")
	ErrArtifact      = errors.New("agentteams_artifact_unverified")
)

// HTTPError deliberately omits remote bodies, credentials, and URLs. In
// particular 404 hides permissions/missing storage and is not an authoritative
// original-request absence receipt. It must never authorize a resubmission.
type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return fmt.Sprintf("agentteams_http_%d", e.Status) }

type TaskBinding struct{ ProjectID, TaskID, TeamID string }

type Task struct {
	TaskID       string            `json:"task_id"`
	ProjectID    string            `json:"project_id"`
	Status       string            `json:"status"`
	ResultStatus string            `json:"result_status"`
	SubmissionID string            `json:"submission_id"`
	ResultPath   string            `json:"result_path"`
	CancelReason string            `json:"cancel_reason"`
	Deliverables []json.RawMessage `json:"deliverables"`
}

type Client struct {
	base  string
	token func(context.Context) (string, error)
	http  *http.Client
}

// endpoint comes from the installation configuration, never a task/template.
// HTTP is supported for the isolated Docker service; HTTPS uses normal TLS
// verification. The caller owns its network allowlist and credential store.
func NewClient(endpoint string, token func(context.Context) (string, error), client *http.Client) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Scheme != "https" && u.Scheme != "http") || (u.Path != "" && u.Path != "/") || token == nil {
		return nil, ErrConfiguration
	}
	if client == nil {
		client = &http.Client{}
	}
	copyClient := *client
	if copyClient.Timeout <= 0 || copyClient.Timeout > 20*time.Second {
		copyClient.Timeout = 20 * time.Second
	}
	// Do not forward a Bearer token or repeat POST on a 307, even same-origin.
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	copyClient.Jar = nil
	return &Client{base: strings.TrimSuffix(u.String(), "/"), token: token, http: &copyClient}, nil
}

func safeID(s string) bool {
	if len(s) == 0 || len(s) > 256 {
		return false
	}
	for i, ch := range s {
		alnum := ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9'
		if !alnum && (i == 0 || (ch != '-' && ch != '_' && ch != '.')) {
			return false
		}
	}
	return true
}
func (b TaskBinding) valid() bool {
	return safeID(b.ProjectID) && safeID(b.TaskID) && (b.TeamID == "" || safeID(b.TeamID))
}
func (b TaskBinding) path(suffix string, query url.Values) string {
	if query == nil {
		query = url.Values{}
	}
	if b.TeamID != "" {
		query.Set("team", b.TeamID)
	}
	path := "/api/v1/projects/" + b.ProjectID + "/tasks/" + b.TaskID + suffix
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	return path
}

func (c *Client) request(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, ErrResponse
		}
		reader = bytes.NewReader(data)
	}
	token, err := c.token(ctx)
	if err != nil || len(token) == 0 || len(token) > 8192 || strings.ContainsAny(token, "\r\n\x00") {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrCredential
	}
	r, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return nil, ErrConfiguration
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Accept", "application/json")
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(r)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrTransport
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, &HTTPError{Status: response.StatusCode}
	}
	return response, nil
}
func readBounded(response *http.Response, limit int64) ([]byte, error) {
	defer response.Body.Close()
	if response.ContentLength > limit {
		return nil, ErrResponse
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, ErrTransport
	}
	if int64(len(data)) > limit {
		return nil, ErrResponse
	}
	return data, nil
}
func decode(data []byte, value any) error {
	if !utf8.Valid(data) {
		return ErrResponse
	}
	d := json.NewDecoder(bytes.NewReader(data))
	if d.Decode(value) != nil {
		return ErrResponse
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return ErrResponse
	}
	return nil
}

func (c *Client) Task(ctx context.Context, binding TaskBinding) (Task, error) {
	if !binding.valid() {
		return Task{}, ErrIdentity
	}
	r, err := c.request(ctx, "GET", binding.path("", nil), nil)
	if err != nil {
		return Task{}, err
	}
	data, err := readBounded(r, MaxMetadataBytes)
	if err != nil {
		return Task{}, err
	}
	var task Task
	if decode(data, &task) != nil || task.TaskID != binding.TaskID || task.ProjectID != binding.ProjectID || task.Status == "" {
		return Task{}, ErrResponse
	}
	return task, nil
}

// Cancel sends only the original submission fence and reason. It never creates
// a replacement task. The normalized workflow node "blocked" is ambiguous, so
// only an exact task read of cancelled + original fence/reason proves success.
func (c *Client) Cancel(ctx context.Context, binding TaskBinding, submissionID, reason string) error {
	if !binding.valid() || len(reason) == 0 || len(reason) > 2000 || strings.TrimSpace(reason) != reason || !utf8.ValidString(reason) || strings.ContainsRune(reason, 0) || len(submissionID) > 1024 || strings.ContainsAny(submissionID, "\r\n\x00") {
		return ErrIdentity
	}
	body := struct {
		Reason       string `json:"reason"`
		SubmissionID string `json:"submissionId"`
	}{reason, submissionID}
	r, err := c.request(ctx, "POST", binding.path("/cancel", nil), body)
	if err != nil {
		return err
	}
	data, err := readBounded(r, MaxMetadataBytes)
	if err != nil {
		return err
	}
	var workflow struct {
		ProjectID string `json:"project_id"`
	}
	if decode(data, &workflow) != nil || workflow.ProjectID != binding.ProjectID {
		return ErrResponse
	}
	task, err := c.Task(ctx, binding)
	if err != nil {
		return err
	}
	if task.Status != "cancelled" || task.SubmissionID != submissionID || task.CancelReason != reason {
		return ErrResponse
	}
	return nil
}

func artifactPath(binding TaskBinding, path string) bool {
	if path == "" || len(path) > 4096 || !utf8.ValidString(path) || strings.Contains(path, "..") || strings.ContainsAny(path, "\\\r\n\x00") {
		return false
	}
	return strings.HasPrefix(path, "shared/tasks/"+binding.TaskID+"/") || strings.HasPrefix(path, "shared/projects/"+binding.ProjectID+"/")
}
func (t Task) declares(path string) bool {
	if path == t.ResultPath {
		return true
	}
	for _, raw := range t.Deliverables {
		var value string
		if json.Unmarshal(raw, &value) == nil && value == path {
			return true
		}
		var file struct {
			Type string `json:"type"`
			Path string `json:"path"`
		}
		if json.Unmarshal(raw, &file) == nil && (file.Type == "file" || file.Type == "") && file.Path == path {
			return true
		}
	}
	return false
}
func (t Task) exported(submissionID string) bool {
	return submissionID != "" && t.SubmissionID == submissionID && (t.Status == "submitted" || t.Status == "completed") && t.ResultStatus == "SUCCESS"
}

// Artifact snapshots declared bytes only. The current submission must match on
// both sides of the download. The publisher still hashes/persists these bytes
// and checks the current PocketCtl grant; no remote URL is a trusted artifact.
func (c *Client) Artifact(ctx context.Context, binding TaskBinding, submissionID, path string, maxBytes int64) ([]byte, error) {
	if !binding.valid() || !artifactPath(binding, path) || maxBytes <= 0 || maxBytes > MaxArtifactBytes {
		return nil, ErrArtifact
	}
	before, err := c.Task(ctx, binding)
	if err != nil {
		return nil, err
	}
	if !before.exported(submissionID) || !before.declares(path) {
		return nil, ErrArtifact
	}
	r, err := c.request(ctx, "GET", binding.path("/artifact", url.Values{"path": {path}}), nil)
	if err != nil {
		return nil, err
	}
	data, err := readBounded(r, maxBytes)
	if err != nil {
		return nil, err
	}
	after, err := c.Task(ctx, binding)
	if err != nil {
		return nil, err
	}
	if !after.exported(submissionID) || !after.declares(path) || after.ResultPath != before.ResultPath || !reflect.DeepEqual(after.Deliverables, before.Deliverables) {
		return nil, ErrArtifact
	}
	return data, nil
}
