// Package memorycontext protocol: daemon-side wire types for the Phase 2
// context flow (plan sections 10-11). These mirror internal/protocol grant
// messages and the Memory API context routes; the pack text itself lives
// only for the duration of one admission/delivery attempt.
package memorycontext

import (
	"sync"
	"time"
)

// CompileRequest is the POST /api/v1/memory/context/compile body.
type CompileRequest struct {
	SchemaVersion     int             `json:"schema_version"`
	ClientRequestID   string          `json:"client_request_id"`
	SessionID         string          `json:"session_id"`
	Agent             string          `json:"agent"`
	AdapterCapability string          `json:"adapter_capability"`
	RepositoryHint    *RepositoryHint `json:"repository_hint,omitempty"`
	Query             string          `json:"query"`
	RequestedAt       time.Time       `json:"requested_at"`
}

// RepositoryHint is an applicability hint only — never an authorization.
type RepositoryHint struct {
	RepositoryID string `json:"repository_id,omitempty"`
	Branch       string `json:"branch,omitempty"`
	CommitSHA    string `json:"commit_sha,omitempty"`
}

// CompileResponse is the frozen outcome union (plan 10.2).
type CompileResponse struct {
	Outcome            string    `json:"outcome"`
	RunID              string    `json:"run_id,omitempty"`
	Reason             string    `json:"reason,omitempty"`
	DegradedComponents []string  `json:"degraded_components,omitempty"`
	Pack               *WirePack `json:"pack,omitempty"`
	AdmissionRequired  bool      `json:"admission_required"`
	EffectiveMode      string    `json:"effective_mode,omitempty"`
}

// WirePack is the bounded pack summary returned to the daemon. Full stable
// and dynamic text is fetched by pack id in the enabled path only.
type WirePack struct {
	PackID        string `json:"pack_id"`
	StableTokens  int    `json:"stable_tokens"`
	DynamicTokens int    `json:"dynamic_tokens"`
	ItemCount     int    `json:"item_count"`
}

// AdmitRequest is the POST /packs/:id/admit body.
type AdmitRequest struct {
	ClientRequestID string `json:"client_request_id"`
	SessionID       string `json:"session_id"`
	Agent           string `json:"agent"`
	Adapter         string `json:"adapter"`
}

// AdmitResponse carries the single-use nonce exactly once.
type AdmitResponse struct {
	InjectionID string    `json:"injection_id"`
	Nonce       string    `json:"nonce,omitempty"`
	ExpiresAt   time.Time `json:"expires_at,omitempty"`
	State       string    `json:"state,omitempty"`
	Existing    bool      `json:"existing,omitempty"`
}

// ReceiptRequest is the POST /injections/:id/receipt body.
type ReceiptRequest struct {
	Delivered   bool   `json:"delivered"`
	OutcomeCode string `json:"outcome_code,omitempty"`
	SessionID   string `json:"session_id"`
}

// PreparedContext is what one admission/delivery attempt holds in memory.
// It is never persisted, journalled, or logged by the daemon.
type PreparedContext struct {
	PackID        string
	InjectionID   string
	Nonce         string
	ExpiresAt     time.Time
	StableText    string
	DynamicText   string
	StableDigest  string
	DynamicDigest string

	sessionID      string
	providerOrigin string
	grant          string
	receiptOnce    sync.Once
}

// DeliveryResult reports the native adapter outcome for the receipt.
type DeliveryResult struct {
	Delivered   bool
	OutcomeCode string
}
