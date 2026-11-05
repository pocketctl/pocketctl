package session

import (
	"context"
	"encoding/json"
	"github.com/pocketctl/pocketctl/internal/quotareset"
	"testing"
)

func TestCodexResetUsesFreshScopeAndReusesKey(t *testing.T) {
	_, _, rpc, _ := invocationFixture(t)
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"rateLimits":{},"rateLimitResetCredits":{"availableCount":2}}`)
	snapshot, e := readCodexQuota(context.Background(), rpc, "home")
	if e != nil {
		t.Fatal(e)
	}
	rpc.results["account/rateLimitResetCredit/consume"] = json.RawMessage(`{"outcome":"reset"}`)
	store := quotareset.New(t.TempDir())
	for i := 0; i < 2; i++ {
		r, e := consumeCodexQuota(context.Background(), rpc, "home", snapshot.ScopeID, "operation-00000001", store)
		if e != nil || r.Outcome != "reset" {
			t.Fatalf("%+v %v", r, e)
		}
	}
	n := 0
	for _, c := range rpc.calls {
		if c.method == "account/rateLimitResetCredit/consume" {
			n++
		}
	}
	if n != 1 {
		t.Fatal("duplicate redemption")
	}
	_, e = consumeCodexQuota(context.Background(), rpc, "home", "wrong", "operation-00000002", store)
	if e == nil {
		t.Fatal("accepted stale scope")
	}
}
func TestCodexResetVersionFloor(t *testing.T) {
	for v, want := range map[string]bool{"0.165.0": false, "0.166.0": true, "codex-cli 0.167.1": true, "unknown": false} {
		if got := codexResetVersionSupported(v); got != want {
			t.Fatalf("%s: %v", v, got)
		}
	}
}
func TestCodexResetRevalidatesAfterDurableIntentBeforeRPC(t *testing.T) {
	_, _, rpc, _ := invocationFixture(t)
	rpc.results["account/rateLimits/read"] = json.RawMessage(`{"rateLimits":{}}`)
	snapshot, e := readCodexQuota(context.Background(), rpc, "home")
	if e != nil {
		t.Fatal(e)
	}
	r, e := consumeCodexQuota(context.Background(), rpc, "home", snapshot.ScopeID, "operation-00000003", quotareset.New(t.TempDir()), func() bool { return false })
	if e != nil || r.Outcome != "unknown" {
		t.Fatalf("%+v %v", r, e)
	}
	for _, c := range rpc.calls {
		if c.method == "account/rateLimitResetCredit/consume" {
			t.Fatal("account change reached consume RPC")
		}
	}
}
