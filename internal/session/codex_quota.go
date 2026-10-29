package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"sort"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// Deliberately excludes raw account IDs, credit balances, upsell and auth data.
type CodexQuotaSnapshot struct {
	Kind       string             `json:"kind"`
	ScopeID    string             `json:"scope_id"`
	ObservedAt string             `json:"observed_at"`
	Exhausted  bool               `json:"exhausted"`
	Buckets    []CodexQuotaBucket `json:"buckets"`
}
type CodexQuotaBucket struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
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
	LimitID             string                  `json:"limitId"`
	LimitName           string                  `json:"limitName"`
	Primary             *codexNativeQuotaWindow `json:"primary"`
	Secondary           *codexNativeQuotaWindow `json:"secondary"`
	SpendControlReached *bool                   `json:"spendControlReached"`
}

// A read never resumes a thread, configures skills or starts a turn. Terminal and
// project managed sessions both use their actual coordinator's authenticated RPC.
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
		return nil, errors.New("Codex runtime disconnected")
	}
	revision := b.coord.quotaRevision.Load()
	var raw struct {
		AccountID            string                            `json:"accountId"`
		OrdinaryUsageAllowed *bool                             `json:"ordinaryUsageAllowed"`
		RateLimits           codexNativeQuotaBucket            `json:"rateLimits"`
		RateLimitsByLimitID  map[string]codexNativeQuotaBucket `json:"rateLimitsByLimitId"`
	}
	if err := client.Call(ctx, "account/rateLimits/read", map[string]any{}, &raw); err != nil {
		return nil, errors.New("Codex quota unavailable")
	}
	sm.mu.RLock()
	current := sm.sessions[id]
	sameBackend := current != nil && current.Backend == b
	sm.mu.RUnlock()
	if !sameBackend {
		return nil, errors.New("Codex session runtime changed; refresh required")
	}
	_, currentGeneration, currentOK := b.coord.backendClient()
	if !currentOK || currentGeneration != generation || revision != b.coord.quotaRevision.Load() {
		return nil, errors.New("Codex account or quota changed; refresh required")
	}
	scope := sha256.Sum256([]byte(b.coord.codexHomeID + "\x00" + raw.AccountID))
	result := &CodexQuotaSnapshot{Kind: "codex_rate_limits", ScopeID: hex.EncodeToString(scope[:16]), ObservedAt: time.Now().UTC().Format(time.RFC3339), Exhausted: raw.OrdinaryUsageAllowed != nil && !*raw.OrdinaryUsageAllowed, Buckets: []CodexQuotaBucket{}}
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
		bucket := CodexQuotaBucket{ID: key, Name: native.LimitName, Exhausted: native.SpendControlReached != nil && *native.SpendControlReached, Windows: []CodexQuotaWindow{}}
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
			if w.ResetsAt != nil && (*w.ResetsAt <= 0 || *w.ResetsAt > 253402300799) {
				w.ResetsAt = nil
			}
			bucket.Windows = append(bucket.Windows, CodexQuotaWindow{100 - *w.UsedPercent, w.WindowDurationMins, w.ResetsAt})
		}
		if len(bucket.Windows) > 0 || bucket.Exhausted {
			result.Buckets = append(result.Buckets, bucket)
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
