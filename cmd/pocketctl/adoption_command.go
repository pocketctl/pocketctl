package main

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type codexAdopter interface {
	AdoptCodex(context.Context, protocol.AdoptionRequest) (protocol.AdoptionReceipt, error)
	CodexAdoptionStatus(context.Context, string, string) (protocol.AdoptionReceipt, error)
	CancelCodexAdoption(context.Context, string, string) (protocol.AdoptionReceipt, error)
}

func validCodexThreadID(s string) bool {
	id, err := uuid.Parse(s)
	return err == nil && id != uuid.Nil && id.String() == s
}

func validAdoptionID(s string) bool {
	return len(s) > 0 && len(s) <= 512 && strings.TrimSpace(s) == s && !strings.ContainsAny(s, "/\\\x00\r\n\t ")
}
func dispatchCodexAdoption(ctx context.Context, service codexAdopter, method string, req protocol.AdoptionRequest, connected bool) (protocol.AdoptionReceipt, error) {
	var result protocol.AdoptionReceipt
	var err error
	invalid := &agentcontrol.ProtocolError{Code: agentcontrol.ErrInvalidRequest, Message: "invalid session adoption parameters"}
	if !validCodexThreadID(req.SessionID) || req.OperationID != "" && !validAdoptionID(req.OperationID) {
		return result, invalid
	}
	switch method {
	case agentcontrol.MethodAdopt:
		if !validAdoptionID(req.RequestID) || req.OperationID != "" || req.WaitMS < 0 || req.WaitMS > 120000 {
			return result, invalid
		}
		result, err = service.AdoptCodex(ctx, req)
	case agentcontrol.MethodAdoptStatus, agentcontrol.MethodAdoptCancel:
		if req.Unarchive || req.WaitMS != 0 || method == agentcontrol.MethodAdoptCancel && req.OperationID == "" {
			return result, invalid
		}
		if method == agentcontrol.MethodAdoptStatus {
			result, err = service.CodexAdoptionStatus(ctx, req.SessionID, req.OperationID)
		} else {
			result, err = service.CancelCodexAdoption(ctx, req.SessionID, req.OperationID)
		}
	default:
		return result, invalid
	}
	if errors.Is(err, protocol.ErrAdoptionOperationNotFound) {
		return result, &agentcontrol.ProtocolError{Code: "operation_not_found", Message: "adoption operation not found for this session"}
	}
	if err == nil && (result.SessionID != req.SessionID || req.OperationID != "" && result.OperationID != req.OperationID) {
		return protocol.AdoptionReceipt{}, errors.New("adoption receipt identity mismatch")
	}
	result.RemoteReady = connected && result.LocalManaged && result.Phase == "managed"
	return result, err
}
func adoptionCommandResult(ctx context.Context, service codexAdopter, cmd protocol.ClientMessage) protocol.DaemonEvent {
	response := protocol.DaemonEvent{Type: "session_adoption_result", SessionID: cmd.SessionID, RequestID: cmd.RequestID}
	req := protocol.AdoptionRequest{SessionID: cmd.SessionID, RequestID: cmd.AdoptionRequestID, WaitMS: cmd.WaitMS, Unarchive: cmd.Unarchive, OperationID: cmd.OperationID}
	receipt, err := dispatchCodexAdoption(ctx, service, cmd.Type, req, true)
	if err != nil {
		response.Error = "unverified"
		var p *agentcontrol.ProtocolError
		if errors.As(err, &p) && p.Code == agentcontrol.ErrInvalidRequest {
			response.Error = p.Code
		}
		response.Reason = response.Error
		return response
	}
	response.Adoption = &receipt
	return response
}
