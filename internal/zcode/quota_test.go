package zcode

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func quotaFixture(t *testing.T, handler http.HandlerFunc) *QuotaReader {
	t.Helper()
	root := t.TempDir()
	write := func(name string, v any) {
		b, _ := json.Marshal(v)
		if err := os.WriteFile(filepath.Join(root, name), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("setting.json", map[string]any{"providerFamilyDomain": "bigmodel", "modelProviderFamilyModes": map[string]string{"bigmodel": "oauth"}, "modelProviderFamilySelectedKeys": map[string]string{"bigmodel": "coding-plan:builtin:bigmodel-coding-plan"}, "providerFamilyConnectionSelections": map[string]any{"bigmodel": map[string]string{"kind": "individual-coding-plan"}}})
	write("credentials.json", map[string]string{"oauth:active_provider": "bigmodel", "oauth:bigmodel:user_info": `{"id":"current"}`, "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:current:api-key": "current-key", "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:old:api-key": "wrong-key"})
	s := httptest.NewServer(handler)
	t.Cleanup(s.Close)
	return &QuotaReader{root: root, secret: "test-secret", client: s.Client(), endpoint: s.URL}
}

func TestZcodeQuotaUsesCurrentAccountAndBothWindows(t *testing.T) {
	r := quotaFixture(t, func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "GET" || req.Header.Get("Authorization") != "current-key" {
			t.Error("wrong credential or method")
		}
		w.Write([]byte(`{"code":200,"success":true,"data":{"level":"max","limits":[{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":48,"nextResetTime":1793610271971},{"type":"TIME_LIMIT","unit":5,"number":1,"percentage":2},{"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":85,"nextResetTime":1793360394095}]}}`))
	})
	got, err := r.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "ok" || got.Level != "max" || len(got.Windows) != 2 || got.Windows[0].ID != "five_hour" || *got.Windows[0].RemainingPercent != 15 || got.Windows[1].ID != "week" || *got.Windows[1].RemainingPercent != 52 || *got.Windows[0].ResetsAt != 1793360394 {
		t.Fatalf("bad snapshot: %+v", got)
	}
	b, _ := json.Marshal(got)
	for _, secret := range []string{"current-key", "wrong-key", "current\"", "Authorization"} {
		if strings.Contains(string(b), secret) {
			t.Fatal("private data leaked")
		}
	}
}

func TestZcodeQuotaRejectsBusinessErrorsAndDoesNotFollowRedirects(t *testing.T) {
	for _, body := range []string{`{"code":401,"success":false,"msg":"secret upstream detail"}`, `{"code":200,"success":false}`, `{`} {
		t.Run(body, func(t *testing.T) {
			r := quotaFixture(t, func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(body)) })
			got, err := r.Read(context.Background())
			if err == nil || got != nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unsafe success/error: %v %v", got, err)
			}
		})
	}
	var leaks atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { leaks.Add(1) }))
	defer target.Close()
	r := quotaFixture(t, func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, target.URL, http.StatusTemporaryRedirect)
	})
	r.client = quotaHTTPClient()
	if _, err := r.Read(context.Background()); err == nil || leaks.Load() != 0 {
		t.Fatal("followed redirect")
	}
}

func TestZcodeQuotaUnknownWindowIsNeverZero(t *testing.T) {
	r := quotaFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"code":200,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":100},{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":101}]}}`))
	})
	got, err := r.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Windows) != 2 || got.Windows[0].RemainingPercent == nil || *got.Windows[0].RemainingPercent != 0 || got.Windows[1].RemainingPercent != nil {
		t.Fatalf("unknown treated as known: %+v", got.Windows)
	}
}

func TestZcodeQuotaDiscardsReadAfterAccountSwitch(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	r := quotaFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.Write([]byte(`{"code":200,"data":{"limits":[]}}`))
	})
	done := make(chan error, 1)
	go func() { _, err := r.Read(context.Background()); done <- err }()
	<-started
	os.WriteFile(filepath.Join(r.root, "credentials.json"), []byte(`{"oauth:active_provider":"bigmodel","oauth:bigmodel:user_info":"{\"id\":\"other\"}"}`), 0600)
	close(release)
	if err := <-done; err == nil || err.Error() != "quota_account_changed" {
		t.Fatalf("old account accepted: %v", err)
	}
}

func TestZcodeQuotaCoalescesAndDecryptsCurrentCredential(t *testing.T) {
	var reads atomic.Int32
	r := quotaFixture(t, func(w http.ResponseWriter, req *http.Request) {
		reads.Add(1)
		if req.Header.Get("Authorization") != "current-key" {
			t.Error("decryption failed")
		}
		time.Sleep(30 * time.Millisecond)
		w.Write([]byte(`{"code":200,"data":{"limits":[]}}`))
	})
	p := filepath.Join(r.root, "credentials.json")
	var v map[string]string
	b, _ := os.ReadFile(p)
	json.Unmarshal(b, &v)
	key := sha256.Sum256([]byte(r.secret))
	block, _ := aes.NewCipher(key[:])
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	sealed := gcm.Seal(nil, nonce, []byte("current-key"), nil)
	enc := base64.RawURLEncoding.EncodeToString
	v["account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:current:api-key"] = "enc:v1:" + enc(nonce) + "." + enc(sealed[len(sealed)-gcm.Overhead():]) + "." + enc(sealed[:len(sealed)-gcm.Overhead()])
	b, _ = json.Marshal(v)
	os.WriteFile(p, b, 0600)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := r.Read(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if reads.Load() != 1 {
		t.Fatalf("expected one upstream read, got %d", reads.Load())
	}
}

func TestZcodeQuotaDoesNotFallBackToAnotherStoredAccount(t *testing.T) {
	var reads atomic.Int32
	r := quotaFixture(t, func(http.ResponseWriter, *http.Request) { reads.Add(1) })
	os.WriteFile(filepath.Join(r.root, "credentials.json"), []byte(`{"oauth:active_provider":"bigmodel","oauth:bigmodel:user_info":"{\"id\":\"missing\"}","account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:old:api-key":"wrong-key"}`), 0600)
	got, err := r.Read(context.Background())
	if err != nil || got.Status != "not_configured" || reads.Load() != 0 {
		t.Fatalf("wrong account queried: %v %v", got, err)
	}
}

// Explicitly opt in: this only queries the signed-in local account, never turns
// or reset operations. Normal test runs remain offline and deterministic.
func TestZcodeQuotaLiveLocal(t *testing.T) {
	if os.Getenv("POCKETCTL_TEST_LIVE_ZCODE_QUOTA") != "1" {
		t.Skip("local account smoke check is opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	got, err := NewQuotaReader().Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "ok" {
		t.Fatalf("quota status: %s", got.Status)
	}
	for _, window := range got.Windows {
		if window.RemainingPercent == nil {
			t.Fatalf("window %s unavailable", window.ID)
		}
		t.Logf("%s remaining=%.1f%%", window.ID, *window.RemainingPercent)
	}
}
