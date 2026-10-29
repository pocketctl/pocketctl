package teamdelivery

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

type ExternalRecoveryCommand struct {
	CallID            string `json:"call_id"`
	OperationID       string `json:"operation_id"`
	Action            string `json:"action"`
	OriginalRequestID string `json:"original_request_id"`
	NativeSessionID   string `json:"native_session_id"`
	TeamSessionID     string `json:"team_session_id"`
}
type ExternalRecoveryResult struct {
	State        string  `json:"state"`
	RemoteTaskID *string `json:"remote_task_id"`
}
type ExternalRecoveryReport struct {
	ExternalAuthorizationRequest
	OperationID string                 `json:"operation_id"`
	Result      ExternalRecoveryResult `json:"result"`
}

func (c *Client) PendingExternalRecovery(ctx context.Context, daemonID string) ([]ExternalRecoveryCommand, error) {
	if daemonID == "" {
		return nil, fmt.Errorf("team_external_recovery_invalid")
	}
	var response struct {
		Commands []ExternalRecoveryCommand `json:"commands"`
	}
	if err := c.request(ctx, http.MethodGet, "/api/team/daemons/"+url.PathEscape(daemonID)+"/external-recovery", nil, &response); err != nil {
		return nil, err
	}
	if len(response.Commands) > 16 {
		return nil, fmt.Errorf("team_external_recovery_response_unknown")
	}
	for _, command := range response.Commands {
		if command.CallID == "" || command.OperationID == "" || command.OriginalRequestID == "" || command.NativeSessionID == "" || command.TeamSessionID == "" || (command.Action != "query" && command.Action != "retry_original") {
			return nil, fmt.Errorf("team_external_recovery_response_unknown")
		}
	}
	return response.Commands, nil
}
func (c *Client) RecordExternalRecovery(ctx context.Context, input ExternalRecoveryReport) error {
	if input.Phase != "account" || input.Authorization.CallID == "" || input.Authorization.DaemonID == "" || input.OperationID == "" {
		return fmt.Errorf("team_external_recovery_invalid")
	}
	var response struct {
		CallID      string `json:"call_id"`
		OperationID string `json:"operation_id"`
		Recorded    bool   `json:"recorded"`
	}
	path := "/api/team/daemons/" + url.PathEscape(input.Authorization.DaemonID) + "/calls/" + url.PathEscape(input.Authorization.CallID) + "/external-recovery"
	if err := c.request(ctx, http.MethodPost, path, input, &response); err != nil {
		return err
	}
	if response.CallID != input.Authorization.CallID || response.OperationID != input.OperationID || !response.Recorded {
		return fmt.Errorf("team_external_recovery_response_unknown")
	}
	return nil
}
