package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/memorymcp"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/ws"
)

type recordingMemoryControlSender struct {
	payloads chan []byte
}

func (s *recordingMemoryControlSender) SendControlPayload(payload []byte) error {
	s.payloads <- append([]byte(nil), payload...)
	return nil
}

func TestWireMemoryContextInstallsCorrelatedProductionBroker(t *testing.T) {
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 4))
	sender := &recordingMemoryControlSender{payloads: make(chan []byte, 1)}
	grants := wireMemoryContext(sm, sender)

	resultCh := make(chan *protocol.SessionRegistrationAck, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := grants.RegisterSession(context.Background(), "reg-1", "ses-1")
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- result
	}()
	select {
	case payload := <-sender.payloads:
		if !strings.Contains(string(payload), `"type":"session_registration"`) {
			t.Fatalf("unexpected control payload: %s", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("wired broker did not send registration")
	}
	if !sm.DispatchMemoryContextControl(protocol.ClientMessage{
		Type: "session_registration_ack", RequestID: "reg-1", SessionID: "ses-1", Status: "ready",
	}) {
		t.Fatal("wired broker did not accept registration control reply")
	}
	select {
	case ack := <-resultCh:
		if ack.SessionID != "ses-1" || ack.Status != "ready" {
			t.Fatalf("unexpected ack: %+v", ack)
		}
	case err := <-errCh:
		t.Fatalf("registration failed: %v", err)
	case <-time.After(time.Second):
		t.Fatal("registration ack was not correlated")
	}
}

func TestDeliverDeferredInitialPromptFailsOpenOnlyAfterRegistrationAttempt(t *testing.T) {
	tests := []struct {
		name     string
		reply    json.RawMessage
		replyErr error
		wantSkip bool
	}{
		{name: "ready", reply: json.RawMessage(`{"type":"session_registration_ack","request_id":"memory-register-create-1","session_id":"ses-1","status":"ready"}`)},
		{name: "timeout", replyErr: context.DeadlineExceeded, wantSkip: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			grants := &memorycontext.GrantClient{
				Send:    func(context.Context, []byte) error { return nil },
				Reply:   func(context.Context, string, time.Duration) (json.RawMessage, error) { return tt.reply, tt.replyErr },
				Timeout: 50 * time.Millisecond,
			}
			var got session.UserMessageInput
			err := deliverDeferredInitialPrompt(context.Background(), grants, "ses-1", "exact initial prompt", "create-1",
				func(input session.UserMessageInput) error { got = input; return nil })
			if err != nil {
				t.Fatal(err)
			}
			if got.Content != "exact initial prompt" || got.SessionID != "ses-1" || got.SkipMemoryContext != tt.wantSkip {
				t.Fatalf("delivered input=%+v, want skip=%v", got, tt.wantSkip)
			}
		})
	}
}

// This catches the production break where readPump decoded a valid Phase 2
// reply but handleCommands dropped it, leaving the pre-turn grant request to
// time out every time.
func TestHandleCommandsDispatchesMemoryContextControlReplies(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	client := ws.NewClient("ws://unused", "token", "daemon-test", nil, nil, nil, output,
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	grantClient := &memorycontext.GrantClient{Timeout: time.Second}
	sent := make(chan struct{}, 1)
	grantClient.Send = func(context.Context, []byte) error {
		sent <- struct{}{}
		return nil
	}
	grantClient.Reply = grantClient.WaitReply
	sm := session.NewSessionManager(output)
	sm.SetMemoryContext(&memorycontext.Coordinator{Grants: grantClient},
		func() bool { return false },
		func(context.Context, string, string) memorycontext.Capability {
			return memorycontext.CapabilityShadowOnly
		})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go handleCommands(ctx, client, sm, slog.New(slog.NewTextHandler(io.Discard, nil)),
		&atomic.Bool{}, memorymcp.NewWsBroker(client), grantClient)

	resultCh := make(chan *protocol.MemoryContextGrantResult, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := grantClient.RequestContextGrant(ctx, "req-context", "ses-1")
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- result
	}()
	select {
	case <-sent:
	case <-time.After(time.Second):
		t.Fatal("context grant request was not sent")
	}
	client.CommandCh <- protocol.ClientMessage{
		Type: "memory_context_grant_result", RequestID: "req-context",
		SessionID: "ses-1", Grant: "grant", ExpiresIn: 300,
		ProviderPublicOrigin: "https://memory.example",
		GrantServices:        []string{"memory.context"},
	}

	select {
	case result := <-resultCh:
		if result.SessionID != "ses-1" || result.Grant != "grant" {
			t.Fatalf("unexpected result: %+v", result)
		}
	case err := <-errCh:
		t.Fatalf("context grant failed: %v", err)
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("context grant reply was dropped by the command loop")
	}
}
