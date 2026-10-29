package teamdelivery

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type HTTPError struct {
	Status int
	Code   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("delivery_http_%d:%s", e.Status, e.Code) }

type OperationResult struct {
	SubmissionID string `json:"submission_id"`
	State        string `json:"state"`
	Revision     int64  `json:"revision"`
	Version      int64  `json:"version"`
}

type OperationReceipt struct {
	Operation string          `json:"operation"`
	Response  OperationResult `json:"response"`
}

type Mutation struct {
	RequestID        string `json:"request_id"`
	ExpectedRevision int64  `json:"expected_revision"`
}

type DeliveryHead struct {
	Revision           int64   `json:"revision"`
	LatestSubmissionID *string `json:"latest_submission_id"`
	TaskState          string  `json:"task_state"`
	WritesEnabled      bool    `json:"writes_enabled"`
	Spec               struct {
		Revision int64 `json:"revision"`
	} `json:"spec"`
}

type JobPage struct {
	OwnerUserID int                        `json:"owner_user_id"`
	Jobs        []protocol.TeamDeliveryJob `json:"jobs"`
	NextCursor  *string                    `json:"next_cursor"`
}

type ExportDiagnostic struct {
	ExpectedRevision int64  `json:"expected_revision"`
	Phase            string `json:"phase"`
	ErrorCode        string `json:"error_code"`
}

func (c *Client) ReportStatus(ctx context.Context, job protocol.TeamDeliveryJob, value ExportDiagnostic) error {
	if !protocol.ValidTeamDeliveryAttemptID(job.AttemptID) {
		return fmt.Errorf("delivery_attempt_invalid")
	}
	var result struct {
		Revision int64  `json:"revision"`
		Phase    string `json:"phase"`
	}
	err := c.request(ctx, http.MethodPost, scopedDeliveryPath(job.TaskID, job.AttemptID)+"/exports/"+url.PathEscape(job.CallID)+"/daemons/"+url.PathEscape(job.Authorization.DaemonID)+"/status", value, &result)
	if err == nil && result.Revision < 1 {
		return fmt.Errorf("delivery_status_response_unknown")
	}
	return err
}

// Client uses the daemon's current access token for every request. The supplied
// transport must carry the same TLS policy as its Relay WebSocket connection.
type Client struct {
	base      string
	token     func() string
	http      *http.Client
	attemptID string
}

func (c *Client) ForAttempt(attemptID string) (PublicationAPI, error) {
	if !protocol.ValidTeamDeliveryAttemptID(attemptID) {
		return nil, fmt.Errorf("delivery_attempt_invalid")
	}
	copy := *c
	copy.attemptID = attemptID
	return &copy, nil
}

func NewClient(relayURL string, token func() string, client *http.Client) (*Client, error) {
	u, err := url.Parse(strings.TrimSpace(relayURL))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || token == nil {
		return nil, fmt.Errorf("delivery_relay_url_invalid")
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
	default:
		return nil, fmt.Errorf("delivery_relay_url_invalid")
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/ws")
	u.RawPath = ""
	httpClient := http.Client{Timeout: 30 * time.Second}
	if client != nil {
		httpClient = *client
	}
	if httpClient.Timeout <= 0 || httpClient.Timeout > 30*time.Second {
		httpClient.Timeout = 30 * time.Second
	}
	// Never forward a user bearer token to an API redirect, including a redirect
	// to another same-host path. A redirect is an explicit HTTP failure here.
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{base: strings.TrimRight(u.String(), "/"), token: token, http: &httpClient}, nil
}

func (c *Client) request(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	token := c.token()
	if token == "" {
		return &HTTPError{Status: 401, Code: "authorization_required"}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("delivery_transport_unknown: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024+1))
	if err != nil || len(data) > 4*1024*1024 {
		return fmt.Errorf("delivery_response_unknown")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var value struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &value)
		code := value.Error.Code
		if !artifactID.MatchString(code) {
			code = "http_error"
		}
		return &HTTPError{Status: response.StatusCode, Code: code}
	}
	// Truncated or concatenated successful JSON is still an unknown write
	// outcome. The publisher must query the original receipt before retrying.
	if err := json.Unmarshal(data, output); err != nil {
		return fmt.Errorf("delivery_response_unknown: %w", err)
	}
	return nil
}

func deliveryPath(taskID string) string {
	return "/api/team/tasks/" + url.PathEscape(taskID) + "/delivery"
}

func scopedDeliveryPath(taskID, attemptID string) string {
	if attemptID == "" {
		return deliveryPath(taskID)
	}
	return "/api/team/tasks/" + url.PathEscape(taskID) + "/attempts/" + url.PathEscape(attemptID) + "/delivery"
}

func (c *Client) deliveryPath(taskID string) string { return scopedDeliveryPath(taskID, c.attemptID) }

func (c *Client) Jobs(ctx context.Context, daemonID, cursor string) (JobPage, error) {
	var page JobPage
	err := c.request(ctx, http.MethodGet, "/api/team/daemons/"+url.PathEscape(daemonID)+"/delivery-jobs?include_steps=true&after="+url.QueryEscape(cursor), nil, &page)
	var legacy *HTTPError
	if errors.As(err, &legacy) && legacy.Status == 400 && legacy.Code == "invalid_request" {
		// Older Relay rejects unknown query fields. This read-only fallback
		// preserves P0 polling and never retries a publication mutation.
		err = c.request(ctx, http.MethodGet, "/api/team/daemons/"+url.PathEscape(daemonID)+"/delivery-jobs?after="+url.QueryEscape(cursor), nil, &page)
	}
	if err != nil {
		return page, err
	}
	if page.OwnerUserID < 1 || page.Jobs == nil || len(page.Jobs) > 100 {
		return page, fmt.Errorf("delivery_jobs_invalid")
	}
	for _, job := range page.Jobs {
		if validateJob(job) != nil || job.Authorization.DaemonID != daemonID || job.Authorization.OwnerUserID != page.OwnerUserID {
			return JobPage{}, fmt.Errorf("delivery_jobs_invalid")
		}
	}
	if page.NextCursor != nil && (!textValid(*page.NextCursor, 128) || *page.NextCursor <= cursor) {
		return JobPage{}, fmt.Errorf("delivery_cursor_invalid")
	}
	return page, nil
}

func (c *Client) Receipt(ctx context.Context, taskID, requestID string) (*OperationReceipt, error) {
	var receipt OperationReceipt
	if c.attemptID != "" {
		var lookup struct {
			Found   *bool             `json:"found"`
			Receipt *OperationReceipt `json:"receipt"`
		}
		if err := c.request(ctx, http.MethodGet, c.deliveryPath(taskID)+"/receipt-lookup/"+url.PathEscape(requestID), nil, &lookup); err != nil {
			return nil, err
		}
		// A missing route, malformed body or revoked identity cannot prove that
		// an earlier mutation failed. Only explicit authorized absence can.
		if lookup.Found == nil || *lookup.Found != (lookup.Receipt != nil) {
			return nil, fmt.Errorf("delivery_receipt_invalid")
		}
		if !*lookup.Found {
			return nil, nil
		}
		receipt = *lookup.Receipt
		if receipt.Operation == "" || !validResult(receipt.Response) {
			return nil, fmt.Errorf("delivery_receipt_invalid")
		}
		return &receipt, nil
	}
	err := c.request(ctx, http.MethodGet, c.deliveryPath(taskID)+"/receipts/"+url.PathEscape(requestID), nil, &receipt)
	var httpError *HTTPError
	if errors.As(err, &httpError) && httpError.Status == 404 && httpError.Code == "team_not_found" {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if receipt.Operation == "" || !validResult(receipt.Response) {
		return nil, fmt.Errorf("delivery_receipt_invalid")
	}
	return &receipt, nil
}

func validResult(result OperationResult) bool {
	return contributionID.MatchString(result.SubmissionID) && result.Revision > 0 &&
		(result.State == "preparing" || result.State == "published" && result.Version > 0)
}

func (c *Client) Prepare(ctx context.Context, taskID string, input protocol.TeamDeliverySubmission) (OperationResult, error) {
	var result OperationResult
	err := c.request(ctx, http.MethodPost, c.deliveryPath(taskID)+"/submissions", input, &result)
	if err == nil && (!validResult(result) || result.State != "preparing") {
		err = fmt.Errorf("delivery_prepare_response_unknown")
	}
	return result, err
}

func (c *Client) Upload(ctx context.Context, taskID, submissionID string, artifact protocol.TeamDeliveryArtifact, data []byte) error {
	var result struct {
		ArtifactID string `json:"artifact_id"`
		SHA256     string `json:"sha256"`
		State      string `json:"state"`
	}
	err := c.request(ctx, http.MethodPut, c.deliveryPath(taskID)+"/submissions/"+url.PathEscape(submissionID)+"/artifacts/"+url.PathEscape(artifact.ID),
		map[string]string{"content_base64": base64.StdEncoding.EncodeToString(data)}, &result)
	if err == nil && (result.ArtifactID != artifact.ID || result.SHA256 != artifact.SHA256 || result.State != "ready") {
		return fmt.Errorf("delivery_upload_response_unknown")
	}
	return err
}

func (c *Client) Publish(ctx context.Context, taskID, submissionID string, input Mutation) (OperationResult, error) {
	var result OperationResult
	err := c.request(ctx, http.MethodPost, c.deliveryPath(taskID)+"/submissions/"+url.PathEscape(submissionID)+"/publish", input, &result)
	if err == nil && (!validResult(result) || result.State != "published" || result.SubmissionID != submissionID) {
		err = fmt.Errorf("delivery_publish_response_unknown")
	}
	return result, err
}

func (c *Client) Head(ctx context.Context, taskID string) (DeliveryHead, error) {
	var head DeliveryHead
	err := c.request(ctx, http.MethodGet, c.deliveryPath(taskID), nil, &head)
	if err == nil && (head.Revision < 1 || head.Spec.Revision < 1 || head.TaskState == "") {
		err = fmt.Errorf("delivery_head_invalid")
	}
	return head, err
}
