package session

import (
	"context"
	"errors"
)

var ErrExternalRevoked = errors.New("team_external_execution_revoked")
var ErrExternalUnknown = errors.New("team_external_result_unknown")

// ExternalCoordinator does not poll, schedule retries, publish artifacts or
// accept delivery. The authorization callback must check the current Relay grant
// against the complete frozen request, not merely trust identity fields.
// Production dispatch must supply the real authority; this is not registered yet.
type ExternalCoordinator struct {
	journal   *ExternalJournal
	executor  ExternalExecutor
	authorize func(context.Context, ExternalExecutionRequest) error
}

func NewExternalCoordinator(j *ExternalJournal, e ExternalExecutor, authorize func(context.Context, ExternalExecutionRequest) error) (*ExternalCoordinator, error) {
	if j == nil || e == nil || authorize == nil {
		return nil, ErrExternalIdentity
	}
	return &ExternalCoordinator{journal: j, executor: e, authorize: authorize}, nil
}
func (c *ExternalCoordinator) allowed(ctx context.Context, r ExternalExecutionRequest) error {
	if r.Identity.Scope != c.journal.scope {
		return ErrExternalIdentity
	}
	revoked, err := c.journal.revoked(ctx, r.Identity.CallID)
	if err != nil {
		return err
	}
	if revoked {
		return ErrExternalRevoked
	}
	// Detach slices/pointers before handing authority to an implementation.
	return c.authorize(ctx, cloneExternalRequest(r))
}
func cloneExternalRequest(r ExternalExecutionRequest) ExternalExecutionRequest {
	r.Input = append([]byte(nil), r.Input...)
	if r.MaxCostMicros != nil {
		v := *r.MaxCostMicros
		r.MaxCostMicros = &v
	}
	return r
}

// Start submits once or performs a read-only recovery lookup. A missing remote
// result after a crash before submission remains unknown and requires an explicit
// recovery action; it is never permission to create a fresh remote request.
func (c *ExternalCoordinator) Start(ctx context.Context, r ExternalExecutionRequest) (ExternalExecutionReceipt, error) {
	r = cloneExternalRequest(r)
	if err := c.allowed(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	caps, err := c.executor.Capabilities(ctx)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if err = r.Validate(caps); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if err = c.journal.SaveIntent(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	claimed, err := c.journal.claimSubmission(ctx, r.Identity.CallID)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if !claimed {
		return c.Recover(ctx, r.Identity.CallID)
	}
	if err = c.allowed(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	receipt, err := c.executor.Submit(ctx, cloneExternalRequest(r))
	return c.finish(ctx, r, receipt, err)
}
func (c *ExternalCoordinator) Recover(ctx context.Context, callID string) (ExternalExecutionReceipt, error) {
	r, _, err := c.journal.Load(ctx, callID)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if err = c.allowed(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	receipt, err := c.executor.Lookup(ctx, r.Identity)
	return c.finish(ctx, r, receipt, err)
}
func (c *ExternalCoordinator) finish(ctx context.Context, r ExternalExecutionRequest, receipt ExternalExecutionReceipt, remoteErr error) (ExternalExecutionReceipt, error) {
	// Recheck after remote I/O, including timeouts. An in-flight submit may have
	// finished after cancellation; retry cancellation against the same identity.
	if err := c.allowed(ctx, r); err != nil {
		if errors.Is(err, ErrExternalRevoked) {
			_ = c.executor.Cancel(ctx, r.Identity)
		}
		return ExternalExecutionReceipt{}, err
	}
	if remoteErr != nil {
		return ExternalExecutionReceipt{}, errors.Join(ErrExternalUnknown, remoteErr)
	}
	if _, err := ReconcileExternalReceipt(r, nil, receipt); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	stored, err := c.journal.RecordReceipt(ctx, receipt)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if err = c.allowed(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	return stored, nil
}

// Revoke is called by the trusted lifecycle owner. Tombstones are durable even
// if cancellation fails. Retrying Revoke retries cancellation, never submission.
func (c *ExternalCoordinator) Revoke(ctx context.Context, callID string) error {
	r, _, err := c.journal.Load(ctx, callID)
	if err != nil {
		return err
	}
	if err = c.journal.revoke(ctx, callID); err != nil {
		return err
	}
	return c.executor.Cancel(ctx, r.Identity)
}

// RetryOriginal is an explicit user-confirmed action, never a timer or automatic
// error handler. It loads the original bytes and request key from private storage.
func (c *ExternalCoordinator) RetryOriginal(ctx context.Context, callID, confirmationID string) (ExternalExecutionReceipt, error) {
	if !externalIdentifier(confirmationID) {
		return ExternalExecutionReceipt{}, ErrExternalIdentity
	}
	r, current, err := c.journal.Load(ctx, callID)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if err = c.allowed(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	receipt, lookupErr := c.executor.Lookup(ctx, r.Identity)
	if lookupErr == nil {
		return c.finish(ctx, r, receipt, nil)
	}
	if !errors.Is(lookupErr, ErrExternalNotFound) {
		return c.finish(ctx, r, receipt, lookupErr)
	}
	if err = c.allowed(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	// Local evidence of a remote task cannot be erased by a provider's forgotten
	// or expired request index. Such a mismatch needs reconciliation, not retry.
	if current != nil {
		return ExternalExecutionReceipt{}, ErrExternalReceipt
	}
	caps, err := c.executor.Capabilities(ctx)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if err = r.Validate(caps); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	claimed, err := c.journal.claimRetry(ctx, callID, confirmationID)
	if err != nil {
		return ExternalExecutionReceipt{}, err
	}
	if !claimed {
		return c.Recover(ctx, callID)
	}
	if err = c.allowed(ctx, r); err != nil {
		return ExternalExecutionReceipt{}, err
	}
	receipt, err = c.executor.Submit(ctx, cloneExternalRequest(r))
	return c.finish(ctx, r, receipt, err)
}
