package session

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentteams"
)

const agentTeamsBridgePrefix = "/v1/agentteams/"
const agentTeamsInstallationHeader = "X-PocketCtl-Installation"

type agentTeamsArtifactRequest struct {
	Identity ExternalExecutionIdentity
	Path     string
	MaxBytes int64
}
type agentTeamsBridgeError struct {
	Code string `json:"code"`
}

func validAgentTeamsToken(s string) bool {
	return len(s) > 0 && len(s) <= 8192 && !strings.ContainsAny(s, "\x00\r\n")
}

// NewAgentTeamsBridgeHandler is PocketCtl's bridge protocol, NOT an upstream
// AgentTeams API. Start it only with OpenAgentTeamsJournal and a fixed private
// installation credential. The daemon independently enforces current grants.
func NewAgentTeamsBridgeHandler(executor *AgentTeamsExecutor, installation string, token func(context.Context) (string, error)) (http.Handler, error) {
	if executor == nil || !externalIdentifier(installation) || token == nil {
		return nil, ErrExternalIdentity
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		expected, err := token(r.Context())
		supplied := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if err != nil || !validAgentTeamsToken(expected) || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(expected), []byte(supplied)) != 1 {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(agentTeamsBridgeError{"unauthorized"})
			return
		}
		w.Header().Set(agentTeamsInstallationHeader, installation)
		writeError := func(err error) {
			status, code := http.StatusServiceUnavailable, "result_unknown"
			switch {
			case errors.Is(err, ErrExternalNotFound):
				status, code = 404, "request_absent"
			case errors.Is(err, ErrExternalRevoked):
				status, code = 410, "revoked"
			case errors.Is(err, ErrExternalIdentity):
				status, code = 400, "identity_invalid"
			case errors.Is(err, ErrExternalConflict):
				status, code = 409, "identity_conflict"
			case errors.Is(err, ErrExternalCapability):
				status, code = 422, "capability_unsupported"
			}
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(agentTeamsBridgeError{code})
		}
		decode := func(value any) error {
			limit := int64(8 * 1024 * 1024)
			if r.URL.Path == agentTeamsBridgePrefix+"submit" {
				limit = agentteams.MaxFrozenWireBytes
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
			d := json.NewDecoder(r.Body)
			d.DisallowUnknownFields()
			if d.Decode(value) != nil {
				return ErrExternalIdentity
			}
			var extra any
			if d.Decode(&extra) != io.EOF {
				return ErrExternalIdentity
			}
			return nil
		}
		if r.Method == "GET" && r.URL.Path == agentTeamsBridgePrefix+"capabilities" && r.URL.RawQuery == "" {
			caps, _ := executor.Capabilities(r.Context())
			json.NewEncoder(w).Encode(caps)
			return
		}
		if r.Method != "POST" || r.URL.RawQuery != "" {
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(agentTeamsBridgeError{"route_not_found"})
			return
		}
		var result any
		switch r.URL.Path {
		case agentTeamsBridgePrefix + "submit":
			var input ExternalExecutionRequest
			if err = decode(&input); err == nil {
				result, err = executor.Submit(r.Context(), input)
			}
		case agentTeamsBridgePrefix + "lookup", agentTeamsBridgePrefix + "cancel":
			var id ExternalExecutionIdentity
			if err = decode(&id); err == nil {
				if strings.HasSuffix(r.URL.Path, "/lookup") {
					result, err = executor.Lookup(r.Context(), id)
				} else {
					err = executor.Cancel(r.Context(), id)
					result = struct {
						Identity              ExternalExecutionIdentity
						CancellationRequested bool
						StopConfirmed         bool
					}{id, true, true}
				}
			}
		case agentTeamsBridgePrefix + "usage":
			var id ExternalExecutionIdentity
			if err = decode(&id); err == nil {
				result, err = executor.Usage(r.Context(), id)
			}
		case agentTeamsBridgePrefix + "artifact":
			var input agentTeamsArtifactRequest
			if err = decode(&input); err == nil {
				result, err = executor.ExportArtifact(r.Context(), input.Identity, input.Path, input.MaxBytes)
			}
		default:
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(agentTeamsBridgeError{"route_not_found"})
			return
		}
		if err != nil {
			writeError(err)
			return
		}
		json.NewEncoder(w).Encode(result)
	}), nil
}

// AgentTeamsBridgeClient implements the daemon-side ExternalExecutor boundary.
// Endpoint, installation and token provider are installation configuration; no
// credentials, target URLs or arbitrary tool names travel in execution inputs.
type AgentTeamsBridgeClient struct {
	endpoint, installation string
	token                  func(context.Context) (string, error)
	http                   *http.Client
}

func NewAgentTeamsBridgeClient(endpoint, installation string, token func(context.Context) (string, error), client *http.Client) (*AgentTeamsBridgeClient, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Scheme != "http" && u.Scheme != "https") || (u.Path != "" && u.Path != "/") || !externalIdentifier(installation) || token == nil {
		return nil, ErrExternalIdentity
	}
	if client == nil {
		client = &http.Client{}
	}
	copied := *client
	copied.Jar = nil
	copied.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if copied.Timeout <= 0 || copied.Timeout > 2*time.Minute {
		copied.Timeout = 2 * time.Minute
	}
	return &AgentTeamsBridgeClient{strings.TrimSuffix(u.String(), "/"), installation, token, &copied}, nil
}
func (c *AgentTeamsBridgeClient) request(ctx context.Context, method, operation string, input, output any, limit int64) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		requestLimit := 8 * 1024 * 1024
		if operation == "submit" {
			requestLimit = agentteams.MaxFrozenWireBytes
		}
		if err != nil || len(data) > requestLimit {
			return ErrExternalIdentity
		}
		body = bytes.NewReader(data)
	}
	token, err := c.token(ctx)
	if err != nil || !validAgentTeamsToken(token) {
		return ErrExternalUnknown
	}
	r, err := http.NewRequestWithContext(ctx, method, c.endpoint+agentTeamsBridgePrefix+operation, body)
	if err != nil {
		return ErrExternalIdentity
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json")
	response, err := c.http.Do(r)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrExternalUnknown
	}
	defer response.Body.Close()
	if response.Header.Get(agentTeamsInstallationHeader) != c.installation {
		return ErrExternalUnknown
	}
	if response.StatusCode != 200 {
		limit = agentteams.MaxMetadataBytes
	}
	if response.ContentLength > limit {
		return ErrExternalUnknown
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return ErrExternalUnknown
	}
	if response.StatusCode != 200 {
		var failure agentTeamsBridgeError
		if json.Unmarshal(data, &failure) != nil {
			return ErrExternalUnknown
		}
		switch {
		case response.StatusCode == 404 && failure.Code == "request_absent":
			return ErrExternalNotFound
		case response.StatusCode == 410 && failure.Code == "revoked":
			return ErrExternalRevoked
		case response.StatusCode == 400 && failure.Code == "identity_invalid":
			return ErrExternalIdentity
		case response.StatusCode == 409 && failure.Code == "identity_conflict":
			return ErrExternalConflict
		case response.StatusCode == 422 && failure.Code == "capability_unsupported":
			return ErrExternalCapability
		default:
			return ErrExternalUnknown
		}
	}
	if json.Unmarshal(data, output) != nil {
		return ErrExternalUnknown
	}
	return nil
}
func (c *AgentTeamsBridgeClient) Capabilities(ctx context.Context) (ExternalCapabilities, error) {
	var out ExternalCapabilities
	err := c.request(ctx, "GET", "capabilities", nil, &out, agentteams.MaxMetadataBytes)
	return out, err
}
func (c *AgentTeamsBridgeClient) Submit(ctx context.Context, r ExternalExecutionRequest) (ExternalExecutionReceipt, error) {
	if len(r.Input) > agentteams.MaxFrozenRequestBytes {
		return ExternalExecutionReceipt{}, ErrExternalIdentity
	}
	var out ExternalExecutionReceipt
	err := c.request(ctx, "POST", "submit", r, &out, agentteams.MaxMetadataBytes)
	if err == nil {
		_, err = ReconcileExternalReceipt(r, nil, out)
	}
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	return out, nil
}
func (c *AgentTeamsBridgeClient) Lookup(ctx context.Context, id ExternalExecutionIdentity) (ExternalExecutionReceipt, error) {
	var out ExternalExecutionReceipt
	err := c.request(ctx, "POST", "lookup", id, &out, agentteams.MaxMetadataBytes)
	if err == nil && out.Identity != id {
		err = ErrExternalIdentity
	}
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	return out, nil
}
func (c *AgentTeamsBridgeClient) Cancel(ctx context.Context, id ExternalExecutionIdentity) error {
	var out struct {
		Identity              ExternalExecutionIdentity
		CancellationRequested bool
		StopConfirmed         bool
	}
	err := c.request(ctx, "POST", "cancel", id, &out, agentteams.MaxMetadataBytes)
	if err == nil && (!out.CancellationRequested || !out.StopConfirmed || out.Identity != id) {
		return ErrExternalUnknown
	}
	return err
}
func (c *AgentTeamsBridgeClient) ExportArtifact(ctx context.Context, id ExternalExecutionIdentity, path string, maxBytes int64) (AgentTeamsArtifact, error) {
	if maxBytes <= 0 || maxBytes > agentteams.MaxArtifactBytes {
		return AgentTeamsArtifact{}, agentteams.ErrArtifact
	}
	var out AgentTeamsArtifact
	err := c.request(ctx, "POST", "artifact", agentTeamsArtifactRequest{id, path, maxBytes}, &out, maxBytes*4/3+16384)
	if err == nil && (out.Path != path || out.SubmissionID == "" || int64(len(out.Data)) > maxBytes || externalPayloadDigest(out.Data) != out.SHA256) {
		err = agentteams.ErrArtifact
	}
	if err != nil {
		return AgentTeamsArtifact{}, err
	}
	return out, nil
}
