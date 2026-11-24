package zcode

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func setProtectedLogin(t *testing.T, r *QuotaReader, login string) {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"oauth:active_provider":           "enc:v2:provider",
		"oauth:bigmodel:user_info":        "enc:v2:" + login,
		"project-key-location:v1:fixture": "enc:v2:opaque-location",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.root, "credentials.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

const boundQuotaResponse = `{"code":200,"data":{"level":"pro","limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":41},{"type":"CREDIT_LIMIT","unit":6,"number":1,"percentage":12}]}}`

func TestProtectedQuotaBinding(t *testing.T) {
	var calls atomic.Int32
	r := quotaFixture(t, func(w http.ResponseWriter, req *http.Request) {
		calls.Add(1)
		if req.Method != http.MethodGet {
			t.Error("unexpected request method")
		}
		if req.Header.Get("Authorization") != "fixture-key" {
			http.Error(w, "invalid", http.StatusUnauthorized)
			return
		}
		w.Write([]byte(boundQuotaResponse))
	})
	r.bindingPath = filepath.Join(t.TempDir(), "private", "zcode-quota.json")
	setProtectedLogin(t, r, "first")
	ctx := context.Background()
	requireUnbound := func() {
		t.Helper()
		q, err := r.Read(ctx)
		if err != nil || !q.BindingRequired || q.Status != "unsupported" || q.Windows[0].RemainingPercent != nil || q.ResetSupported {
			t.Fatalf("unexpected unbound state: %#v, %v", q, err)
		}
	}
	requireUnbound()
	if calls.Load() != 0 {
		t.Fatal("sent request before binding")
	}
	if err := r.BindQuotaKey(ctx, "fixture-key"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(r.bindingPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 && filepath.Separator != '\\' {
		t.Fatal("binding is not private")
	}
	if err := r.BindQuotaKey(ctx, "wrong-key"); err == nil {
		t.Fatal("invalid key accepted")
	}
	q, err := r.Read(ctx)
	if err != nil || q.Status != "ok" || q.BindingRequired || q.ResetSupported || *q.Windows[0].RemainingPercent != 59 || *q.Windows[1].RemainingPercent != 88 {
		t.Fatalf("bound read: %#v %v", q, err)
	}
	payload, _ := json.Marshal(q)
	if strings.Contains(string(payload), "fixture-key") || strings.Contains(string(payload), "enc:v2:") {
		t.Fatal("snapshot exposed credentials")
	}
	if _, err := r.ConsumeReset(ctx, q.ScopeID, "WEEK", "id", nil); err == nil {
		t.Fatal("quota-only key allowed reset")
	}
	setProtectedLogin(t, r, "second")
	requireUnbound()
	if calls.Load() != 3 {
		t.Fatalf("unexpected requests after account switch: %d", calls.Load())
	}
	if err := r.UnbindQuotaKey(); err != nil {
		t.Fatal(err)
	}
	setProtectedLogin(t, r, "first")
	requireUnbound()
}

func TestProtectedQuotaAccountSwitchDuringRequest(t *testing.T) {
	for _, action := range []string{"bind", "read"} {
		t.Run(action, func(t *testing.T) {
			var switchLogin atomic.Bool
			var r *QuotaReader
			r = quotaFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				if switchLogin.Load() {
					setProtectedLogin(t, r, "other")
				}
				w.Write([]byte(boundQuotaResponse))
			})
			r.bindingPath = filepath.Join(t.TempDir(), "binding")
			setProtectedLogin(t, r, "original")
			ctx := context.Background()
			if action == "read" {
				if err := r.BindQuotaKey(ctx, "fixture-key"); err != nil {
					t.Fatal(err)
				}
			}
			switchLogin.Store(true)
			var err error
			if action == "read" {
				var q *QuotaSnapshot
				q, err = r.Read(ctx)
				if q != nil {
					t.Fatal("returned old account quota")
				}
			} else {
				err = r.BindQuotaKey(ctx, "fixture-key")
				if _, e := os.Stat(r.bindingPath); !os.IsNotExist(e) {
					t.Fatal("stored stale binding")
				}
			}
			if err == nil || err.Error() != "quota_account_changed" {
				t.Fatalf("unexpected result %v", err)
			}
		})
	}
}

func TestUnknownQuotaCipherIsNotPlaintext(t *testing.T) {
	r := &QuotaReader{}
	for _, value := range []string{"enc:v2:protected", "enc:v3:unknown"} {
		if got, err := r.decrypt(value); err == nil || got != "" {
			t.Fatal("unknown cipher treated as plaintext")
		}
	}
}

func TestQuotaBindingRequiresSelectedPersonalPlan(t *testing.T) {
	r := quotaFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected upstream request") })
	r.bindingPath = filepath.Join(t.TempDir(), "binding")
	setProtectedLogin(t, r, "first")
	setting := filepath.Join(r.root, "setting.json")
	data, err := os.ReadFile(setting)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), "individual-coding-plan", "team-coding-plan", 1))
	if err := os.WriteFile(setting, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.BindQuotaKey(context.Background(), "fixture-key"); err == nil {
		t.Fatal("bound a team plan")
	}
	q, err := r.Read(context.Background())
	if err != nil || q.Status != "unsupported" || q.BindingRequired {
		t.Fatal("unexpected team plan response")
	}
}
