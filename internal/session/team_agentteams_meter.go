package session

import (
	"context"
	"errors"

	"github.com/pocketctl/pocketctl/internal/teamdelivery"
)

type agentTeamsUsageReader interface {
	Usage(context.Context, ExternalExecutionIdentity) (AgentTeamsUsage, error)
}

// MeterAgentTeamsCalls delivers measured usage for settled original Calls.
// It does not delay result publication or submit any new model work. Durable
// acknowledgements survive daemon restarts; the Relay deduplicates lost ACKs.
func (sm *SessionManager) MeterAgentTeamsCalls(ctx context.Context) error {
	sm.mu.RLock()
	r := sm.agentTeams
	sm.mu.RUnlock()
	if r == nil || r.config.RecordUsage == nil {
		return nil
	}
	r.mu.Lock()
	if r.stopped || r.metering {
		r.mu.Unlock()
		return nil
	}
	r.metering = true
	r.wg.Add(1)
	r.mu.Unlock()
	defer func() { r.mu.Lock(); r.metering = false; r.mu.Unlock(); r.wg.Done() }()
	reader, ok := r.config.Executor.(agentTeamsUsageReader)
	if !ok {
		return ErrExternalCapability
	}
	rows, err := r.config.Journal.db.QueryContext(ctx, `SELECT d.call_id FROM agentteams_daemon_calls d LEFT JOIN agentteams_metered_calls m ON m.call_id=d.call_id WHERE d.finished>=1 AND m.call_id IS NULL ORDER BY d.call_id`)
	if err != nil {
		return err
	}
	var calls []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		calls = append(calls, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var failures []error
	for _, call := range calls {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err = r.meterCall(ctx, reader, call); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
func (r *agentTeamsRuntime) meterCall(ctx context.Context, reader agentTeamsUsageReader, call string) error {
	request, input, err := r.load(ctx, call)
	if err != nil {
		return err
	}
	if err = r.authorize(ctx, input.Authorization, input.NativeSessionID, "account"); err != nil {
		return err
	}
	usage, err := reader.Usage(ctx, request.Identity)
	if err != nil {
		return err
	}
	if usage.Identity != request.Identity {
		return ErrExternalIdentity
	}
	_, receipt, err := r.config.Journal.Load(ctx, call)
	if err != nil {
		return err
	}
	if receipt == nil || receipt.RemoteTaskID != usage.RemoteTaskID || (receipt.State != ExternalSucceeded && receipt.State != ExternalFailed) {
		return ErrExternalReceipt
	}
	if err = r.authorize(ctx, input.Authorization, input.NativeSessionID, "account"); err != nil {
		return err
	}
	err = r.config.RecordUsage(ctx, teamdelivery.ExternalUsageRequest{ExternalAuthorizationRequest: teamdelivery.ExternalAuthorizationRequest{Authorization: input.Authorization, RequestID: request.Identity.RequestID, NativeSessionID: input.NativeSessionID, Phase: "account"}, RemoteTaskID: usage.RemoteTaskID, Usage: usage.Usage})
	if err != nil {
		return err
	}
	_, err = r.config.Journal.db.ExecContext(ctx, `INSERT INTO agentteams_metered_calls(call_id) VALUES(?) ON CONFLICT DO NOTHING`, call)
	return err
}
