package session

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/memorycontext"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestOpenCodeBackendDoesNotSharePendingContextAcrossDispatches(t *testing.T) {
	typ := reflect.TypeOf(serverBackend{})
	for _, name := range []string{"pendingContext", "pendingContextMu"} {
		if _, ok := typ.FieldByName(name); ok {
			t.Fatalf("serverBackend stores %s across calls; concurrent dispatches can consume each other's context", name)
		}
	}
}

type deferredReceiptMemory struct {
	sessionMemoryContextClient
	receipts chan memorycontext.ReceiptRequest
}

func (m *deferredReceiptMemory) Receipt(_ context.Context, _, _, _ string, req memorycontext.ReceiptRequest) error {
	m.receipts <- req
	return nil
}

func TestOpenCodeBackendRecordsReceiptAfterNativeUserMessageIsAccepted(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseResponse := make(chan struct{})
	messageID := ""
	server := startFakeOpenCodeServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_1/message":
			select {
			case <-requestStarted:
				_ = json.NewEncoder(w).Encode([]any{map[string]any{
					"info":  map[string]any{"id": messageID, "sessionID": "ses_1", "role": "user"},
					"parts": []any{map[string]any{"type": "text", "text": "unchanged"}},
				}})
			default:
				_ = json.NewEncoder(w).Encode([]any{})
			}
		case r.Method == http.MethodPost && r.URL.Path == "/session/ses_1/message":
			var body struct {
				System    string `json:"system"`
				MessageID string `json:"messageID"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if body.System == "" {
				http.Error(w, "missing hidden system context", http.StatusBadRequest)
				return
			}
			if body.MessageID == "" {
				http.Error(w, "missing reserved message id", http.StatusBadRequest)
				return
			}
			messageID = body.MessageID
			close(requestStarted)
			<-releaseResponse
			_ = json.NewEncoder(w).Encode(map[string]any{
				"info": map[string]any{
					"id": "msg_assistant", "sessionID": "ses_1", "role": "assistant",
					"parentID": messageID,
				},
				"parts": []any{},
			})
		default:
			http.NotFound(w, r)
		}
	}))

	receipts := make(chan memorycontext.ReceiptRequest, 1)
	memory := &deferredReceiptMemory{receipts: receipts}
	memoryCoordinator := &memorycontext.Coordinator{
		Grants: grantTransportFunc(func(context.Context, string, string) (*protocol.MemoryContextGrantResult, error) {
			return &protocol.MemoryContextGrantResult{
				Type: "memory_context_grant_result", Grant: "grant", ExpiresIn: 300,
				InstallationID: "install-1", SessionID: "ses_1",
				ProviderPublicOrigin: "https://memory.example", Services: []string{"memory.context"},
			}, nil
		}),
		Memory: memory,
	}
	pack, out := memoryCoordinator.Prepare(context.Background(), memorycontext.TurnRequest{
		ClientRequestID: "req-1", SessionID: "ses_1", Agent: "opencode",
		UserContent: "unchanged", IsNewTurn: true, Mode: memorycontext.ModeEnabled,
		Capability: memorycontext.CapabilityNativeHiddenV1,
	})
	if pack == nil || out.Kind != "injected" {
		t.Fatalf("prepare: %+v", out)
	}

	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	coord := newOpencodeCoordinator(sm)
	coord.server = server
	coord.started = true
	backend := &serverBackend{coord: coord}
	sm.opencode = coord
	sm.sessions["ses_1"] = &ProcessState{
		SessionID: "ses_1", Source: "daemon", Agent: adapter.AgentOpencode,
		ControlMode: protocol.ControlManaged, Status: protocol.StatusIdle, Cwd: "/repo", Backend: backend,
	}
	sm.SetMemoryContext(memoryCoordinator, func() bool { return true }, nil)

	if err := backend.SendWithContext(context.Background(), "ses_1", "unchanged", pack); err != nil {
		t.Fatal(err)
	}
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("native prompt did not start")
	}
	select {
	case receipt := <-receipts:
		if !receipt.Delivered || receipt.OutcomeCode != "accepted" || receipt.SessionID != "ses_1" {
			t.Fatalf("receipt = %+v", receipt)
		}
	case <-time.After(time.Second):
		t.Fatal("native user-message acceptance did not record receipt before model completion")
	}
	close(releaseResponse)
}
