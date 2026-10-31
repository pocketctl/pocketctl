package session

import (
	"context"
	"encoding/json"
	"github.com/pocketctl/pocketctl/internal/adapter"
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
	if len(rpc.calls) != 3 || rpc.calls[0].method != "account/read" || rpc.calls[1].method != "account/rateLimits/read" || rpc.calls[2].method != "account/read" {
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
	case host := <-output:
		if host.Type != "codex_rate_limits_changed" || host.SessionID != "" || !host.Resync {
			t.Fatalf("unexpected host invalidation: %+v", host)
		}
	default:
		t.Fatal("missing host invalidation")
	}
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

func TestCodexQuotaPlanWindowsAndResetCredits(t *testing.T) {
	sm, _, rpc, _ := invocationFixture(t)
	rpc.results["account/read"] = json.RawMessage(`{"account":{"type":"chatgpt","planType":"pro","email":"private@example.invalid"}}`)
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"accountId":"private-id","rateLimits":{"planType":"pro","primary":{"usedPercent":21,"windowDurationMins":10080},"secondary":null},"rateLimitResetCredits":{"availableCount":3,"credits":[{"id":"secret-credit","status":"available","resetType":"codexRateLimits","expiresAt":1793925428},{"id":"secret-credit","status":"available","resetType":"codexRateLimits","expiresAt":1793925428},{"id":"consumed","status":"redeemed","resetType":"codexRateLimits"}]}}`)
	got, err := sm.ReadCodexRateLimits(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if got.PlanType != "pro" || got.Status != "ok" || len(got.Buckets) != 1 || len(got.Buckets[0].Windows) != 1 || *got.Buckets[0].Windows[0].DurationMinutes != 10080 {
		t.Fatalf("Pro window changed: %+v", got)
	}
	if got.ResetCredits == nil || got.ResetCredits.AvailableCount != 3 || len(got.ResetCredits.Credits) != 1 {
		t.Fatalf("authoritative count/details lost: %+v", got.ResetCredits)
	}
	raw, _ := json.Marshal(got)
	for _, secret := range []string{"private@example.invalid", "private-id", "secret-credit", "consumed"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("private field leaked: %s", secret)
		}
	}
	rpc.results["account/read"] = json.RawMessage(`{"account":{"type":"chatgpt","planType":"plus"}}`)
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":12,"windowDurationMins":10080},"secondary":{"usedPercent":22,"windowDurationMins":300}},"rateLimitResetCredits":{"availableCount":0,"credits":[]}}`)
	got, err = sm.ReadCodexRateLimits(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if got.PlanType != "plus" || *got.Buckets[0].Windows[1].DurationMinutes != 300 || got.ResetCredits == nil || got.ResetCredits.AvailableCount != 0 {
		t.Fatalf("Plus duration or known zero lost: %+v", got)
	}
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"rateLimits":{},"rateLimitResetCredits":{"availableCount":-1}}`)
	got, err = sm.ReadCodexRateLimits(context.Background(), "s")
	if err != nil || got.ResetCredits != nil {
		t.Fatalf("invalid count became known: %+v %v", got, err)
	}
}
func TestCodexQuotaSignedOutAndAPIKeyNeverReadLimits(t *testing.T) {
	for _, raw := range []string{`{"account":null}`, `{"account":{"type":"apiKey"}}`} {
		sm, _, rpc, _ := invocationFixture(t)
		rpc.results["account/read"] = json.RawMessage(raw)
		got, err := sm.ReadCodexRateLimits(context.Background(), "s")
		if err != nil || got.Status == "ok" || len(rpc.calls) != 1 {
			t.Fatalf("unexpected read: %+v %v", got, err)
		}
	}
}
func TestCodexHostQuotaUsesHomeWithoutSessionOrRuntimeAcquisition(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	t.Setenv("POCKETCTL_CODEX_HOMES", "")
	sm, c, rpc, _ := invocationFixture(t)
	p := sm.CodexRuntimeProvider()
	p.coordinator = c
	c.codexHomeID = adapter.CodexHomeProfiles()[0].ID
	rpc.results["account/read"] = json.RawMessage(`{"account":{"type":"chatgpt","planType":"pro"}}`)
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":4,"windowDurationMins":10080}}}`)
	delete(sm.sessions, "s")
	got, err := sm.ReadCodexHostRateLimits(context.Background(), "")
	if err != nil || got.PlanType != "pro" {
		t.Fatalf("host read: %+v %v", got, err)
	}
	if _, err = sm.ReadCodexHostRateLimits(context.Background(), ""); err != nil || len(rpc.calls) != 3 {
		t.Fatalf("cache did not coalesce reads: %v calls=%d", err, len(rpc.calls))
	}
	if _, err = sm.ReadCodexHostRateLimits(context.Background(), "/untrusted/path"); err == nil {
		t.Fatal("unallowlisted home accepted")
	}
	if len(sm.sessions) != 0 || len(sm.leases.Snapshot()) != 0 {
		t.Fatal("quota read created a session or lease")
	}
}

type changingQuotaAccount struct{ reads int }

func (c *changingQuotaAccount) Call(_ context.Context, method string, _ any, out any) error {
	raw := `{"rateLimits":{"planType":"pro","primary":{"usedPercent":2,"windowDurationMins":10080}}}`
	if method == "account/read" {
		c.reads++
		if c.reads == 1 {
			raw = `{"account":{"type":"chatgpt","email":"first@invalid","planType":"pro"}}`
		} else {
			raw = `{"account":{"type":"chatgpt","email":"second@invalid","planType":"plus"}}`
		}
	}
	return json.Unmarshal([]byte(raw), out)
}
func TestCodexQuotaRejectsAccountChangeDuringRead(t *testing.T) {
	if _, err := readCodexQuota(context.Background(), &changingQuotaAccount{}, "home"); err == nil || err.Error() != "quota_account_changed" {
		t.Fatalf("mixed-account snapshot accepted: %v", err)
	}
}
