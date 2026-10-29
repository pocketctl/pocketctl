package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentteams"
	"github.com/pocketctl/pocketctl/internal/teamdelivery"
)

type meterRemote struct {
	*externalStub
	reads     int
	afterRead func()
}

func (m *meterRemote) Usage(_ context.Context, id ExternalExecutionIdentity) (AgentTeamsUsage, error) {
	m.reads++
	if m.afterRead != nil {
		m.afterRead()
	}
	return AgentTeamsUsage{Identity: id, RemoteTaskID: "remote", Usage: agentteams.WorkerUsage{ChatID: "chat", SessionID: "matrix:!room:local", Turns: []agentteams.TurnUsage{{OriginalID: "original", Model: "m", FinishedAt: "2026-10-28T10:00:00Z", InputTokens: 20, OutputTokens: 10, CacheReadTokens: 80, TotalTokens: 110}}}}, nil
}
func TestAgentTeamsMeterRetriesLostAckAndChecksCurrentGrant(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(fmtBool(revoke), func(t *testing.T) {
			ctx := context.Background()
			denied := false
			remote := &meterRemote{externalStub: &externalStub{}}
			sm, j := agentTeamsRuntimeFixture(t, remote.externalStub, func(_ context.Context, r teamdelivery.ExternalAuthorizationRequest) error {
				if r.Phase == "account" && denied {
					return &teamdelivery.HTTPError{Status: 403, Code: "team_access_denied"}
				}
				return nil
			})
			sm.agentTeams.config.Executor = remote
			var bodies []teamdelivery.ExternalUsageRequest
			sm.agentTeams.config.RecordUsage = func(_ context.Context, r teamdelivery.ExternalUsageRequest) error {
				bodies = append(bodies, r)
				if len(bodies) == 1 {
					return errors.New("response lost after durable insert")
				}
				return nil
			}
			_, err := sm.CreateCollaborationSessionRegistered(ctx, collaborationAuth("create", "call"), nil, "agentteams", "bounded", func(context.Context, string) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			if err = sm.agentTeams.advance(ctx, "call", false); err != nil {
				t.Fatal(err)
			}
			remote.receipt.State = ExternalSucceeded
			remote.receipt.Sequence++
			remote.receipt.RemoteSubmissionID = "original-submission"
			if err = sm.agentTeams.advance(ctx, "call", true); err != nil {
				t.Fatal(err)
			}
			if _, err = j.db.Exec(`UPDATE agentteams_daemon_calls SET finished=2 WHERE call_id='call'`); err != nil {
				t.Fatal(err)
			}
			if revoke {
				remote.afterRead = func() { denied = true }
			}
			if err = sm.MeterAgentTeamsCalls(ctx); err == nil {
				t.Fatal("missing failure")
			}
			var count int
			j.db.QueryRow(`SELECT count(*) FROM agentteams_metered_calls`).Scan(&count)
			if count != 0 {
				t.Fatal("unacknowledged facts marked complete")
			}
			if revoke {
				if len(bodies) != 0 {
					t.Fatal("revoked usage uploaded")
				}
				return
			}
			if err = sm.MeterAgentTeamsCalls(ctx); err != nil {
				t.Fatal(err)
			}
			if len(bodies) != 2 || !reflect.DeepEqual(bodies[0], bodies[1]) || bodies[0].Phase != "account" {
				t.Fatal("lost response did not replay original facts")
			}
			if err = sm.MeterAgentTeamsCalls(ctx); err != nil {
				t.Fatal(err)
			}
			if len(bodies) != 2 || remote.reads != 2 {
				t.Fatal("acknowledged call redelivered")
			}
			submits, _, _ := remote.counts()
			if submits != 1 {
				t.Fatal("metering started model work")
			}
			sm.ShutdownAgentTeams()
		})
	}
}
