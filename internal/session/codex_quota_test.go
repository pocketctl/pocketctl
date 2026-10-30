package session

import (
	"context"
	"encoding/json"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"strings"
	"testing"
)

func TestCodexQuotaReadUsesActualBackendWithoutSkillsOrTurns(t *testing.T) {
	sm, c, rpc, _ := invocationFixture(t)
	c.projectCwd = "" // Terminal-managed runtimes support the same read API.
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"accountId":"secret-account","ordinaryUsageAllowed":true,"rateLimitsByLimitId":{"codex":{"limitName":"Codex","primary":{"usedPercent":92.5,"windowDurationMins":10080,"resetsAt":1793350000},"secondary":null}}}`)
	result, err := sm.ReadCodexRateLimits(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(result)
	if strings.Contains(string(raw), "secret-account") {
		t.Fatal("raw account identity leaked")
	}
	if result.Kind != "codex_rate_limits" || len(result.Buckets) != 1 || result.Buckets[0].Windows[0].RemainingPercent != 7.5 || result.Exhausted {
		t.Fatalf("bad snapshot: %s", raw)
	}
	if len(rpc.calls) != 1 || rpc.calls[0].method != "account/rateLimits/read" {
		t.Fatalf("read performed unrelated operations: %#v", rpc.calls)
	}
}
func TestCodexQuotaUnknownIsNotZeroOrExhausted(t *testing.T) {
	sm, _, rpc, _ := invocationFixture(t)
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":101},"secondary":{"usedPercent":null}}}`)
	got, err := sm.ReadCodexRateLimits(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if got.Exhausted || len(got.Buckets) != 0 {
		t.Fatalf("invalid quota became known: %+v", got)
	}
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"ordinaryUsageAllowed":false,"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300}}}`)
	got, err = sm.ReadCodexRateLimits(context.Background(), "s")
	if err != nil || !got.Exhausted || len(got.Buckets) != 1 {
		t.Fatalf("explicit limit lost: %+v %v", got, err)
	}
}
func TestCodexQuotaInvalidationOnlyTargetsOwningRuntime(t *testing.T) {
	sm, c, _, _ := invocationFixture(t)
	output := make(chan protocol.DaemonEvent, 8)
	sm.outputCh = output
	sm.sessions["other"] = &ProcessState{SessionID: "other", Agent: "codex", Backend: newCodexAppServerBackend(sm, newCodexCoordinator(sm), nil, 1)}
	c.projectLive(newCodexProjection(1), codexNotification("account/updated", `{}`))
	select {
	case ev := <-output:
		if ev.Type != "codex_rate_limits_changed" || ev.SessionID != "s" || !ev.Resync {
			t.Fatalf("unexpected %+v", ev)
		}
	default:
		t.Fatal("missing account invalidation")
	}
	if len(output) != 0 {
		t.Fatal("invalidated unrelated runtime")
	}
}
