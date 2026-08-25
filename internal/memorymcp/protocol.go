// Package memorymcp implements the local stdio<->remote MCP bridge
// (`pocketctl memory-mcp`) and its user-private IPC contract with the
// daemon. Grants are short-lived Relay capability tokens refreshed in
// process memory only; nothing secret is persisted or logged.
package memorymcp

import "time"

// IPC request the bridge process sends to the daemon over the user-private
// memory-mcp socket. One request per connection; the daemon answers with
// exactly one IpcGrantResponse.
type IpcGrantRequest struct {
	Type string `json:"type"` // "memory_mcp_grant_request"
}

// IPC response: either a grant bundle or a bounded error code.
type IpcGrantResponse struct {
	Grant                string    `json:"grant,omitempty"`
	ExpiresIn            int       `json:"expires_in,omitempty"`
	ExpiresAt            time.Time `json:"expires_at,omitempty"`
	ProviderPublicOrigin string    `json:"provider_public_origin,omitempty"`
	InstallationID       string    `json:"installation_id,omitempty"`
	Error                string    `json:"error,omitempty"` // bounded machine code only
}

// Grant is a refreshed capability token held only in process memory.
type Grant struct {
	Token     string
	ExpiresAt time.Time
	Origin    string // operator-configured Memory public origin
	InstallID string
}

// Remaining reports how long the grant is still valid.
func (g Grant) Remaining(now time.Time) time.Duration {
	if g.ExpiresAt.IsZero() {
		return 0
	}
	return g.ExpiresAt.Sub(now)
}
