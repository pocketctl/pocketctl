package memorysync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// GrantClient mints `memory.codegraph.write` grants through Relay's existing
// authenticated HTTP grant surface. Identity comes from the user access
// token; the daemon never parses the returned JWT.
type GrantClient struct {
	baseURL     string
	accessToken string
	httpClient  *http.Client
}

// Grant is a short-lived Memory upload capability.
type Grant struct {
	Token          string
	ExpiresIn      int
	InstallationID string
	Origin         string
}

// NewGrantClient builds the HTTP grant client for one Relay base URL.
func NewGrantClient(relayBaseURL, accessToken string, httpClient *http.Client) *GrantClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &GrantClient{
		baseURL:     relayHTTPBaseURL(relayBaseURL),
		accessToken: accessToken,
		httpClient:  httpClient,
	}
}

func relayHTTPBaseURL(raw string) string {
	base := strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(raw), "/"), "/ws")
	switch {
	case strings.HasPrefix(base, "wss://"):
		return "https://" + strings.TrimPrefix(base, "wss://")
	case strings.HasPrefix(base, "ws://"):
		return "http://" + strings.TrimPrefix(base, "ws://")
	default:
		return base
	}
}

const codegraphService = "memory.codegraph.write"

// CodegraphGrant returns a personal v1 grant (scopeInstallationID empty) or
// a scoped v2 grant for exactly one explicit shared installation.
func (c *GrantClient) CodegraphGrant(ctx context.Context, scopeInstallationID string) (Grant, error) {
	if scopeInstallationID != "" {
		return c.scopedGrant(ctx, scopeInstallationID)
	}
	installationID, err := c.resolvePersonalInstallation(ctx)
	if err != nil {
		return Grant{}, err
	}
	body := map[string]any{
		"installation_id": installationID,
		"services":        []string{codegraphService},
	}
	var result struct {
		Token                 string `json:"token"`
		ExpiresIn             int    `json:"expires_in"`
		InstallationID        string `json:"installation_id"`
		ProviderPublicOrigin  string `json:"provider_public_origin"`
	}
	if err := c.postJSON(ctx, "/api/extensions/v1/grants", body, &result); err != nil {
		return Grant{}, err
	}
	if result.Token == "" {
		return Grant{}, fmt.Errorf("empty_grant")
	}
	return Grant{
		Token:          result.Token,
		ExpiresIn:      result.ExpiresIn,
		InstallationID: result.InstallationID,
		Origin:         result.ProviderPublicOrigin,
	}, nil
}

func (c *GrantClient) resolvePersonalInstallation(ctx context.Context) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/extensions/v1/installations", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("authorization", "Bearer "+c.accessToken)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("relay_unreachable")
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("relay_installations_http_%d", response.StatusCode)
	}
	var payload struct {
		Installations []struct {
			InstallationID  string   `json:"installation_id"`
			Status          string   `json:"status"`
			EnabledServices []string `json:"enabled_services"`
		} `json:"installations"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", fmt.Errorf("invalid_response")
	}
	for _, installation := range payload.Installations {
		if installation.Status != "active" {
			continue
		}
		for _, service := range installation.EnabledServices {
			if service == codegraphService {
				return installation.InstallationID, nil
			}
		}
	}
	return "", fmt.Errorf("no_installation")
}

func (c *GrantClient) scopedGrant(ctx context.Context, installationID string) (Grant, error) {
	body := map[string]any{
		"installation_ids": []string{installationID},
		"services":         []string{codegraphService},
	}
	var result struct {
		Grant                string `json:"grant"`
		ExpiresIn            int    `json:"expires_in"`
		ProviderPublicOrigin string `json:"provider_public_origin"`
	}
	if err := c.postJSON(ctx, "/api/extensions/v2/grants", body, &result); err != nil {
		return Grant{}, err
	}
	if result.Grant == "" {
		return Grant{}, fmt.Errorf("empty_grant")
	}
	return Grant{
		Token:          result.Grant,
		ExpiresIn:      result.ExpiresIn,
		InstallationID: installationID,
		Origin:         result.ProviderPublicOrigin,
	}, nil
}

func (c *GrantClient) postJSON(ctx context.Context, path string, body any, out any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, strings.NewReader(string(encoded)))
	if err != nil {
		return err
	}
	request.Header.Set("authorization", "Bearer "+c.accessToken)
	request.Header.Set("content-type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("relay_unreachable")
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	// Errors stay bounded: status code only, never the response body.
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("forbidden")
		}
		if response.StatusCode == http.StatusNotFound {
			return fmt.Errorf("no_installation")
		}
		return fmt.Errorf("relay_http_%d", response.StatusCode)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("invalid_response")
	}
	return nil
}
