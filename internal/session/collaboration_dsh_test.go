package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCollaborationDSHRegistrationContextAndOwnership(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var mu sync.Mutex
	prompts := []string{}
	registered := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			return
		}
		var req struct {
			Method  string `json:"method"`
			Payload struct {
				Args map[string]json.RawMessage `json:"args"`
			} `json:"payload"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			return
		}
		var result any = map[string]any{}
		switch req.Method {
		case "session/create":
			result = map[string]string{"sessionId": "dsh-team"}
		case "session/prompt":
			var input struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			}
			_ = json.Unmarshal(req.Payload.Args["request"], &input)
			mu.Lock()
			if !registered {
				t.Error("prompt sent before canonical registration")
			}
			prompts = append(prompts, input.Content[0].Text)
			mu.Unlock()
		case "session/cancel", "session/modelCatalog":
		default:
			t.Errorf("unexpected RPC %s", req.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"ok": true, "value": result}})
	}))
	defer server.Close()
	t.Setenv("POCKETCTL_DSH_URL", server.URL)
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 256))
	defer sm.ShutdownDSH()
	root := t.TempDir()
	policy, _ := NewCwdPolicy([]string{root})
	sm.SetCwdPolicy(policy)
	c := sm.ensureDSH()
	c.started = true
	c.following["dsh-team"] = func() {} // isolate HTTP dispatch from the transcript stream
	auth := collaborationAuth("create", "call-create")
	stable := "Frozen Team context"
	digest := sha256.Sum256([]byte(stable))
	teamContext := &protocol.CollaborationContext{SchemaVersion: 1, ContentHash: strings.Repeat("a", 64), PayloadHash: hex.EncodeToString(digest[:]), StableText: stable}
	id, err := sm.CreateCollaborationSessionRegistered(context.Background(), auth, teamContext, adapter.AgentDSH, "first", func(_ context.Context, id string) error {
		if id != "dsh-team" {
			t.Errorf("wrong registered identity %s", id)
		}
		mu.Lock()
		registered = true
		mu.Unlock()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if sm.sessions[id].Cwd != collaborationWorkspace(policy.Roots()[0], auth.BindingID) {
		t.Fatal("not isolated")
	}
	next := collaborationAuth("message", "call-next")
	sm.SetSessionStatus(id, protocol.StatusIdle)
	if err := sm.DispatchCollaborationMessage(context.Background(), next, teamContext, id, "second", next.CallID, next.CallID); err != nil {
		t.Fatal(err)
	}
	if err := sm.DispatchCollaborationMessage(context.Background(), next, teamContext, id, "second", next.CallID, next.CallID); !errors.Is(err, ErrCollaborationDuplicateCall) {
		t.Fatalf("duplicate admitted: %v", err)
	}
	mu.Lock()
	if len(prompts) != 2 || prompts[0] != stable+"\n\n[Current Team request]\nfirst" || prompts[1] != stable+"\n\n[Current Team request]\nsecond" {
		t.Errorf("lost frozen context: %v", prompts)
	}
	mu.Unlock()
	// Simulate daemon restart: native discovery alone calls this a terminal session.
	sm.collaborationBindings = nil
	sm.collaborationCalls = nil
	sm.sessions[id].Source = "terminal"
	sm.SetSessionStatus(id, protocol.StatusIdle)
	next.CallID = "after-restart"
	bad := *next
	bad.OwnerUserID++
	if err := sm.DispatchCollaborationMessage(context.Background(), &bad, teamContext, id, "foreign", "foreign", "foreign"); !errors.Is(err, ErrCollaborationBinding) {
		t.Fatalf("foreign binding admitted: %v", err)
	}
	if err := sm.DispatchCollaborationMessage(context.Background(), next, teamContext, id, "restored", next.CallID, next.CallID); err != nil {
		t.Fatal(err)
	}
}

func TestDSHFailedTeamSessionIsNotRediscovered(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	root := t.TempDir()
	policy, _ := NewCwdPolicy([]string{root})
	binding := collaborationNativeBinding{NativeSessionID: "retired", Agent: adapter.AgentDSH, BindingID: "binding"}
	cwd := collaborationWorkspace(policy.Roots()[0], binding.BindingID)
	if _, err := persistCollaborationRetirement(binding, cwd); err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 8))
	defer sm.ShutdownDSH()
	sm.SetCwdPolicy(policy)
	sm.ensureDSH().attach(dshSummary{SessionID: "retired", Cwd: cwd}, "terminal")
	if sm.sessions["retired"] != nil {
		t.Fatal("failed team session resurrected")
	}
}

func TestCollaborationDSHUncertainCreateKeepsBindingQuarantine(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		uncertain  bool
	}{
		{"native rejection", `{"result":{"ok":false,"error":{"code":"denied","message":"denied"}}}`, false},
		{"missing native identity", `{"result":{"ok":true,"value":{}}}`, true},
		{"lost response", `{`, true},
		{"missing result", `{}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					if r.URL.Path == "/api/session/create" {
						_, _ = w.Write([]byte(tc.body))
					} else {
						_, _ = w.Write([]byte(`{"result":{"ok":true,"value":{}}}`))
					}
				}
			}))
			defer server.Close()
			t.Setenv("POCKETCTL_DSH_URL", server.URL)
			sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
			defer sm.ShutdownDSH()
			policy, _ := NewCwdPolicy([]string{t.TempDir()})
			sm.SetCwdPolicy(policy)
			sm.ensureDSH().started = true
			auth := collaborationAuth("create", "uncertain-create")
			_, err := sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentDSH, "hello")
			if err == nil || errors.Is(err, errNativeSessionCreateUncertain) != tc.uncertain {
				t.Fatalf("wrong error classification: %v", err)
			}
			_, held := sm.collaborationBindings[auth.BindingID]
			if held != tc.uncertain {
				t.Fatalf("uncertain=%v, held=%v", tc.uncertain, held)
			}
			if held {
				if _, err = sm.CreateCollaborationSession(context.Background(), auth, nil, adapter.AgentDSH, "retry"); !errors.Is(err, ErrCollaborationBinding) {
					t.Fatalf("uncertain create retried: %v", err)
				}
			}
		})
	}
}
