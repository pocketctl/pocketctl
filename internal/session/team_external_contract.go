package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// ExternalExecutor is an experimental transport boundary, not a scheduler.
// Implementations must never create another remote attempt from Lookup or Cancel.
// Credentials belong to the implementation's credential store, never these DTOs.
// It is not registered as an Agent provider until durable dispatch integration is complete.
type ExternalExecutor interface {
	Capabilities(context.Context) (ExternalCapabilities, error)
	Submit(context.Context, ExternalExecutionRequest) (ExternalExecutionReceipt, error)
	Lookup(context.Context, ExternalExecutionIdentity) (ExternalExecutionReceipt, error)
	Cancel(context.Context, ExternalExecutionIdentity) error
}

type ExternalCapabilities struct {
	IdempotentSubmit bool
	LookupByRequest  bool
	Cancellation     bool
	AutomaticRetry   bool
	ArtifactExport   bool
	HardCostLimit    bool
	CostReporting    bool
	UsageReporting   bool
	ModelStop        bool
	FrozenInputs     bool
}

var (
	// ErrExternalNotFound must mean an authoritative lookup by original request
	// found no task. Timeouts, auth failures and expired retention are not absence.
	ErrExternalNotFound   = errors.New("team_external_remote_request_not_found")
	ErrExternalCapability = errors.New("team_external_capability_unsupported")
	ErrExternalIdentity   = errors.New("team_external_identity_mismatch")
	ErrExternalReceipt    = errors.New("team_external_receipt_invalid")
)

// Scope must identify Relay origin, daemon, owner and provider installation.
// AttemptID is empty for single-task calls; CallID remains mandatory in all cases.
type ExternalExecutionIdentity struct {
	Scope     string
	CallID    string
	AttemptID string
	OfferID   string
	RequestID string
}

func (id ExternalExecutionIdentity) valid() bool {
	for _, value := range []string{id.Scope, id.CallID, id.OfferID, id.RequestID} {
		if !externalIdentifier(value) {
			return false
		}
	}
	return id.AttemptID == "" || externalIdentifier(id.AttemptID)
}

func externalIdentifier(value string) bool {
	return value != "" && len(value) <= 1024 && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n")
}

// InputDigest covers immutable prompt, configuration, context and delivery bindings.
// The dispatch owner must validate current authorization before submitting or reading results.
type ExternalExecutionRequest struct {
	Identity      ExternalExecutionIdentity
	InputDigest   string
	Input         []byte
	MaxCostMicros *int64
}

func (r ExternalExecutionRequest) Validate(c ExternalCapabilities) error {
	digest := sha256.Sum256(r.Input)
	if !r.Identity.valid() || !externalDigest(r.InputDigest) || hex.EncodeToString(digest[:]) != r.InputDigest || len(r.Input) == 0 {
		return ErrExternalIdentity
	}
	if !c.IdempotentSubmit || !c.LookupByRequest || !c.Cancellation || c.AutomaticRetry || !c.ArtifactExport {
		return ErrExternalCapability
	}
	if r.MaxCostMicros != nil && (*r.MaxCostMicros < 0 || !c.HardCostLimit || !c.CostReporting) {
		return ErrExternalCapability
	}
	return nil
}

func externalDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, ch := range s {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f') {
			return false
		}
	}
	return true
}

type ExternalExecutionState string

const (
	ExternalPending   ExternalExecutionState = "pending"
	ExternalRunning   ExternalExecutionState = "running"
	ExternalSucceeded ExternalExecutionState = "succeeded"
	ExternalFailed    ExternalExecutionState = "failed"
	ExternalCancelled ExternalExecutionState = "cancelled"
)

// Sequence is monotonic within one remote task. A transport timeout is not a
// receipt or a terminal state; callers retain the last receipt and use Lookup.
// Success is execution success only; artifacts still pass PocketCtl publication
// and human review. No remote URL is itself a trusted delivery artifact.
type ExternalExecutionReceipt struct {
	Identity           ExternalExecutionIdentity
	InputDigest        string
	RemoteTaskID       string
	RemoteSubmissionID string `json:",omitempty"`
	Sequence           int64
	State              ExternalExecutionState
	CostMicros         *int64
}

func externalTerminal(s ExternalExecutionState) bool {
	return s == ExternalSucceeded || s == ExternalFailed || s == ExternalCancelled
}

// ReconcileExternalReceipt returns a detached snapshot. It rejects identity
// substitution, rewritten duplicate receipts and terminal-state regression.
// A stale receipt cannot erase more recent evidence; authorization is checked by
// the caller even when this function would return an unchanged snapshot.
func ReconcileExternalReceipt(request ExternalExecutionRequest, current *ExternalExecutionReceipt, next ExternalExecutionReceipt) (ExternalExecutionReceipt, error) {
	if !request.Identity.valid() || !externalDigest(request.InputDigest) || next.Identity != request.Identity || next.InputDigest != request.InputDigest || !externalIdentifier(next.RemoteTaskID) {
		return ExternalExecutionReceipt{}, ErrExternalIdentity
	}
	if next.Sequence < 1 || (next.RemoteSubmissionID != "" && !externalIdentifier(next.RemoteSubmissionID)) || (next.State != ExternalPending && next.State != ExternalRunning && !externalTerminal(next.State)) || (next.CostMicros != nil && *next.CostMicros < 0) {
		return ExternalExecutionReceipt{}, ErrExternalReceipt
	}
	if current != nil {
		if _, err := ReconcileExternalReceipt(request, nil, *current); err != nil {
			return ExternalExecutionReceipt{}, err
		}
		if current.Identity != request.Identity || current.InputDigest != request.InputDigest || current.RemoteTaskID != next.RemoteTaskID {
			return ExternalExecutionReceipt{}, ErrExternalIdentity
		}
		if next.Sequence < current.Sequence {
			return cloneExternalReceipt(*current), nil
		}
		if next.Sequence == current.Sequence {
			if next.State != current.State || next.RemoteSubmissionID != current.RemoteSubmissionID || !equalExternalCost(next.CostMicros, current.CostMicros) {
				return ExternalExecutionReceipt{}, ErrExternalReceipt
			}
			return cloneExternalReceipt(*current), nil
		}
		if externalTerminal(current.State) || current.RemoteSubmissionID != "" && next.RemoteSubmissionID != current.RemoteSubmissionID || current.State == ExternalRunning && next.State == ExternalPending || current.CostMicros != nil && (next.CostMicros == nil || *next.CostMicros < *current.CostMicros) {
			return ExternalExecutionReceipt{}, ErrExternalReceipt
		}
	}
	return cloneExternalReceipt(next), nil
}
func equalExternalCost(a, b *int64) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
func cloneExternalReceipt(r ExternalExecutionReceipt) ExternalExecutionReceipt {
	if r.CostMicros != nil {
		cost := *r.CostMicros
		r.CostMicros = &cost
	}
	return r
}
