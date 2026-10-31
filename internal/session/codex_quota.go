package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Account usage is private transient metadata, never conversation history.
type CodexQuotaSnapshot struct {
	Kind         string             `json:"kind"`
	ScopeID      string             `json:"scope_id"`
	ObservedAt   string             `json:"observed_at"`
	Status       string             `json:"status"`
	PlanType     string             `json:"plan_type"`
	Exhausted    bool               `json:"exhausted"`
	Buckets      []CodexQuotaBucket `json:"buckets"`
	ResetCredits *CodexResetCredits `json:"reset_credits"`
}
type CodexResetCredits struct {
	AvailableCount int64              `json:"available_count"`
	Credits        []CodexResetCredit `json:"credits"`
}
type CodexResetCredit struct {
	ExpiresAt *int64 `json:"expires_at"`
}
type CodexQuotaBucket struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	PlanType  string             `json:"plan_type"`
	Exhausted bool               `json:"exhausted"`
	Windows   []CodexQuotaWindow `json:"windows"`
}
type CodexQuotaWindow struct {
	RemainingPercent float64 `json:"remaining_percent"`
	DurationMinutes  *int64  `json:"duration_minutes"`
	ResetsAt         *int64  `json:"resets_at"`
}
type codexNativeQuotaWindow struct {
	UsedPercent        *float64 `json:"usedPercent"`
	WindowDurationMins *int64   `json:"windowDurationMins"`
	ResetsAt           *int64   `json:"resetsAt"`
}
type codexNativeQuotaBucket struct {
	LimitID              string                  `json:"limitId"`
	LimitName            string                  `json:"limitName"`
	PlanType             string                  `json:"planType"`
	Primary              *codexNativeQuotaWindow `json:"primary"`
	Secondary            *codexNativeQuotaWindow `json:"secondary"`
	SpendControlReached  *bool                   `json:"spendControlReached"`
	RateLimitReachedType string                  `json:"rateLimitReachedType"`
}
type codexQuotaCaller interface {
	Call(context.Context, string, any, any) error
}

// Reads the actual session runtime, without resuming a thread or starting a turn.
func (sm *SessionManager) ReadCodexRateLimits(ctx context.Context, id string) (*CodexQuotaSnapshot, error) {
	sm.mu.RLock()
	ps := sm.sessions[id]
	var b *CodexAppServerBackend
	if ps != nil && ps.Agent == adapter.AgentCodex {
		b, _ = ps.Backend.(*CodexAppServerBackend)
	}
	sm.mu.RUnlock()
	if b == nil {
		return nil, ErrCodexInvocationsUnsupported
	}
	client, generation, ok := b.coord.backendClient()
	if !ok {
		return nil, errors.New("quota_unavailable")
	}
	revision := b.coord.quotaRevision.Load()
	result, err := readCodexQuota(ctx, client, b.coord.codexHomeID)
	if err != nil {
		return nil, err
	}
	sm.mu.RLock()
	current := sm.sessions[id]
	same := current != nil && current.Backend == b
	sm.mu.RUnlock()
	_, nextGeneration, currentOK := b.coord.backendClient()
	if !same || !currentOK || nextGeneration != generation || revision != b.coord.quotaRevision.Load() {
		return nil, errors.New("quota_account_changed")
	}
	return result, nil
}

func quotaPlan(value string) string {
	switch value {
	case "free", "go", "plus", "pro", "prolite", "promax", "team", "self_serve_business_prolite", "self_serve_business_usage_based", "business", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise", "edu", "edu_plus", "edu_pro", "sci", "sci_plus":
		return value
	default:
		return "unknown"
	}
}
func quotaTimestamp(value *int64) *int64 {
	if value != nil && (*value <= 0 || *value > 253402300799) {
		return nil
	}
	return value
}
func readCodexQuota(ctx context.Context, client codexQuotaCaller, homeID string) (*CodexQuotaSnapshot, error) {
	var before struct {
		Account json.RawMessage `json:"account"`
	}
	if err := client.Call(ctx, "account/read", map[string]any{"refreshToken": false}, &before); err != nil {
		return nil, errors.New("quota_unavailable")
	}
	var account struct {
		Type     string `json:"type"`
		PlanType string `json:"planType"`
	}
	_ = json.Unmarshal(before.Account, &account)
	scope := sha256.Sum256(append([]byte(homeID+"\x00"), before.Account...))
	result := &CodexQuotaSnapshot{Kind: "codex_rate_limits", ScopeID: hex.EncodeToString(scope[:16]), ObservedAt: time.Now().UTC().Format(time.RFC3339), Status: "ok", PlanType: quotaPlan(account.PlanType), Buckets: []CodexQuotaBucket{}}
	if string(before.Account) == "null" {
		result.Status = "unauthenticated"
		return result, nil
	}
	if account.Type != "" && account.Type != "chatgpt" {
		result.Status = "unsupported"
		return result, nil
	}
	var raw struct {
		AccountID            string                            `json:"accountId"`
		OrdinaryUsageAllowed *bool                             `json:"ordinaryUsageAllowed"`
		RateLimits           codexNativeQuotaBucket            `json:"rateLimits"`
		RateLimitsByLimitID  map[string]codexNativeQuotaBucket `json:"rateLimitsByLimitId"`
		ResetCredits         *struct {
			AvailableCount *int64 `json:"availableCount"`
			Credits        *[]struct {
				ID        string `json:"id"`
				ResetType string `json:"resetType"`
				Status    string `json:"status"`
				ExpiresAt *int64 `json:"expiresAt"`
			} `json:"credits"`
		} `json:"rateLimitResetCredits"`
	}
	if err := client.Call(ctx, "account/rateLimits/read", map[string]any{}, &raw); err != nil {
		return nil, errors.New("quota_unavailable")
	}
	var after struct {
		Account json.RawMessage `json:"account"`
	}
	if err := client.Call(ctx, "account/read", map[string]any{"refreshToken": false}, &after); err != nil {
		return nil, errors.New("quota_unavailable")
	}
	if string(before.Account) != string(after.Account) {
		return nil, errors.New("quota_account_changed")
	}
	scope = sha256.Sum256([]byte(homeID + "\x00" + raw.AccountID + "\x00" + string(before.Account)))
	result.ScopeID = hex.EncodeToString(scope[:16])
	result.Exhausted = raw.OrdinaryUsageAllowed != nil && !*raw.OrdinaryUsageAllowed
	if plan := quotaPlan(raw.RateLimits.PlanType); plan != "unknown" {
		result.PlanType = plan
	}
	buckets := raw.RateLimitsByLimitID
	if len(buckets) == 0 {
		id := raw.RateLimits.LimitID
		if id == "" {
			id = "codex"
		}
		buckets = map[string]codexNativeQuotaBucket{id: raw.RateLimits}
	}
	keys := make([]string, 0, len(buckets))
	for key := range buckets {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if len(result.Buckets) >= 32 {
			break
		}
		native := buckets[key]
		if result.PlanType == "unknown" && key == "codex" {
			result.PlanType = quotaPlan(native.PlanType)
		}
		bucket := CodexQuotaBucket{ID: key, Name: native.LimitName, PlanType: quotaPlan(native.PlanType), Exhausted: native.SpendControlReached != nil && *native.SpendControlReached || native.RateLimitReachedType != "", Windows: []CodexQuotaWindow{}}
		if len(bucket.ID) > 128 || len(bucket.Name) > 256 {
			continue
		}
		for _, w := range []*codexNativeQuotaWindow{native.Primary, native.Secondary} {
			if w == nil || w.UsedPercent == nil || math.IsNaN(*w.UsedPercent) || math.IsInf(*w.UsedPercent, 0) || *w.UsedPercent < 0 || *w.UsedPercent > 100 {
				continue
			}
			if w.WindowDurationMins != nil && *w.WindowDurationMins <= 0 {
				w.WindowDurationMins = nil
			}
			bucket.Windows = append(bucket.Windows, CodexQuotaWindow{100 - *w.UsedPercent, w.WindowDurationMins, quotaTimestamp(w.ResetsAt)})
		}
		if len(bucket.Windows) > 0 || bucket.Exhausted {
			result.Buckets = append(result.Buckets, bucket)
		}
	}
	if r := raw.ResetCredits; r != nil && r.AvailableCount != nil && *r.AvailableCount >= 0 && *r.AvailableCount <= 1000000 {
		result.ResetCredits = &CodexResetCredits{AvailableCount: *r.AvailableCount}
		if r.Credits != nil {
			result.ResetCredits.Credits = []CodexResetCredit{}
			seen := map[string]bool{}
			for _, c := range *r.Credits {
				if len(result.ResetCredits.Credits) >= 64 || int64(len(result.ResetCredits.Credits)) >= *r.AvailableCount {
					break
				}
				if c.ID == "" || len(c.ID) > 256 || seen[c.ID] || c.Status != "available" || c.ResetType != "codexRateLimits" {
					continue
				}
				seen[c.ID] = true
				if c.ExpiresAt != nil && quotaTimestamp(c.ExpiresAt) == nil {
					continue
				}
				result.ResetCredits.Credits = append(result.ResetCredits.Credits, CodexResetCredit{ExpiresAt: c.ExpiresAt})
			}
		}
	}
	return result, nil
}

// Sparse native updates invalidate rather than overwrite a complete read. No
// account usage payload enters session history or a team-visible event stream.
func (c *codexCoordinator) invalidateQuota(accountChanged bool) {
	c.quotaRevision.Add(1)
	if c.sm == nil {
		return
	}
	c.sm.mu.RLock()
	select {
	case c.sm.outputCh <- protocol.DaemonEvent{Type: "codex_rate_limits_changed", CodexHomeID: c.codexHomeID, Resync: accountChanged}:
	default:
	}
	ids := []string{}
	for id, ps := range c.sm.sessions {
		if b, ok := ps.Backend.(*CodexAppServerBackend); ok && b.coord == c {
			ids = append(ids, id)
		}
	}
	c.sm.mu.RUnlock()
	for _, id := range ids {
		select {
		case c.sm.outputCh <- protocol.DaemonEvent{Type: "codex_rate_limits_changed", SessionID: id, Resync: accountChanged}:
		default: /* periodic full reads recover dropped invalidations */
		}
	}
}
