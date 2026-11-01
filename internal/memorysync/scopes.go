package memorysync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
)

// Scope contains discovery metadata only, never credentials or capability grants.
type Scope struct {
	InstallationID string   `json:"installation_id"`
	Kind           string   `json:"kind"`
	Name           string   `json:"name"`
	Status         string   `json:"status"`
	Permissions    []string `json:"permissions"`
}

type ScopeList struct {
	Scopes                []Scope `json:"scopes"`
	SharedScopesAvailable bool    `json:"shared_scopes_available"`
}

// ListScopes reads the user's existing memberships without minting a grant.
// Older Relays can list personal installations; shared discovery is explicitly
// reported unavailable rather than silently presented as an empty shared list.
func (c *GrantClient) ListScopes(ctx context.Context) (ScopeList, error) {
	var installations struct {
		Items []struct {
			ID       string `json:"installation_id"`
			Provider string `json:"provider_id"`
			Status   string `json:"status"`
			Kind     string `json:"owner_scope_kind"`
			OwnerID  string `json:"owner_scope_id"`
		} `json:"installations"`
	}
	available, err := c.getDiscovery(ctx, "/api/extensions/v2/installations", &installations)
	if err != nil {
		return ScopeList{}, err
	}
	var metadata struct {
		Scopes []struct {
			Kind        string   `json:"owner_scope_kind"`
			OwnerID     string   `json:"owner_scope_id"`
			Name        string   `json:"name"`
			Permissions []string `json:"permissions"`
		} `json:"scopes"`
	}
	if available {
		ok, err := c.getDiscovery(ctx, "/api/extensions/v2/scopes", &metadata)
		if err != nil {
			return ScopeList{}, err
		}
		if !ok {
			return ScopeList{}, fmt.Errorf("scope_metadata_unavailable")
		}
	} else {
		ok, err := c.getDiscovery(ctx, "/api/extensions/v1/installations", &installations)
		if err != nil {
			return ScopeList{}, err
		}
		if !ok {
			return ScopeList{}, fmt.Errorf("installations_unavailable")
		}
	}
	result := ScopeList{Scopes: []Scope{}, SharedScopesAvailable: available}
	if installations.Items == nil || (available && metadata.Scopes == nil) {
		return ScopeList{}, fmt.Errorf("invalid_response")
	}
	for _, item := range installations.Items {
		if item.Provider != "pocketctl-memory" || (item.Status != "active" && item.Status != "pending" && item.Status != "paused") {
			continue
		}
		kind := item.Kind
		if !available {
			kind = "personal"
		}
		if item.ID == "" || (kind != "personal" && kind != "team" && kind != "organization") {
			return ScopeList{}, fmt.Errorf("invalid_response")
		}
		scope := Scope{InstallationID: item.ID, Kind: kind, Name: kind, Status: item.Status, Permissions: []string{}}
		owner := item.OwnerID
		if kind == "personal" {
			owner = item.ID
		}
		matched := false
		for _, meta := range metadata.Scopes {
			if meta.Kind == kind && meta.OwnerID == owner {
				matched = true
				scope.Name = meta.Name
				scope.Permissions = append(scope.Permissions, meta.Permissions...)
				break
			}
		}
		if kind != "personal" && !matched {
			// Membership may have been withdrawn between the two reads.
			continue
		}
		sort.Strings(scope.Permissions)
		result.Scopes = append(result.Scopes, scope)
	}
	sort.Slice(result.Scopes, func(i, j int) bool {
		a, b := result.Scopes[i], result.Scopes[j]
		if a.Kind != b.Kind {
			order := map[string]int{"personal": 0, "team": 1, "organization": 2}
			return order[a.Kind] < order[b.Kind]
		}
		return a.InstallationID < b.InstallationID
	})
	return result, nil
}

func (c *GrantClient) getDiscovery(ctx context.Context, path string, out any) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return false, fmt.Errorf("invalid_relay_url")
	}
	request.Header.Set("Authorization", "Bearer "+c.accessToken)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return false, fmt.Errorf("relay_unreachable")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return false, fmt.Errorf("invalid_response")
	}
	if response.StatusCode != http.StatusOK {
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &body)
		if response.StatusCode == http.StatusNotFound || (response.StatusCode == http.StatusServiceUnavailable && body.Error.Code == "feature_disabled") {
			return false, nil
		}
		// Never echo an upstream body, URL, or credential in a diagnostic.
		return false, fmt.Errorf("relay_scopes_http_%d", response.StatusCode)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return false, fmt.Errorf("invalid_response")
	}
	return true, nil
}
