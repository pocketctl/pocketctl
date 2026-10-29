package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/api"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/i18n"
	"github.com/pocketctl/pocketctl/internal/ws"
)

// Never reuse a rotated credential after a failed save. Reconnection remains
// paused until the operator repairs storage and reloads credentials.
func refreshDaemonToken(ctx context.Context, machineID string,
	load func() (string, string, string, error),
	refresh func(context.Context, string, string, string) (string, string, error),
	save func(string, string, string) error,
) (string, error) {
	relayURL, _, refreshToken, err := load()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ws.ErrRefreshLoginRequired
		}
		return "", ws.ErrRefreshStorageUnavailable
	}
	if refreshToken == "" {
		return "", ws.ErrRefreshLoginRequired
	}
	baseURL := strings.TrimSuffix(strings.TrimSuffix(relayURL, "/"), "/ws")
	baseURL = strings.Replace(baseURL, "wss://", "https://", 1)
	baseURL = strings.Replace(baseURL, "ws://", "http://", 1)
	access, rotated, err := refresh(ctx, baseURL, refreshToken, machineID)
	if err != nil {
		if errors.Is(err, api.ErrRefreshRejected) {
			return "", ws.ErrRefreshLoginRequired
		}
		return "", err
	}
	if access == "" || rotated == "" {
		return "", fmt.Errorf("incomplete refresh response")
	}
	// Once rotation succeeds, attempt the durable save even during shutdown.
	// Cancellation must not discard the only copy of the newly issued pair.
	for attempt := 0; attempt < 3; attempt++ {
		if err := save(relayURL, access, rotated); err == nil {
			return access, nil
		}
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Duration(attempt+1) * 100 * time.Millisecond):
			}
		}
	}
	return "", ws.ErrRefreshPersistenceFailed
}

func renderDaemonAuthNotice(out io.Writer, state daemon.DaemonState) {
	key := ""
	recovery := false
	switch {
	case state.ConnectionStatus == string(ws.ConnectionLoginRequired):
		key = "status.auth_login_notice"
		recovery = true
	case state.ConnectionStatus == string(ws.ConnectionStopped):
		switch state.ConnectionReason {
		case "auth_storage_unavailable":
			key = "status.auth_storage_notice"
			recovery = true
		case "auth_persistence_failed":
			key = "status.auth_save_notice"
			recovery = true
		case "auth_refresh_unavailable":
			key = "status.auth_unavailable_notice"
			recovery = true
		}
	case state.ConnectionStatus == string(ws.ConnectionAuthUncertain):
		key = "status.auth_retry_notice"
	}
	if key != "" {
		fmt.Fprintln(out, i18n.T(key))
	}
	if recovery {
		fmt.Fprintln(out, i18n.T("status.auth_recovery"))
	}
}
