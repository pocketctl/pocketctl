package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

const CapabilityTeamConfigV2 = "team_collaboration_config_v2"
const CapabilityTeamPrivateInteractionsV2 = "team_private_interactions_v2"

type TeamRuntimeConfig struct {
	Model             string  `json:"model"`
	ReasoningEffort   *string `json:"reasoning_effort"`
	PermissionProfile string  `json:"permission_profile"`
}

func (c TeamRuntimeConfig) Hash() string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(c)
	digest := sha256.Sum256(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
	return hex.EncodeToString(digest[:])
}

type TeamConfigModel struct {
	ID                     string   `json:"id"`
	DefaultReasoningEffort *string  `json:"default_reasoning_effort,omitempty"`
	ReasoningEfforts       []string `json:"reasoning_efforts"`
}
type TeamConfigCapabilities struct {
	SchemaVersion      int               `json:"schema_version"`
	Revision           string            `json:"revision"`
	Models             []TeamConfigModel `json:"models"`
	PermissionProfiles []string          `json:"permission_profiles"`
	DefaultConfig      TeamRuntimeConfig `json:"default_config"`
	DefaultSource      string            `json:"default_source"`
	ReadOnly           bool              `json:"read_only"`
	RuntimeSwitch      string            `json:"runtime_switch"`
}
