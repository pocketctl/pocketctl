package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func collaborationAuth(operation, callID string) *protocol.CollaborationAuthorization {
	return &protocol.CollaborationAuthorization{
		ProtocolVersion: protocol.TeamCollaborationProtocolV1, Operation: operation, CallID: callID,
		TeamSessionID: "team-session", BindingID: "binding/../../escape", BindingRevision: 2,
		OfferID: "offer", OfferRevision: 3, OwnerUserID: 7, DaemonID: "daemon",
	}
}

func TestValidateCollaborationAuthorization(t *testing.T) {
	if err := ValidateCollaborationAuthorization(collaborationAuth("message", "call"), "message"); err != nil {
		t.Fatal(err)
	}
	bad := collaborationAuth("message", "call")
	bad.ProtocolVersion++
	if !errors.Is(ValidateCollaborationAuthorization(bad, "message"), ErrCollaborationAuthorization) {
		t.Fatal("expected unsupported protocol version to fail closed")
	}
}

func TestCollaborationWorkspaceDoesNotUseRemoteIdentifierAsPath(t *testing.T) {
	root := t.TempDir()
	workspace := collaborationWorkspace(root, "../../private")
	if filepath.Dir(filepath.Dir(filepath.Dir(workspace))) != root {
		t.Fatalf("workspace escaped local root: %s", workspace)
	}
	if filepath.Base(workspace) == "private" {
		t.Fatal("binding identifier leaked into workspace path")
	}
}

func TestPrepareCollaborationContextVerifiesPayloadHash(t *testing.T) {
	text := "trusted transport, untrusted Team reference"
	digest := sha256.Sum256([]byte(text))
	value := &protocol.CollaborationContext{
		SchemaVersion: 1, ContextVersion: 2, ContentHash: string(make([]byte, 64)),
		HistoryThroughEventSeq: 7, PayloadHash: hex.EncodeToString(digest[:]), StableText: text,
	}
	prepared, err := prepareCollaborationContext(value)
	if err != nil || prepared.StableText != text {
		t.Fatalf("unexpected context: %#v %v", prepared, err)
	}
	value.PayloadHash = string(make([]byte, 64))
	if !errors.Is(func() error { _, err := prepareCollaborationContext(value); return err }(), ErrCollaborationAuthorization) {
		t.Fatal("tampered context payload was accepted")
	}
}

func TestDispatchReconcilesOnlyExactDaemonLocalWorkspace(t *testing.T) {
	root := t.TempDir()
	policy, err := NewCwdPolicy([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	auth := collaborationAuth("message", "call")
	nativeID := "native-session"
	sm := &SessionManager{
		sessions: map[string]*ProcessState{nativeID: {
			SessionID: nativeID, Cwd: collaborationWorkspace(root, auth.BindingID),
			Agent: adapter.AgentCodex, Source: "daemon", Status: protocol.StatusRunning,
		}},
		cwdPolicy: policy,
	}
	err = sm.DispatchCollaborationMessage(context.Background(), auth, nil, nativeID, "hello", "request", "message")
	if !errors.Is(err, ErrCollaborationSessionBusy) {
		t.Fatalf("expected busy, got %v", err)
	}
	if sm.collaborationBindings[auth.BindingID].NativeSessionID != nativeID {
		t.Fatal("expected exact workspace to restore collaboration binding")
	}

	privateID := "private-session"
	sm.sessions[privateID] = &ProcessState{SessionID: privateID, Cwd: root, Agent: adapter.AgentCodex, Source: "daemon", Status: protocol.StatusIdle}
	auth.BindingID = "another-binding"
	err = sm.DispatchCollaborationMessage(context.Background(), auth, nil, privateID, "hello", "request", "message")
	if !errors.Is(err, ErrCollaborationBinding) {
		t.Fatalf("private session was not rejected: %v", err)
	}
}

func TestDispatchRejectsDuplicateCallBeforeExecution(t *testing.T) {
	auth := collaborationAuth("message", "same-call")
	nativeID := "native-session"
	sm := &SessionManager{
		sessions: map[string]*ProcessState{nativeID: {SessionID: nativeID, Status: protocol.StatusIdle}},
		collaborationBindings: map[string]collaborationNativeBinding{auth.BindingID: {
			NativeSessionID: nativeID, TeamSessionID: auth.TeamSessionID, BindingID: auth.BindingID,
			BindingRevision: auth.BindingRevision, OfferID: auth.OfferID, OfferRevision: auth.OfferRevision,
			OwnerUserID: auth.OwnerUserID, DaemonID: auth.DaemonID,
		}},
		collaborationCalls: map[string]string{auth.CallID: nativeID},
	}
	err := sm.DispatchCollaborationMessage(context.Background(), auth, nil, nativeID, "hello", "request", "message")
	if !errors.Is(err, ErrCollaborationDuplicateCall) {
		t.Fatalf("expected duplicate rejection, got %v", err)
	}
}
