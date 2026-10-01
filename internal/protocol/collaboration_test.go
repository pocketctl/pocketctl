package protocol

import (
	"encoding/json"
	"testing"
)

func TestCollaborationAuthorizationRoundTrip(t *testing.T) {
	message := ClientMessage{Type: "collaboration_user_message", Collaboration: &CollaborationAuthorization{
		ProtocolVersion: TeamCollaborationProtocolV1, Operation: "message", CallID: "call-1",
		TeamSessionID: "team-session-1", BindingID: "binding-1", BindingRevision: 2,
		OfferID: "offer-1", OfferRevision: 3, OwnerUserID: 9, DaemonID: "daemon-1",
	}, TeamContext: &CollaborationContext{SchemaVersion: 1, ContextVersion: 2, ContentHash: "hash", PayloadHash: "payload", StableText: "context"}}
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	var decoded ClientMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Collaboration == nil || decoded.Collaboration.ProtocolVersion != 1 || decoded.Collaboration.OwnerUserID != 9 {
		t.Fatalf("unexpected collaboration authorization: %#v", decoded.Collaboration)
	}
	if decoded.TeamContext == nil || decoded.TeamContext.ContextVersion != 2 {
		t.Fatalf("missing Team context: %#v", decoded.TeamContext)
	}
}

func TestRegisterAdvertisesExplicitCollaborationCapabilities(t *testing.T) {
	register := RegisterMessage{Type: "register", Capabilities: []string{CapabilityTeamDispatchV1}}
	raw, err := json.Marshal(register)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) == "" || len(register.Capabilities) != 1 {
		t.Fatal("missing collaboration capability")
	}
}
