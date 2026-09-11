package codexapp

import (
	"context"
	"errors"
	"fmt"
)

// SkillMetadata is the native catalog entry, not a filesystem scan result.
// Path must only be passed back to the runtime that produced this catalog.
type SkillMetadata struct {
	Name             string  `json:"name"`
	Description      string  `json:"description"`
	ShortDescription string  `json:"shortDescription,omitempty"`
	Path             string  `json:"path"`
	Scope            string  `json:"scope"`
	Enabled          bool    `json:"enabled"`
	PluginID         *string `json:"pluginId,omitempty"`
}

type SkillLoadError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

type SkillsCatalog struct {
	Cwd    string           `json:"cwd"`
	Skills []SkillMetadata  `json:"skills"`
	Errors []SkillLoadError `json:"errors"`
}

type SkillsListResponse struct {
	Data []SkillsCatalog `json:"data"`
}

// ListSkills deliberately sends only the fields supported by Codex 0.154.0.
// Extra roots are process-scoped; they must not be set on the shared runtime
// as part of a per-session catalog query.
func (c *Client) ListSkills(ctx context.Context, cwds []string, forceReload bool) (SkillsListResponse, error) {
	var result SkillsListResponse
	if len(cwds) == 0 {
		return result, errors.New("skills query requires explicit session directories")
	}
	for _, cwd := range cwds {
		if cwd == "" {
			return result, errors.New("skills query contains an empty session directory")
		}
	}
	err := c.Call(ctx, "skills/list", struct {
		Cwds        []string `json:"cwds"`
		ForceReload bool     `json:"forceReload"`
	}{cwds, forceReload}, &result)
	return result, err
}

var (
	ErrSkillNotFound  = errors.New("skill is absent from the current native catalog")
	ErrSkillAmbiguous = errors.New("multiple skills have this name; select a source")
	ErrSkillDisabled  = errors.New("skill is disabled")
)

// ResolveSkill keeps same-name definitions distinct. A supplied native path is
// an identity constraint, never permission to load an arbitrary SKILL.md file.
// Callers must fetch a fresh authorized session catalog before execution and
// enforce any additional project metadata restrictions before creating a turn.
func (catalog SkillsCatalog) ResolveSkill(name, nativePath string) (SkillMetadata, error) {
	var matches []SkillMetadata
	seen := make(map[string]bool)
	for _, skill := range catalog.Skills {
		if skill.Name != name || skill.Path == "" || (nativePath != "" && skill.Path != nativePath) || seen[skill.Path] {
			continue
		}
		seen[skill.Path] = true
		matches = append(matches, skill)
	}
	if len(matches) == 0 {
		return SkillMetadata{}, ErrSkillNotFound
	}
	if len(matches) != 1 {
		return SkillMetadata{}, ErrSkillAmbiguous
	}
	if !matches[0].Enabled {
		return SkillMetadata{}, fmt.Errorf("%w: %s", ErrSkillDisabled, name)
	}
	return matches[0], nil
}
