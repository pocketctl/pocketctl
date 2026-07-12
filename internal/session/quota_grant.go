package session

import (
	"fmt"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

const quotaGrantSeenTTL = 10 * time.Minute

type quotaGrantSeen struct {
	reservationID string
	operation     string
	seenAt        time.Time
}

type QuotaGrantValidator struct {
	mu   sync.Mutex
	seen map[string]quotaGrantSeen
}

func NewQuotaGrantValidator() *QuotaGrantValidator {
	return &QuotaGrantValidator{seen: make(map[string]quotaGrantSeen)}
}

// Validate checks a Relay-delivered grant and records its request id. The
// authenticated Relay→daemon WebSocket is the trust boundary; the grant closes
// accidental/legacy bypasses and supplies idempotency, not a second signature.
func (v *QuotaGrantValidator) Validate(requestID string, grant *protocol.QuotaGrant, operation string, now time.Time) (duplicate bool, err error) {
	if requestID == "" {
		return false, fmt.Errorf("quota grant request_id is required")
	}
	if grant == nil || grant.ReservationID == "" {
		return false, fmt.Errorf("quota grant reservation_id is required")
	}
	if grant.Operation != operation {
		return false, fmt.Errorf("quota grant operation %q does not match %q", grant.Operation, operation)
	}
	if !time.UnixMilli(grant.ExpiresAt).After(now) {
		return false, fmt.Errorf("quota grant expired")
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	for id, item := range v.seen {
		if now.Sub(item.seenAt) > quotaGrantSeenTTL {
			delete(v.seen, id)
		}
	}
	if item, ok := v.seen[requestID]; ok {
		if item.reservationID != grant.ReservationID || item.operation != operation {
			return false, fmt.Errorf("request_id already used by another quota grant")
		}
		return true, nil
	}
	v.seen[requestID] = quotaGrantSeen{reservationID: grant.ReservationID, operation: operation, seenAt: now}
	return false, nil
}
