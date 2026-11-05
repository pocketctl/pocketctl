package session

import (
	"context"
	"errors"
	"fmt"
	"github.com/pocketctl/pocketctl/internal/quotareset"
	"strings"
)

// Conservative floor verified against the locally generated 0.166.0 protocol.
func codexResetVersionSupported(version string) bool {
	var major, minor, patch int
	version = strings.TrimPrefix(strings.TrimPrefix(version, "codex-cli "), "v")
	if _, e := fmt.Sscanf(version, "%d.%d.%d", &major, &minor, &patch); e != nil {
		return false
	}
	return major > 0 || minor >= 166
}
func consumeCodexQuota(ctx context.Context, client codexQuotaCaller, home, scope, key string, store *quotareset.Store, guards ...func() bool) (*quotareset.Result, error) {
	fresh, err := readCodexQuota(ctx, client, home)
	if err != nil {
		return nil, err
	}
	if fresh.Status != "ok" || fresh.ScopeID != scope {
		return nil, errors.New("quota_account_changed")
	}
	return store.Do(ctx, scope, key, "codex", true, func() (string, error) {
		for _, guard := range guards {
			if !guard() {
				return "", errors.New("quota_account_changed")
			}
		}
		var result struct {
			Outcome string `json:"outcome"`
		}
		if err := client.Call(ctx, "account/rateLimitResetCredit/consume", map[string]any{"idempotencyKey": key}, &result); err != nil {
			return "", errors.New("quota_reset_unknown")
		}
		switch result.Outcome {
		case "reset", "alreadyRedeemed", "nothingToReset", "noCredit":
			return result.Outcome, nil
		}
		return "", errors.New("quota_reset_unknown")
	})
}
func (sm *SessionManager) ConsumeCodexReset(ctx context.Context, home, scope, key string, store *quotareset.Store) (*quotareset.Result, error) {
	p := sm.CodexRuntimeProvider()
	coord, profile, err := p.coordinatorForHomeID(home)
	if err != nil {
		return nil, errors.New("quota_credentials_unavailable")
	}
	if !p.quotaMu.TryLock() {
		return nil, errors.New("busy")
	}
	defer p.quotaMu.Unlock()
	stamp, stampErr := codexQuotaAuthStamp(profile.Home)
	if stampErr != nil {
		return nil, errors.New("quota_credentials_unavailable")
	}
	revision := coord.quotaRevision.Load()
	validStamp := func() bool {
		after, e := codexQuotaAuthStamp(profile.Home)
		return e == nil && after == stamp && coord.quotaRevision.Load() == revision
	}
	var result *quotareset.Result
	if client, generation, ok := coord.backendClient(); ok {
		coord.mu.Lock()
		version := coord.version
		coord.mu.Unlock()
		if !codexResetVersionSupported(version) {
			return nil, errors.New("quota_reset_unsupported")
		}
		result, err = consumeCodexQuota(ctx, client, profile.ID, scope, key, store, func() bool {
			_, next, online := coord.backendClient()
			return online && next == generation && validStamp()
		})
	} else {
		binary, version, e := p.resolve()
		if e != nil || !codexResetVersionSupported(version) {
			return nil, errors.New("quota_reset_unsupported")
		}
		err = withCodexQuotaProcess(ctx, binary, profile.Home, func(client codexQuotaCaller) error {
			var e error
			result, e = consumeCodexQuota(ctx, client, profile.ID, scope, key, store, validStamp)
			return e
		})
	}
	delete(p.quotaCache, profile.ID)
	coord.invalidateQuota(false)
	return result, err
}
