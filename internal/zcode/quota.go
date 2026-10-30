package zcode

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

const quotaEndpoint = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"

type QuotaWindow struct {
	ID               string   `json:"id"`
	RemainingPercent *float64 `json:"remaining_percent"`
	ResetsAt         *int64   `json:"resets_at"` // Unix seconds, unlike the upstream milliseconds.
}
type QuotaSnapshot struct {
	Kind       string        `json:"kind"`
	ScopeID    string        `json:"scope_id"`
	ObservedAt string        `json:"observed_at"`
	Status     string        `json:"status"`
	Level      string        `json:"level"`
	Windows    []QuotaWindow `json:"windows"`
}
type quotaCredential struct{ key, scope, status string }
type quotaFlight struct {
	done   chan struct{}
	result *QuotaSnapshot
	err    error
}

// QuotaReader only reads local account configuration and a fixed upstream GET.
// It never reads session content, refreshes OAuth tokens, or redeems resets.
type QuotaReader struct {
	root, secret, endpoint string
	client                 *http.Client
	mu                     sync.Mutex
	flights                map[string]*quotaFlight
	cached                 *QuotaSnapshot
}

func quotaHTTPClient() *http.Client {
	return &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func NewQuotaReader() *QuotaReader {
	home, _ := os.UserHomeDir()
	base := home
	if v := os.Getenv("ZCODE_DATA_BASE_DIR"); v != "" {
		base = v
	}
	secret := os.Getenv("ZCODE_CREDENTIAL_SECRET")
	if secret == "" {
		name := "unknown"
		if u, err := user.Current(); err == nil {
			name = u.Username
		}
		secret = "zcode-credential-fallback:" + runtime.GOOS + ":" + home + ":" + name
	}
	return &QuotaReader{root: filepath.Join(base, ".zcode", "v2"), secret: secret, client: quotaHTTPClient(), endpoint: quotaEndpoint}
}

func quotaJSON(path string, target any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 2*1024*1024+1))
	if err != nil || len(b) > 2*1024*1024 {
		return errors.New("quota_credentials_unavailable")
	}
	return json.Unmarshal(b, target)
}

func (r *QuotaReader) decrypt(value string) (string, error) {
	if !strings.HasPrefix(value, "enc:v1:") {
		return value, nil
	}
	parts := strings.Split(strings.TrimPrefix(value, "enc:v1:"), ".")
	bad := errors.New("quota_credentials_unavailable")
	if len(parts) != 3 {
		return "", bad
	}
	iv, e1 := base64.RawURLEncoding.DecodeString(parts[0])
	tag, e2 := base64.RawURLEncoding.DecodeString(parts[1])
	body, e3 := base64.RawURLEncoding.DecodeString(parts[2])
	if e1 != nil || e2 != nil || e3 != nil || len(iv) != 12 || len(tag) != 16 {
		return "", bad
	}
	key := sha256.Sum256([]byte(r.secret))
	block, _ := aes.NewCipher(key[:])
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, iv, append(body, tag...), nil)
	if err != nil {
		return "", bad
	}
	return string(plain), nil
}

func (r *QuotaReader) credential() (quotaCredential, error) {
	c := quotaCredential{status: "not_configured"}
	var setting struct {
		Family      string            `json:"providerFamilyDomain"`
		Modes       map[string]string `json:"modelProviderFamilyModes"`
		Selected    map[string]string `json:"modelProviderFamilySelectedKeys"`
		Connections map[string]struct {
			Kind string `json:"kind"`
		} `json:"providerFamilyConnectionSelections"`
	}
	if err := quotaJSON(filepath.Join(r.root, "setting.json"), &setting); err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return c, errors.New("quota_credentials_unavailable")
	}
	// Unknown/Team/Start/Z.ai configurations must never select a personal key.
	if setting.Family != "bigmodel" || setting.Modes["bigmodel"] != "oauth" || setting.Connections["bigmodel"].Kind != "individual-coding-plan" || setting.Selected["bigmodel"] != "coding-plan:builtin:bigmodel-coding-plan" {
		c.status = "unsupported"
		return c, nil
	}
	var credentials map[string]string
	if err := quotaJSON(filepath.Join(r.root, "credentials.json"), &credentials); err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return c, errors.New("quota_credentials_unavailable")
	}
	active, err := r.decrypt(credentials["oauth:active_provider"])
	if err != nil {
		return c, err
	}
	if active != "bigmodel" {
		return c, nil
	}
	info, err := r.decrypt(credentials["oauth:bigmodel:user_info"])
	if err != nil {
		return c, err
	}
	var account struct {
		ID string `json:"id"`
	}
	if json.Unmarshal([]byte(info), &account) != nil || !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`).MatchString(account.ID) {
		return c, nil
	}
	key, err := r.decrypt(credentials["account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:"+account.ID+":api-key"])
	if err != nil {
		return c, err
	}
	key = strings.TrimSpace(key)
	if key == "" || len(key) > 8192 || strings.ContainsAny(key, "\r\n") {
		return c, nil
	}
	hash := sha256.Sum256([]byte(r.root + "\x00" + account.ID + "\x00" + key))
	return quotaCredential{key: key, scope: hex.EncodeToString(hash[:16]), status: "ok"}, nil
}

func emptyQuota(scope, status string) *QuotaSnapshot {
	return &QuotaSnapshot{Kind: "zcode_quota", ScopeID: scope, Status: status, ObservedAt: time.Now().UTC().Format(time.RFC3339), Windows: []QuotaWindow{{ID: "five_hour"}, {ID: "week"}}}
}

func (r *QuotaReader) Read(ctx context.Context) (*QuotaSnapshot, error) {
	c, err := r.credential()
	if err != nil {
		return nil, err
	}
	if c.status != "ok" {
		return emptyQuota(c.scope, c.status), nil
	}
	r.mu.Lock()
	if r.cached != nil && r.cached.ScopeID == c.scope {
		observed, _ := time.Parse(time.RFC3339, r.cached.ObservedAt)
		if time.Since(observed) < 15*time.Second {
			v := r.cached
			r.mu.Unlock()
			return v, nil
		}
	}
	if f := r.flights[c.scope]; f != nil {
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-f.done:
			return f.result, f.err
		}
	}
	if r.flights == nil {
		r.flights = map[string]*quotaFlight{}
	}
	f := &quotaFlight{done: make(chan struct{})}
	r.flights[c.scope] = f
	r.mu.Unlock()
	result, readErr := r.fetch(ctx, c)
	after, afterErr := r.credential()
	if afterErr != nil || after.status != "ok" || after.scope != c.scope {
		result = nil
		readErr = errors.New("quota_account_changed")
	}
	r.mu.Lock()
	f.result = result
	f.err = readErr
	if readErr == nil {
		r.cached = result
	}
	delete(r.flights, c.scope)
	close(f.done)
	r.mu.Unlock()
	return result, readErr
}

func (r *QuotaReader) fetch(ctx context.Context, c quotaCredential) (*QuotaSnapshot, error) {
	bad := errors.New("quota_unavailable")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.endpoint, nil)
	if err != nil {
		return nil, bad
	}
	req.Header.Set("Authorization", c.key)
	req.Header.Set("Accept-Language", "zh-CN,zh")
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, bad
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, errors.New("quota_authentication_required")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, bad
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024+1))
	if err != nil || len(body) > 512*1024 {
		return nil, bad
	}
	var envelope struct {
		Code    *int  `json:"code"`
		Success *bool `json:"success"`
		Data    *struct {
			Level  string `json:"level"`
			Limits []struct {
				Type          string   `json:"type"`
				Unit          int      `json:"unit"`
				Number        int      `json:"number"`
				Percentage    *float64 `json:"percentage"`
				NextResetTime *float64 `json:"nextResetTime"`
			} `json:"limits"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil || envelope.Code == nil {
		return nil, bad
	}
	if *envelope.Code == 401 || *envelope.Code == 403 {
		return nil, errors.New("quota_authentication_required")
	}
	if (*envelope.Code != 200 && *envelope.Code != 0) || (envelope.Success != nil && !*envelope.Success) || envelope.Data == nil || envelope.Data.Limits == nil || len(envelope.Data.Limits) > 64 {
		return nil, bad
	}
	result := emptyQuota(c.scope, "ok")
	switch strings.ToLower(envelope.Data.Level) {
	case "lite", "pro", "max":
		result.Level = strings.ToLower(envelope.Data.Level)
	}
	seen := map[int]bool{}
	for _, limit := range envelope.Data.Limits {
		if limit.Type != "TOKENS_LIMIT" && limit.Type != "CREDIT_LIMIT" {
			continue
		}
		index := -1
		if limit.Unit == 3 && limit.Number == 5 {
			index = 0
		} else if limit.Unit == 6 && limit.Number == 1 {
			index = 1
		}
		if index < 0 {
			continue
		}
		if seen[index] {
			result.Windows[index] = QuotaWindow{ID: result.Windows[index].ID}
			continue
		}
		seen[index] = true
		p := limit.Percentage
		if p == nil || math.IsNaN(*p) || math.IsInf(*p, 0) || *p < 0 || *p > 100 {
			continue
		}
		remaining := 100 - *p
		result.Windows[index].RemainingPercent = &remaining
		if reset := limit.NextResetTime; reset != nil && *reset > 0 && *reset <= 253402300799000 && math.Trunc(*reset) == *reset {
			seconds := int64(*reset / 1000)
			result.Windows[index].ResetsAt = &seconds
		}
	}
	return result, nil
}
