package session

import (
	"context"
	"errors"
	"testing"

	"github.com/pocketctl/pocketctl/internal/teamdelivery"
)

func TestAgentTeamsUserRecoveryPreservesOriginalAndDoesNotAutoRetry(t *testing.T) {
	for _, scenario := range []string{"absent", "transport-unknown", "local-receipt", "revoked", "confirmed-stop", "wrong-identity", "revoked-after-lookup"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := context.Background()
			remote := &externalStub{}
			denied := false
			sm, j := agentTeamsRuntimeFixture(t, remote, func(_ context.Context, auth teamdelivery.ExternalAuthorizationRequest) error {
				if denied {
					return &teamdelivery.HTTPError{Status: 403, Code: "team_access_denied"}
				}
				if scenario == "revoked-after-lookup" {
					_, lookups, _ := remote.counts()
					if lookups > 0 {
						denied = true
						return &teamdelivery.HTTPError{Status: 403, Code: "team_access_denied"}
					}
				}
				return nil
			})
			defer sm.ShutdownAgentTeams()
			native, err := sm.CreateCollaborationSessionRegistered(ctx, collaborationAuth("create", "call"), nil, "agentteams", "original frozen bytes", func(context.Context, string) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			command := teamdelivery.ExternalRecoveryCommand{CallID: "call", OperationID: "query-1", Action: "query", OriginalRequestID: "team-call", NativeSessionID: native, TeamSessionID: collaborationAuth("create", "call").TeamSessionID}
			var reports []teamdelivery.ExternalRecoveryReport
			sm.agentTeams.config.FetchRecovery = func(context.Context, string) ([]teamdelivery.ExternalRecoveryCommand, error) {
				return []teamdelivery.ExternalRecoveryCommand{command}, nil
			}
			sm.agentTeams.config.RecordRecovery = func(_ context.Context, r teamdelivery.ExternalRecoveryReport) error {
				reports = append(reports, r)
				return nil
			}
			if scenario == "local-receipt" || scenario == "confirmed-stop" {
				if err = sm.agentTeams.advance(ctx, "call", false); err != nil {
					t.Fatal(err)
				}
				if scenario == "confirmed-stop" {
					receipt := remote.receipt
					receipt.Sequence++
					receipt.State = ExternalCancelled
					if _, err = j.RecordReceipt(ctx, receipt); err != nil {
						t.Fatal(err)
					}
					if err = j.revoke(ctx, "call"); err != nil {
						t.Fatal(err)
					}
				}
				remote.lookupErr = ErrExternalNotFound
			}
			if scenario == "transport-unknown" {
				remote.lookupErr = errors.New("timeout")
			}
			if scenario == "revoked" {
				if err = j.revoke(ctx, "call"); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "wrong-identity" {
				command.OriginalRequestID = "another"
			}
			err = sm.ProcessAgentTeamsRecovery(ctx)
			if scenario == "wrong-identity" || scenario == "revoked-after-lookup" {
				if err == nil || len(reports) != 0 {
					t.Fatal("invalid authority reported", err, reports)
				}
				return
			}
			if err != nil || len(reports) != 1 {
				t.Fatal(err, reports)
			}
			want := "unknown"
			if scenario == "absent" {
				want = "absent"
			}
			if scenario == "confirmed-stop" {
				want = "cancelled"
			}
			if reports[0].Result.State != want {
				t.Fatalf("got %s want %s", reports[0].Result.State, want)
			}
			submits, _, _ := remote.counts()
			expected := 0
			if scenario == "local-receipt" || scenario == "confirmed-stop" {
				expected = 1
			}
			if submits != expected {
				t.Fatal("query submitted work")
			}
			if scenario != "absent" {
				return
			}
			// Model a crash after the durable dispatch claim but before remote submission.
			if _, err = j.claimSubmission(ctx, "call"); err != nil {
				t.Fatal(err)
			}
			command.Action = "retry_original"
			command.OperationID = "confirmation-1"
			if err = sm.ProcessAgentTeamsRecovery(ctx); err != nil {
				t.Fatal(err)
			}
			if err = sm.ProcessAgentTeamsRecovery(ctx); err != nil {
				t.Fatal(err)
			}
			submits, _, _ = remote.counts()
			if submits != 1 || reports[1].Result.State != "running" || remote.lastRequest.Identity.RequestID != "team-call" {
				t.Fatal("explicit retry changed original or duplicated", reports)
			}
			request, _, err := j.Load(ctx, "call")
			if err != nil {
				t.Fatal(err)
			}
			if request.InputDigest != remote.lastRequest.InputDigest {
				t.Fatal("frozen input changed")
			}
		})
	}
}
