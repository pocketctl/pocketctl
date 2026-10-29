package teamdelivery

import (
	"context"
	"fmt"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"net/http"
	"net/url"
)

type ExternalStopReport struct {
	Authorization   protocol.CollaborationAuthorization `json:"authorization"`
	RequestID       string                              `json:"request_id"`
	NativeSessionID string                              `json:"native_session_id"`
	State           string                              `json:"state"`
}

func (c *Client) RecordExternalStop(ctx context.Context, input ExternalStopReport) error {
	if input.State != "cancelled" || input.Authorization.CallID == "" || input.Authorization.DaemonID == "" || input.RequestID == "" || input.NativeSessionID == "" {
		return fmt.Errorf("team_external_stop_invalid")
	}
	var out struct {
		CallID    string `json:"call_id"`
		RequestID string `json:"request_id"`
		Recorded  bool   `json:"recorded"`
	}
	path := "/api/team/daemons/" + url.PathEscape(input.Authorization.DaemonID) + "/calls/" + url.PathEscape(input.Authorization.CallID) + "/external-stop"
	if err := c.request(ctx, http.MethodPost, path, input, &out); err != nil {
		return err
	}
	if !out.Recorded || out.CallID != input.Authorization.CallID || out.RequestID != input.RequestID {
		return fmt.Errorf("team_external_stop_response_unknown")
	}
	return nil
}
