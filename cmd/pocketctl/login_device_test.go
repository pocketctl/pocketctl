package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/pocketctl/pocketctl/internal/api"
	"github.com/pocketctl/pocketctl/internal/i18n"
)

func TestDeviceAuthorizationCountdownExpires(t *testing.T) {
	for _, mode := range []string{"authorization_pending", "slow_down", "network_error", "blocked"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				start := time.Now()
				var out bytes.Buffer
				// The poll closure runs on its own goroutine inside
				// waitForDeviceAuthorization; count atomically.
				var calls atomic.Int32
				_, _, err := waitForDeviceAuthorization(start.Add(12*time.Second), 5*time.Second, &out, func(ctx context.Context) (*api.DeviceTokenResponse, error) {
					calls.Add(1)
					if mode == "blocked" {
						<-ctx.Done()
						return nil, ctx.Err()
					}
					if mode == "network_error" {
						return nil, errors.New("offline")
					}
					return &api.DeviceTokenResponse{Error: mode}, nil
				})
				if err == nil || err.Error() != i18n.T("login.auth_timeout") {
					t.Fatalf("expected timeout, got %v", err)
				}
				if time.Since(start) != 12*time.Second {
					t.Fatalf("exit after %v", time.Since(start))
				}
				for remaining := 12; remaining >= 0; remaining-- {
					if !strings.Contains(out.String(), i18n.T("login.waiting_auth", remaining)) {
						t.Fatalf("missing countdown %d: %q", remaining, out.String())
					}
				}
				wantCalls := int32(2)
				if mode == "blocked" || mode == "slow_down" {
					wantCalls = 1
				}
				if got := calls.Load(); got != wantCalls {
					t.Fatalf("poll calls = %d, want %d", got, wantCalls)
				}
			})
		})
	}
}

func TestDeviceAuthorizationSuccess(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		var out bytes.Buffer
		access, refresh, err := waitForDeviceAuthorization(start.Add(time.Minute), 5*time.Second, &out, func(context.Context) (*api.DeviceTokenResponse, error) {
			return &api.DeviceTokenResponse{AccessToken: "access", RefreshToken: "refresh"}, nil
		})
		if err != nil || access != "access" || refresh != "refresh" {
			t.Fatalf("result: %q %q %v", access, refresh, err)
		}
		if time.Since(start) != 5*time.Second {
			t.Fatalf("success after %v", time.Since(start))
		}
	})
}
