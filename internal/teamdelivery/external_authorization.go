package teamdelivery

import (
	"context"
	"fmt"
	"net/http"
	"net/url"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// ExternalAuthorizationRequest identifies the original Relay dispatch. Prepare
// permits local registration only; execute requires an accepted dispatch;
// observe permits read-only recovery, never another submission.
type ExternalAuthorizationRequest struct {
	Authorization   protocol.CollaborationAuthorization `json:"authorization"`
	RequestID       string                              `json:"request_id"`
	NativeSessionID string                              `json:"native_session_id"`
	Phase           string                              `json:"phase"`
}

// AuthorizeExternalExecution is a fresh observation, not a cached grant. Callers
// must check again after remote I/O and retain the separate publication gate.
// HTTP failure (including 404) never authorizes resubmission of remote work.
func (c *Client) AuthorizeExternalExecution(ctx context.Context, input ExternalAuthorizationRequest) error {
	if input.Authorization.DaemonID == "" || input.Authorization.CallID == "" || input.RequestID == "" || (input.Phase != "prepare" && input.Phase != "execute" && input.Phase != "observe" && input.Phase != "account") || (input.Phase != "prepare" && input.NativeSessionID == "") {
		return fmt.Errorf("team_external_authorization_invalid")
	}
	var response struct {
		Authorized      bool   `json:"authorized"`
		CallID          string `json:"call_id"`
		RequestID       string `json:"request_id"`
		NativeSessionID string `json:"native_session_id"`
		Phase           string `json:"phase"`
		Provider        string `json:"provider"`
	}
	path := "/api/team/daemons/" + url.PathEscape(input.Authorization.DaemonID) + "/calls/" + url.PathEscape(input.Authorization.CallID) + "/external-authorization"
	if err := c.request(ctx, http.MethodPost, path, input, &response); err != nil {
		return err
	}
	if !response.Authorized || response.CallID != input.Authorization.CallID || response.RequestID != input.RequestID || response.NativeSessionID != input.NativeSessionID || response.Phase != input.Phase || response.Provider != "agentteams" {
		return fmt.Errorf("team_external_authorization_response_unknown")
	}
	return nil
}
