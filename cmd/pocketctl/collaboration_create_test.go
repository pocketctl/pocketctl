package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCollaborationRegistrationWaitsForOwnedDurableAck(t *testing.T) {
	output := make(chan []byte, 1)
	grants := &memorycontext.GrantClient{
		Send:    func(_ context.Context, payload []byte) error { output <- payload; return nil },
		Timeout: time.Second,
	}
	grants.Reply = grants.WaitReply
	result := make(chan error, 1)
	go func() {
		result <- registerCollaborationSession(context.Background(), grants, "team-call-1", "native-1")
	}()
	var request protocol.SessionRegistration
	select {
	case payload := <-output:
		if err := json.Unmarshal(payload, &request); err != nil {
			t.Fatal(err)
		}
	case err := <-result:
		t.Fatalf("creation passed the registration gate without an owned durable ack: %v", err)
	case <-time.After(time.Second):
		t.Fatal("registration request was not sent")
	}
	if request.Type != "session_registration" || request.SessionID != "native-1" || request.RequestID == "" {
		t.Fatalf("invalid registration request: %+v", request)
	}
	select {
	case err := <-result:
		t.Fatalf("creation passed the gate before the reply: %v", err)
	default:
	}
	grants.Dispatch(protocol.ClientMessage{
		Type: "session_registration_ack", RequestID: request.RequestID, SessionID: "native-1", Status: "ready",
	})
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("owned durable ack rejected: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("registration reply did not release creation")
	}
}

func TestCollaborationRegistrationFailsClosed(t *testing.T) {
	for _, tt := range []struct {
		name     string
		reply    json.RawMessage
		replyErr error
	}{
		{name: "timeout", replyErr: context.DeadlineExceeded},
		{name: "foreign", reply: json.RawMessage(`{"type":"session_registration_error","request_id":"team-register-call","code":"forbidden"}`)},
		{name: "wrong-session", reply: json.RawMessage(`{"type":"session_registration_ack","request_id":"team-register-call","session_id":"foreign","status":"ready"}`)},
		{name: "not-ready", reply: json.RawMessage(`{"type":"session_registration_ack","request_id":"team-register-call","session_id":"native","status":"pending"}`)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			grants := &memorycontext.GrantClient{
				Send:    func(context.Context, []byte) error { return nil },
				Reply:   func(context.Context, string, time.Duration) (json.RawMessage, error) { return tt.reply, tt.replyErr },
				Timeout: 50 * time.Millisecond,
			}
			err := registerCollaborationSession(context.Background(), grants, "call", "native")
			if err == nil {
				t.Fatal("Team creation proceeded without a ready ack for its exact session")
			}
			if tt.replyErr != nil && !errors.Is(err, tt.replyErr) {
				t.Fatalf("registration cause lost: %v", err)
			}
		})
	}
	if err := registerCollaborationSession(context.Background(), nil, "call", "native"); err == nil {
		t.Fatal("Team creation proceeded without registration transport")
	}
}
