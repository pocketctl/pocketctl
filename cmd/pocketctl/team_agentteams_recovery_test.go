package main

import (
	"context"
	"errors"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"testing"
)

func TestAgentTeamsRecoveryRegistrationOrder(t *testing.T) {
	for _, operation := range []string{"create", "message"} {
		for _, fail := range []bool{false, true} {
			t.Run(operation+map[bool]string{true: "-registration-failed", false: "-accepted"}[fail], func(t *testing.T) {
				var events []protocol.DaemonEvent
				registered := false
				event := protocol.DaemonEvent{Type: "session_created", SessionID: "original-native", RequestID: "team-original-call", Collaboration: &protocol.CollaborationAuthorization{Operation: operation, CallID: "original-call"}}
				err := registerAgentTeamsRecovery(context.Background(), event, &protocol.CollaborationContext{}, func(v protocol.DaemonEvent) {
					if v.Type != "session_created" && !registered {
						t.Fatal("receipt preceded registration")
					}
					events = append(events, v)
				}, func(_ context.Context, request, native string) error {
					if request != event.RequestID || native != event.SessionID {
						t.Fatal("original identity changed")
					}
					if operation == "message" && len(events) != 0 {
						t.Fatal("message recovery attempted native creation")
					}
					if operation == "create" && (len(events) != 1 || events[0].Type != "session_created") {
						t.Fatal("create recovery omitted creation")
					}
					if fail {
						return errors.New("registration unavailable")
					}
					registered = true
					return nil
				})
				if (err != nil) != fail {
					t.Fatalf("registration error lost: %v", err)
				}
				expected := 0
				if operation == "create" {
					expected++
				}
				if !fail {
					expected += 2
				}
				if len(events) != expected {
					t.Fatalf("unexpected events: %d", len(events))
				}
				if !fail {
					last := events[len(events)-1]
					if last.Type != "collaboration_dispatch_receipt" || last.Status != "accepted" || last.Collaboration != event.Collaboration || last.SessionID != event.SessionID || last.RequestID != event.RequestID {
						t.Fatal("accepted receipt lost frozen identity")
					}
				}
			})
		}
	}
}
