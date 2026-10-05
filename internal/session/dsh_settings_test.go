package session

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestDSHSettingsNativeAuthorityAndPermissionGate(t *testing.T) {
	var mu sync.Mutex
	preset, model, effort := "workspace-write", "native", "high"
	commands := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == "GET" {
			return
		}
		var request struct {
			Method  string `json:"method"`
			Payload struct {
				Args map[string]json.RawMessage `json:"args"`
			} `json:"payload"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		var value any
		switch request.Method {
		case "session/create":
			value = map[string]string{"sessionId": "created-settings"}
		case "session/modelCatalog":
			value = map[string]any{"default": map[string]string{"provider": "provider", "model": "native"}, "groups": []any{map[string]any{"id": "provider", "models": []any{map[string]any{"id": "native", "name": "Native", "reasoning": map[string]any{"efforts": []any{map[string]string{"id": "off"}, map[string]string{"id": "high"}}, "defaultEffort": "high"}}}}}}
		case "permissionPresets/catalog":
			value = map[string]any{"options": []any{map[string]string{"value": "read-only"}, map[string]string{"value": "workspace-write"}, map[string]string{"value": "danger-full-access"}, map[string]string{"value": "custom-unconfined"}}}
		case "session/projections":
			value = map[string]any{"values": map[string]any{"permissions": map[string]string{"currentValue": preset}, "modelSelection": map[string]any{"lastUsed": map[string]string{"provider": "provider", "model": "old"}, "next": map[string]string{"provider": "provider", "model": model, "reasoningEffort": effort}}}}
		case "session/selectModel":
			var req struct {
				Model  string `json:"model"`
				Effort string `json:"reasoningEffort"`
			}
			_ = json.Unmarshal(request.Payload.Args["request"], &req)
			model, effort = req.Model, req.Effort
			value = map[string]any{"selected": map[string]string{"provider": "provider", "model": model, "reasoningEffort": effort}}
		case "commands/execute":
			var line string
			_ = json.Unmarshal(request.Payload.Args["line"], &line)
			if line != "/permission read-only" {
				t.Errorf("unexpected command %q", line)
			}
			commands++
			preset = "read-only"
			value = map[string]string{"commandId": "cmd-1"}
		default:
			t.Errorf("unexpected native RPC: %s", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"ok": true, "value": value}})
	}))
	defer server.Close()
	t.Setenv("POCKETCTL_DSH_URL", server.URL)
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	c := sm.ensureDSH()
	defer sm.ShutdownDSH()
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: adapter.AgentDSH, Status: protocol.StatusIdle, ControlMode: protocol.ControlManaged, Backend: &dshBackend{coord: c}}
	ctx := context.Background()
	meta, err := sm.DSHSettings(ctx, "s")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Model != "provider/native" || meta.Effort != "high" || !meta.PermissionMutable || len(meta.Models) != 1 || len(meta.Models[0].SupportedReasoningEfforts) != 2 || !meta.Models[0].IsDefault {
		t.Fatalf("lost native settings: %+v", meta)
	}
	for _, value := range []string{"danger-full-access", "custom-unconfined", "read-only\nanything"} {
		if err := sm.SetPermissionConfig("s", &protocol.PermissionConfig{Agent: adapter.AgentDSH, Preset: value}); err == nil {
			t.Fatalf("unsafe preset accepted: %s", value)
		}
	}
	if err := sm.SetPermissionConfig("s", &protocol.PermissionConfig{Agent: adapter.AgentDSH, Preset: "read-only"}); err != nil {
		t.Fatal(err)
	}
	if err := sm.SwitchSessionModel(ctx, "s", "provider/native", "switch", "off"); err != nil {
		t.Fatal(err)
	}
	meta, err = sm.DSHSettings(ctx, "s")
	if err != nil || meta.Effort != "off" || meta.Permission.Preset != "read-only" {
		t.Fatalf("settings not confirmed: %+v %v", meta, err)
	}
	if err := sm.SwitchSessionModel(ctx, "s", "provider/native", "default", ""); err != nil {
		t.Fatal(err)
	}
	if got := sm.GetSessionEffort("s"); got != "" {
		t.Fatalf("stale effort retained: %q", got)
	}

	modes, err := sm.DSHCreationPermissionModes(ctx)
	if err != nil || len(modes) != 2 {
		t.Fatalf("unsafe creation catalog: %v %v", modes, err)
	}
	options := sm.DSHCreationOptions(ctx)
	if options.Reason != "" || len(options.Models) != 1 || len(options.PermissionMutableModes) != 2 {
		t.Fatalf("creation options unavailable: %+v", options)
	}
	cwd := t.TempDir()
	cwdPolicy, err := NewCwdPolicy([]string{cwd})
	if err != nil {
		t.Fatal(err)
	}
	sm.SetCwdPolicy(cwdPolicy)
	id, err := (&dshBackend{coord: c}).Start(ctx, protocol.SessionConfig{Agent: adapter.AgentDSH, Cwd: cwd, Model: "provider/native", Effort: "off", Permission: &protocol.PermissionConfig{Agent: adapter.AgentDSH, Preset: "read-only"}})
	if err != nil {
		t.Fatal(err)
	}
	created, err := sm.DSHSettings(ctx, id)
	if err != nil || created.Permission.Preset != "read-only" || created.Effort != "off" {
		t.Fatalf("creation settings not applied: %+v %v", created, err)
	}
	sm.mu.Lock()
	sm.sessions["s"].Status = protocol.StatusWaitingQuestion
	sm.mu.Unlock()
	if err := sm.SetPermissionConfig("s", &protocol.PermissionConfig{Agent: adapter.AgentDSH, Preset: "read-only"}); err == nil {
		t.Fatal("busy permission switch accepted")
	}
	mu.Lock()
	defer mu.Unlock()
	if commands != 2 {
		t.Fatalf("blocked requests reached native command: %d", commands)
	}
}

func TestDSHCreationOptionsReportsUnavailableHost(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POCKETCTL_DSH_URL", "")
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	defer sm.ShutdownDSH()
	if got := sm.DSHCreationOptions(context.Background()); got.Reason != "dsh_not_configured" {
		t.Fatalf("missing setup must be explicit: %+v", got)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "private native error", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	t.Setenv("POCKETCTL_DSH_URL", server.URL)
	if got := sm.DSHCreationOptions(context.Background()); got.Reason != "dsh_host_unavailable" || len(got.Models) != 0 {
		t.Fatalf("host error must be sanitized and explicit: %+v", got)
	}
}
