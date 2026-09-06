package main

import (
	"context"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/api"
	"github.com/pocketctl/pocketctl/internal/i18n"
)

// waitForDeviceAuthorization keeps the display and expiry independent of network polling.
func waitForDeviceAuthorization(deadline time.Time, interval time.Duration, out io.Writer, poll func(context.Context) (*api.DeviceTokenResponse, error)) (string, string, error) {
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	nextPoll := time.NewTimer(interval)
	defer nextPoll.Stop()
	previousWidth := 0
	render := func(remaining int) {
		line := i18n.T("login.waiting_auth", remaining)
		padding := max(0, previousWidth-len(line))
		fmt.Fprint(out, line, strings.Repeat(" ", padding))
		previousWidth = len(line)
	}
	timeout := func() (string, string, error) {
		render(0)
		return "", "", fmt.Errorf("%s", i18n.T("login.auth_timeout"))
	}
	type response struct {
		token *api.DeviceTokenResponse
		err   error
	}
	results := make(chan response, 1)
	for {
		if !time.Now().Before(deadline) {
			return timeout()
		}
		render(int(math.Ceil(time.Until(deadline).Seconds())))
		select {
		case <-ctx.Done():
			return timeout()
		case <-tick.C:
		case <-nextPoll.C:
			go func() {
				token, err := poll(ctx)
				results <- response{token, err}
			}()
		case result := <-results:
			if !time.Now().Before(deadline) {
				return timeout()
			}
			if result.err == nil {
				switch result.token.Error {
				case "":
					if result.token.AccessToken != "" {
						fmt.Fprintln(out, i18n.T("login.auth_ok"))
						return result.token.AccessToken, result.token.RefreshToken, nil
					}
				case "authorization_pending":
				case "slow_down":
					interval += 5 * time.Second
				case "expired_token":
					return timeout()
				default:
					return "", "", fmt.Errorf("%s", i18n.T("login.auth_failed", result.token.Error))
				}
			}
			nextPoll.Reset(interval)
		}
	}
}
