package session

import (
	"context"
	"errors"

	"github.com/pocketctl/pocketctl/internal/teamdelivery"
)

// ProcessAgentTeamsRecovery consumes only explicit user operations persisted by
// Relay. Periodic polling never creates retry commands or new execution intents.
func (sm *SessionManager) ProcessAgentTeamsRecovery(ctx context.Context) error {
	sm.mu.RLock()
	r := sm.agentTeams
	sm.mu.RUnlock()
	if r == nil || r.config.FetchRecovery == nil || r.config.RecordRecovery == nil {
		return nil
	}
	r.mu.Lock()
	if r.stopped || r.recovering {
		r.mu.Unlock()
		return nil
	}
	r.recovering = true
	r.wg.Add(1)
	r.mu.Unlock()
	defer func() { r.mu.Lock(); r.recovering = false; r.mu.Unlock(); r.wg.Done() }()
	commands, err := r.config.FetchRecovery(ctx, r.config.DaemonID)
	if err != nil {
		return err
	}
	var failures []error
	for _, command := range commands {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := r.recoverOriginal(ctx, command); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
func (r *agentTeamsRuntime) recoverOriginal(ctx context.Context, command teamdelivery.ExternalRecoveryCommand) error {
	if command.OperationID == "" || (command.Action != "query" && command.Action != "retry_original") {
		return ErrExternalIdentity
	}
	request, input, err := r.load(ctx, command.CallID)
	if err != nil {
		return err
	}
	if request.Identity.RequestID != command.OriginalRequestID || input.NativeSessionID != command.NativeSessionID || input.Authorization.TeamSessionID != command.TeamSessionID {
		return ErrExternalIdentity
	}
	if err = r.authorize(ctx, input.Authorization, input.NativeSessionID, "account"); err != nil {
		return err
	}
	_, saved, err := r.config.Journal.Load(ctx, command.CallID)
	if err != nil {
		return err
	}
	revoked, err := r.config.Journal.revoked(ctx, command.CallID)
	if err != nil {
		return err
	}
	result := teamdelivery.ExternalRecoveryResult{State: "unknown"}
	if revoked {
		// Only a confirmed stop receipt proves cancellation. A tombstone alone does
		// not prove that a remote Worker stopped, and can never authorize resubmission.
		if command.Action == "query" && saved != nil && saved.State == ExternalCancelled {
			result.State = "cancelled"
			remote := saved.RemoteTaskID
			result.RemoteTaskID = &remote
		}
	} else {
		phase := "account"
		if command.Action == "retry_original" {
			phase = "observe"
		}
		coordinator, err := NewExternalCoordinator(r.config.Journal, r.config.Executor, func(ctx context.Context, _ ExternalExecutionRequest) error {
			return r.authorize(ctx, input.Authorization, input.NativeSessionID, phase)
		})
		if err != nil {
			return err
		}
		var receipt ExternalExecutionReceipt
		if command.Action == "query" {
			receipt, err = coordinator.Recover(ctx, command.CallID)
		} else {
			receipt, err = coordinator.RetryOriginal(ctx, command.CallID, command.OperationID)
		}
		if err == nil {
			result.State = string(receipt.State)
			remote := receipt.RemoteTaskID
			result.RemoteTaskID = &remote
		} else if command.Action == "query" && errors.Is(err, ErrExternalNotFound) && saved == nil {
			// Read the journal again after I/O: a concurrent observer may have received
			// a receipt while this lookup was in flight. Never erase that evidence.
			_, current, readErr := r.config.Journal.Load(ctx, command.CallID)
			if readErr != nil {
				return readErr
			}
			denied, readErr := r.config.Journal.revoked(ctx, command.CallID)
			if readErr != nil {
				return readErr
			}
			if current == nil && !denied {
				result.State = "absent"
			}
		}
	}
	if err = r.authorize(ctx, input.Authorization, input.NativeSessionID, "account"); err != nil {
		return err
	}
	return r.config.RecordRecovery(ctx, teamdelivery.ExternalRecoveryReport{
		ExternalAuthorizationRequest: teamdelivery.ExternalAuthorizationRequest{Authorization: input.Authorization, RequestID: request.Identity.RequestID, NativeSessionID: input.NativeSessionID, Phase: "account"}, OperationID: command.OperationID, Result: result,
	})
}
