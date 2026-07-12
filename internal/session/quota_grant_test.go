package session

import (
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestQuotaGrantValidator(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	validator := NewQuotaGrantValidator()
	grant := &protocol.QuotaGrant{
		ReservationID: "reservation-1",
		ExpiresAt:     now.Add(20 * time.Second).UnixMilli(),
		Operation:     "create",
	}

	duplicate, err := validator.Validate("request-1", grant, "create", now)
	if err != nil || duplicate {
		t.Fatalf("first valid grant: duplicate=%v err=%v", duplicate, err)
	}
	duplicate, err = validator.Validate("request-1", grant, "create", now.Add(time.Second))
	if err != nil || !duplicate {
		t.Fatalf("duplicate grant: duplicate=%v err=%v", duplicate, err)
	}
}

func TestQuotaGrantValidatorRejectsInvalidGrants(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		requestID string
		grant     *protocol.QuotaGrant
		operation string
	}{
		{name: "missing request", grant: &protocol.QuotaGrant{ReservationID: "r", ExpiresAt: now.Add(time.Second).UnixMilli(), Operation: "create"}, operation: "create"},
		{name: "missing grant", requestID: "q", operation: "create"},
		{name: "missing reservation", requestID: "q", grant: &protocol.QuotaGrant{ExpiresAt: now.Add(time.Second).UnixMilli(), Operation: "create"}, operation: "create"},
		{name: "expired beyond skew", requestID: "q", grant: &protocol.QuotaGrant{ReservationID: "r", ExpiresAt: now.Add(-6 * time.Second).UnixMilli(), Operation: "create"}, operation: "create"},
		{name: "wrong operation", requestID: "q", grant: &protocol.QuotaGrant{ReservationID: "r", ExpiresAt: now.Add(time.Second).UnixMilli(), Operation: "resume"}, operation: "create"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewQuotaGrantValidator()
			if _, err := validator.Validate(tt.requestID, tt.grant, tt.operation, now); err == nil {
				t.Fatal("expected invalid grant error")
			}
		})
	}
}

func TestQuotaGrantValidatorRejectsGrantAtExpiry(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	validator := NewQuotaGrantValidator()
	grant := &protocol.QuotaGrant{
		ReservationID: "reservation-expired",
		ExpiresAt:     now.UnixMilli(),
		Operation:     "create",
	}

	if _, err := validator.Validate("request-expired", grant, "create", now); err == nil {
		t.Fatal("expected grant at expiry to be rejected")
	}
}
