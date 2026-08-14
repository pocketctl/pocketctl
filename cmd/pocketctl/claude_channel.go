package main

import (
	"log/slog"

	"github.com/pocketctl/pocketctl/internal/claudechannel"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/session"
)

func startClaudeChannelIPC(logger *slog.Logger, sm ...*session.SessionManager) (*claudechannel.Server, error) {
	mcpPath, err := config.ClaudeChannelMCPConfigPath()
	if err != nil {
		return nil, err
	}
	srv := claudechannel.NewServer(config.ClaudeChannelSocketPath(), mcpPath, logger)
	if len(sm) > 0 && sm[0] != nil {
		srv.SetOnRegister(sm[0].HandleClaudeChannelRegister)
		srv.SetOnRequest(sm[0].HandleClaudeChannelRequest)
		srv.SetOnDisconnect(sm[0].HandleClaudeChannelDisconnect)
	}
	if err := srv.Start(); err != nil {
		return nil, err
	}
	return srv, nil
}
