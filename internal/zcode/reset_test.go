package zcode

import (
	"context"
	"encoding/json"
	"github.com/pocketctl/pocketctl/internal/quotareset"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestZcodeResetUsesBothTokensAndKeepsMillisecondsPrivate(t *testing.T) {
	uses := 0
	r := quotaFixture(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/status" {
			if q.Header.Get("Authorization") != "Bearer zcode-jwt" || q.Header.Get("X-Bigmodel-Authorization") != "platform-jwt" || q.Header.Get("Bigmodel-Target-Type") != "PERSONAL" {
				t.Error("wrong reset authorization")
			}
			w.Write([]byte(`{"code":0,"data":{"available_five_hour_resets":[],"available_week_resets":[{"expire_at":1797955199000}]}}`))
			return
		}
		if q.URL.Path == "/use" {
			uses++
			var v map[string]string
			json.NewDecoder(q.Body).Decode(&v)
			if v["reset_type"] != "WEEK" || v["idempotency_key"] != "operation-00000001" {
				t.Error("wrong use body")
			}
			w.Write([]byte(`{"code":0,"data":{"used":true}}`))
			return
		}
		w.Write([]byte(`{"code":200,"data":{"limits":[]}}`))
	})
	path := filepath.Join(r.root, "credentials.json")
	b, _ := os.ReadFile(path)
	var creds map[string]string
	json.Unmarshal(b, &creds)
	creds["zcodejwttoken"] = "zcode-jwt"
	creds["oauth:bigmodel:access_token"] = "platform-jwt"
	b, _ = json.Marshal(creds)
	os.WriteFile(path, b, 0600)
	r.resetEndpoint = r.endpoint
	snapshot, e := r.Read(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if snapshot.ResetCards.Status != "ok" || snapshot.ResetCards.Cards[1].AvailableCount != 1 || snapshot.ResetCards.Cards[1].ExpiresAt[0] != 1797955199 {
		t.Fatalf("bad cards %+v", snapshot.ResetCards)
	}
	store := quotareset.New(t.TempDir())
	for i := 0; i < 2; i++ {
		v, e := r.ConsumeReset(context.Background(), snapshot.ScopeID, "WEEK", "operation-00000001", store)
		if e != nil || v.Outcome != "reset" {
			t.Fatalf("%+v %v", v, e)
		}
	}
	if uses != 1 {
		t.Fatal("duplicate use")
	}
}

func TestResetCardsFailureDoesNotEraseValidQuota(t *testing.T) {
	r := quotaFixture(t, func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"code":200,"data":{"limits":[]}}`)) })
	got, e := r.Read(context.Background())
	if e != nil || got.Status != "ok" || got.ResetCards.Status != "authentication_required" || got.ResetSupported {
		t.Fatalf("quota and cards conflated: %+v %v", got, e)
	}
}
func TestResetCredentialStampTracksTokenRotation(t *testing.T) {
	r := quotaFixture(t, func(http.ResponseWriter, *http.Request) {})
	before, e := r.resetCredentialStamp()
	if e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(r.root, "credentials.json")
	raw, _ := os.ReadFile(p)
	var creds map[string]string
	json.Unmarshal(raw, &creds)
	creds["zcodejwttoken"] = "rotated"
	raw, _ = json.Marshal(creds)
	os.WriteFile(p, raw, 0600)
	after, e := r.resetCredentialStamp()
	if e != nil || before == after {
		t.Fatal("token rotation not observed")
	}
}
func TestMalformedCardExpiryIsUnknownNotZero(t *testing.T) {
	r := quotaFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"available_five_hour_resets":[{}],"available_week_resets":[]}}`))
	})
	p := filepath.Join(r.root, "credentials.json")
	raw, _ := os.ReadFile(p)
	var creds map[string]string
	json.Unmarshal(raw, &creds)
	creds["zcodejwttoken"] = "z-jwt"
	creds["oauth:bigmodel:access_token"] = "m-jwt"
	raw, _ = json.Marshal(creds)
	os.WriteFile(p, raw, 0600)
	r.resetEndpoint = r.endpoint
	c, _ := r.credential()
	cards := r.readResetCards(context.Background(), c)
	if cards.Status != "unavailable" || cards.Cards != nil {
		t.Fatalf("malformed expiry became known count: %+v", cards)
	}
}

func resetCredentialFixture(t *testing.T, r *QuotaReader) quotaCredential {
	t.Helper()
	path := filepath.Join(r.root, "credentials.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var creds map[string]string
	if err = json.Unmarshal(raw, &creds); err != nil {
		t.Fatal(err)
	}
	creds["zcodejwttoken"] = "fixture-zcode"
	creds["oauth:bigmodel:access_token"] = "fixture-platform"
	raw, err = json.Marshal(creds)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	r.resetEndpoint = r.endpoint
	credential, err := r.credential()
	if err != nil {
		t.Fatal(err)
	}
	return credential
}
func TestZcodeResetRedirectNeverForwardsTokensOrReplaysPOST(t *testing.T) {
	var targetCalls, uses atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { targetCalls.Add(1) }))
	defer target.Close()
	r := quotaFixture(t, func(w http.ResponseWriter, q *http.Request) {
		uses.Add(1)
		if q.Method != "POST" || q.Header.Get("Authorization") != "Bearer fixture-zcode" || q.Header.Get("X-Bigmodel-Authorization") != "fixture-platform" {
			t.Error("unexpected reset authorization")
		}
		http.Redirect(w, q, target.URL, http.StatusTemporaryRedirect)
	})
	credential := resetCredentialFixture(t, r)
	store := quotareset.New(t.TempDir())
	for i := 0; i < 2; i++ {
		result, err := r.ConsumeReset(context.Background(), credential.scope, "WEEK", "operation-redirect-01", store)
		if err != nil || result.Outcome != "unknown" {
			t.Fatalf("redirect outcome: %+v %v", result, err)
		}
	}
	if targetCalls.Load() != 0 || uses.Load() != 1 {
		t.Fatalf("redirect or replay occurred: destination=%d posts=%d", targetCalls.Load(), uses.Load())
	}
}
func TestZcodeResetRejectsChangedAccountBeforePOST(t *testing.T) {
	var calls atomic.Int32
	r := quotaFixture(t, func(http.ResponseWriter, *http.Request) { calls.Add(1) })
	credential := resetCredentialFixture(t, r)
	path := filepath.Join(r.root, "credentials.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var creds map[string]string
	if err = json.Unmarshal(raw, &creds); err != nil {
		t.Fatal(err)
	}
	creds["oauth:bigmodel:user_info"] = `{"id":"other"}`
	raw, err = json.Marshal(creds)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = r.ConsumeReset(context.Background(), credential.scope, "WEEK", "operation-account-01", quotareset.New(t.TempDir()))
	if err == nil || err.Error() != "quota_account_changed" || calls.Load() != 0 {
		t.Fatalf("changed account reached reset API: calls=%d error=%v", calls.Load(), err)
	}
}
