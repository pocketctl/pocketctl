package main

import (
	"context"
	"fmt"
	"sync/atomic"

	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/ws"
)

func registerCollaborationSession(ctx context.Context, grants *memorycontext.GrantClient, requestID, sessionID string) error {
	if grants == nil {
		return fmt.Errorf("collaboration_session_registration_failed: registration transport unavailable")
	}
	if _, err := grants.RegisterSession(ctx, "team-register-"+requestID, sessionID); err != nil {
		return fmt.Errorf("collaboration_session_registration_failed: %w", err)
	}
	return nil
}

// A Team create runs outside the command loop so that loop can deliver the
// registration ACK. Unlike personal Memory's optional enrichment, registration
// is required before any Team turn or accepted delivery receipt.
func runCollaborationSessionCreate(ctx context.Context, client *ws.Client, sm *session.SessionManager,
	cmd protocol.ClientMessage, stateDirty *atomic.Bool, grants *memorycontext.GrantClient) {
	nativeSessionID, err := sm.CreateCollaborationSessionRegistered(ctx, cmd.Collaboration, cmd.TeamContext, cmd.Agent, cmd.Content,
		func(ctx context.Context, id string) error {
			return registerCollaborationSession(ctx, grants, cmd.RequestID, id)
		})
	if err != nil {
		if cmd.TeamContext != nil {
			client.SendMsg(protocol.DaemonEvent{Type: "collaboration_context_receipt", RequestID: cmd.RequestID,
				MsgID: cmd.MsgID, Status: "rejected", Reason: err.Error(), Collaboration: cmd.Collaboration, TeamContext: cmd.TeamContext})
		}
		client.SendMsg(protocol.DaemonEvent{Type: "collaboration_dispatch_receipt", RequestID: cmd.RequestID,
			MsgID: cmd.MsgID, Status: "rejected", Reason: classifyCreateError(err.Error()), Error: err.Error(), Collaboration: cmd.Collaboration})
		return
	}
	cwd, _ := sm.GetSessionCwd(nativeSessionID)
	event := protocol.DaemonEvent{Type: "session_created", SessionID: nativeSessionID,
		RequestID: cmd.RequestID, ReservationID: quotaReservationID(cmd.QuotaGrant), Agent: cmd.Agent,
		Cwd: cwd, Collaboration: cmd.Collaboration}
	setSessionControlMetadata(&event, sm, nativeSessionID)
	client.SendMsg(event)
	stateDirty.Store(true)
	if cmd.TeamContext != nil {
		client.SendMsg(protocol.DaemonEvent{Type: "collaboration_context_receipt", SessionID: nativeSessionID,
			RequestID: cmd.RequestID, MsgID: cmd.MsgID, Status: "accepted", Collaboration: cmd.Collaboration, TeamContext: cmd.TeamContext})
	}
	client.SendMsg(protocol.DaemonEvent{Type: "collaboration_dispatch_receipt", SessionID: nativeSessionID,
		RequestID: cmd.RequestID, MsgID: cmd.MsgID, Status: "accepted", Collaboration: cmd.Collaboration})
}
