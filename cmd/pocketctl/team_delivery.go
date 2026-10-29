package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/teamdelivery"
	"github.com/pocketctl/pocketctl/internal/ws"
)

func startTeamDelivery(ctx context.Context, relayURL, daemonID string, client *ws.Client, sm *session.SessionManager, logger *slog.Logger) error {
	steps, err := teamStepsOptIn(os.Getenv("POCKETCTL_TEAM_STEPS_V1"))
	if err != nil {
		return err
	}
	home, err := config.HomeDir()
	if err != nil {
		return err
	}
	api, err := teamdelivery.NewClient(relayURL, client.AccessToken, client.RelayHTTPClient())
	if err != nil {
		return err
	}
	// Bound the diagnostic dedup cache; never log raw HTTP bodies or paths.
	last := map[string]string{}
	worker, err := teamdelivery.NewWorker(api, filepath.Join(home, ".pocketctl", "team-delivery"), relayURL, daemonID, sm.TeamDeliveryWorkspace, func(callID, code string) {
		if last[callID] == code {
			return
		}
		if len(last) >= 256 {
			clear(last)
		}
		last[callID] = code
		if code == "published" {
			logger.Info("team delivery published", "call_id", callID)
			return
		}
		logger.Debug("team delivery pending", "call_id", callID, "code", code)
	})
	if err != nil {
		return err
	}
	sm.SetTeamStepInputPreparer(func(ctx context.Context, auth *protocol.CollaborationAuthorization, hash, workspace string) error {
		return teamdelivery.MaterializeStepInputs(ctx, api, auth, hash, workspace)
	})
	if !steps || !sm.TeamStepInputsReady() {
		// Also reject late step commands after an opt-out/restart, rather than
		// relying solely on the Relay's next capability refresh.
		sm.SetTeamStepInputPreparer(nil)
	}
	client.SetTeamDeliveryEnabled(true)
	// Without turn enrichment, the legacy Send path omits hidden Context.
	// Never advertise steps unless the frozen input references reach the Agent.
	client.SetTeamStepsEnabled(sm.TeamStepInputsReady())
	daemon.RunLoop(ctx, "team-delivery", logger, func() { worker.Run(ctx) })
	return nil
}

func teamStepsOptIn(value string) (bool, error) {
	switch strings.TrimSpace(value) {
	case "", "off":
		return false, nil
	case "on":
		return true, nil
	default:
		return false, fmt.Errorf("POCKETCTL_TEAM_STEPS_V1 must be off or on")
	}
}
