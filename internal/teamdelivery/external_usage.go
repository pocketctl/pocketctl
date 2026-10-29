package teamdelivery

import (
	"context"
	"fmt"
	"net/http"
	"net/url"

	"github.com/pocketctl/pocketctl/internal/agentteams"
)

type ExternalUsageRequest struct {
	ExternalAuthorizationRequest
	RemoteTaskID string                 `json:"remote_task_id"`
	Usage        agentteams.WorkerUsage `json:"usage"`
}

// RecordExternalUsage acknowledges immutable facts, not another execution.
// A lost response must replay this same payload; only a bound receipt allows
// the daemon to stop delivering it.
func (c *Client) RecordExternalUsage(ctx context.Context, input ExternalUsageRequest) error {
	if input.Phase != "account" || input.Authorization.CallID == "" || input.Authorization.DaemonID == "" || input.RequestID == "" || input.NativeSessionID == "" || input.RemoteTaskID == "" || len(input.Usage.Turns) == 0 {
		return fmt.Errorf("team_external_usage_invalid")
	}
	var response struct {
		CallID        string `json:"call_id"`
		RequestID     string `json:"request_id"`
		RecordedTurns *int   `json:"recorded_turns"`
		NewTurns      *int   `json:"new_turns"`
		CostStatus    string `json:"cost_status"`
	}
	path := "/api/team/daemons/" + url.PathEscape(input.Authorization.DaemonID) + "/calls/" + url.PathEscape(input.Authorization.CallID) + "/external-usage"
	if err := c.request(ctx, http.MethodPost, path, input, &response); err != nil {
		return err
	}
	if response.CallID != input.Authorization.CallID || response.RequestID != input.RequestID || response.RecordedTurns == nil || *response.RecordedTurns != len(input.Usage.Turns) || response.NewTurns == nil || *response.NewTurns < 0 || *response.NewTurns > *response.RecordedTurns || response.CostStatus != "unavailable" {
		return fmt.Errorf("team_external_usage_response_unknown")
	}
	return nil
}
