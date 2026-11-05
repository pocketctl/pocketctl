package zcode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/pocketctl/pocketctl/internal/quotareset"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const resetAPI = "https://zcode.z.ai/api/v1/coding-plan/reset"

type ResetCard struct {
	ResetType      string  `json:"reset_type"`
	AvailableCount int     `json:"available_count"`
	ExpiresAt      []int64 `json:"expires_at"`
}
type ResetCards struct {
	Status string      `json:"status"`
	Cards  []ResetCard `json:"cards"`
}

func (r *QuotaReader) resetCredentialStamp() (string, error) {
	hash := sha256.New()
	for _, name := range []string{"setting.json", "credentials.json"} {
		f, e := os.Open(filepath.Join(r.root, name))
		if e != nil {
			return "", errors.New("quota_credentials_unavailable")
		}
		raw, e := io.ReadAll(io.LimitReader(f, 2*1024*1024+1))
		f.Close()
		if e != nil || len(raw) > 2*1024*1024 {
			return "", errors.New("quota_credentials_unavailable")
		}
		hash.Write([]byte(name + "\x00"))
		hash.Write(raw)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func (r *QuotaReader) resetAuth(c quotaCredential) (string, string, error) {
	z, m, _, e := r.resetAuthSnapshot(c)
	return z, m, e
}
func (r *QuotaReader) resetAuthSnapshot(c quotaCredential) (string, string, string, error) {
	stamp, e := r.resetCredentialStamp()
	if e != nil {
		return "", "", "", e
	}
	current, e := r.credential()
	if e != nil || current.status != "ok" || current.scope != c.scope {
		return "", "", "", errors.New("quota_account_changed")
	}
	var creds map[string]string
	if quotaJSON(filepath.Join(r.root, "credentials.json"), &creds) != nil {
		return "", "", "", errors.New("quota_credentials_unavailable")
	}
	z, e1 := r.decrypt(creds["zcodejwttoken"])
	m, e2 := r.decrypt(creds["oauth:bigmodel:access_token"])
	if e1 != nil || e2 != nil || z == "" || m == "" || strings.ContainsAny(z+m, "\r\n") || len(z+m) > 32768 {
		return "", "", "", errors.New("quota_authentication_required")
	}
	after, e := r.resetCredentialStamp()
	if e != nil || after != stamp {
		return "", "", "", errors.New("quota_account_changed")
	}
	if !strings.HasPrefix(strings.ToLower(z), "bearer ") {
		z = "Bearer " + z
	}
	return z, m, stamp, nil
}
func (r *QuotaReader) resetRequest(ctx context.Context, c quotaCredential, method, path string, body any, target any) error {
	z, m, stamp, e := r.resetAuthSnapshot(c)
	if e != nil {
		return e
	}
	endpoint := r.resetEndpoint
	if endpoint == "" {
		endpoint = resetAPI
	}
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	req, e := http.NewRequestWithContext(ctx, method, endpoint+path, bytes.NewReader(data))
	if e != nil {
		return errors.New("quota_unavailable")
	}
	req.Header.Set("Authorization", z)
	req.Header.Set("X-Bigmodel-Authorization", m)
	req.Header.Set("Bigmodel-Target-Type", "PERSONAL")
	req.Header.Set("Content-Type", "application/json")
	// Always prohibit redirects, including test-injected HTTP clients.
	client := *r.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if after, err := r.resetCredentialStamp(); err != nil || after != stamp {
		return errors.New("quota_account_changed")
	}
	resp, e := client.Do(req)
	if e != nil {
		return errors.New("quota_unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return errors.New("quota_authentication_required")
	}
	if resp.StatusCode != 200 {
		return errors.New("quota_unavailable")
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 512*1024+1))
	if e != nil || len(raw) > 512*1024 {
		return errors.New("quota_unavailable")
	}
	var envelope struct {
		Code *int            `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &envelope) != nil || envelope.Code == nil || *envelope.Code != 0 {
		return errors.New("quota_unavailable")
	}
	if json.Unmarshal(envelope.Data, target) != nil {
		return errors.New("quota_unavailable")
	}
	return nil
}
func (r *QuotaReader) readResetCards(ctx context.Context, c quotaCredential) *ResetCards {
	result := &ResetCards{Status: "unavailable"}
	var raw struct {
		Five *[]struct {
			ExpireAt int64 `json:"expire_at"`
		} `json:"available_five_hour_resets"`
		Week *[]struct {
			ExpireAt int64 `json:"expire_at"`
		} `json:"available_week_resets"`
	}
	if e := r.resetRequest(ctx, c, "GET", "/status", nil, &raw); e != nil {
		if e.Error() == "quota_authentication_required" {
			result.Status = "authentication_required"
		}
		return result
	}
	if raw.Five == nil || raw.Week == nil || len(*raw.Five) > 10000 || len(*raw.Week) > 10000 {
		return result
	}
	result.Status = "ok"
	result.Cards = []ResetCard{}
	for i, rows := range [][]struct {
		ExpireAt int64 `json:"expire_at"`
	}{*raw.Five, *raw.Week} {
		card := ResetCard{ResetType: []string{"FIVE_HOUR", "WEEK"}[i], ExpiresAt: []int64{}}
		for _, row := range rows {
			stamp := row.ExpireAt / 1000
			if row.ExpireAt <= 0 || stamp > 253402300799 {
				result.Status = "unavailable"
				result.Cards = nil
				return result
			}
			if stamp <= time.Now().Unix() {
				continue
			}
			if stamp > 253402300799 {
				result.Status = "unavailable"
				result.Cards = nil
				return result
			}
			card.AvailableCount++
			if len(card.ExpiresAt) < 64 {
				card.ExpiresAt = append(card.ExpiresAt, stamp)
			}
		}
		result.Cards = append(result.Cards, card)
	}
	return result
}
func (r *QuotaReader) ConsumeReset(ctx context.Context, scope, kind, key string, store *quotareset.Store) (*quotareset.Result, error) {
	if kind != "FIVE_HOUR" && kind != "WEEK" {
		return nil, errors.New("invalid_request")
	}
	c, e := r.credential()
	if e != nil || c.status != "ok" || c.scope != scope {
		return nil, errors.New("quota_account_changed")
	}
	if _, _, e = r.resetAuth(c); e != nil {
		return nil, e
	}
	r.mu.Lock()
	r.cached = nil
	r.resetRevision++
	r.mu.Unlock()
	result, e := store.Do(ctx, scope, key, kind, false, func() (string, error) {
		var raw struct {
			Used bool `json:"used"`
		}
		e := r.resetRequest(ctx, c, "POST", "/use", map[string]string{"idempotency_key": key, "reset_type": kind}, &raw)
		if e != nil || !raw.Used {
			return "", errors.New("quota_reset_unknown")
		}
		return "reset", nil
	})
	r.mu.Lock()
	r.cached = nil
	r.resetRevision++
	r.mu.Unlock()
	return result, e
}
