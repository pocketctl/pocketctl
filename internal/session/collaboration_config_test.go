package session

import (
	"context"
	"encoding/json"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTeamConfigDiscoveryAndFailClosedAuthorization(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"model": "sonnet", "env": map[string]string{"ANTHROPIC_DEFAULT_SONNET_MODEL": "local-model-a", "ANTHROPIC_DEFAULT_OPUS_MODEL": "local-model-b"}})
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 10))
	cap := sm.TeamConfigCapabilities(context.Background(), adapter.AgentClaude)
	if cap == nil || cap.DefaultConfig.Model != "local-model-a" || cap.ReadOnly || len(cap.Models) != 2 {
		t.Fatalf("capability=%+v", cap)
	}
	auth := collaborationAuth("create", "v2")
	config := cap.DefaultConfig
	auth.RequestedConfig = &config
	auth.ConfigHash = config.Hash()
	auth.ConfigRevision = 1
	auth.CapabilityRevision = cap.Revision
	if _, err := sm.validateTeamConfig(context.Background(), auth, adapter.AgentClaude); err != nil {
		t.Fatal(err)
	}
	auth.ConfigHash = "forged"
	if _, err := sm.validateTeamConfig(context.Background(), auth, adapter.AgentClaude); err == nil {
		t.Fatal("forged hash accepted")
	}
	auth.ConfigHash = config.Hash()
	auth.CapabilityRevision = "old"
	if _, err := sm.validateTeamConfig(context.Background(), auth, adapter.AgentClaude); err == nil {
		t.Fatal("stale capability accepted")
	}
	auth.CapabilityRevision = cap.Revision
	auth.ExecutionMode = "discussion"
	if _, err := sm.validateTeamConfig(context.Background(), auth, adapter.AgentClaude); err == nil {
		t.Fatal("unconfined discussion accepted")
	}
	auth.ExecutionMode = ""
	config.PermissionProfile = "bypassPermissions"
	auth.ConfigHash = config.Hash()
	if _, err := sm.validateTeamConfig(context.Background(), auth, adapter.AgentClaude); err == nil {
		t.Fatal("permission escalation accepted")
	}
}
func TestTeamConfigReceiptUsesActualProcessState(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 10))
	sm.sessions["private"] = &ProcessState{SessionID: "private", Agent: adapter.AgentClaude, Model: "actual-model", Permission: &protocol.PermissionConfig{Agent: adapter.AgentClaude, Mode: "manual"}}
	auth := collaborationAuth("message", "v2")
	auth.ConfigRevision = 2
	auth.RequestedConfig = &protocol.TeamRuntimeConfig{Model: "requested-model", PermissionProfile: "manual"}
	auth.ConfigHash = auth.RequestedConfig.Hash()
	receipt := sm.TeamConfigReceipt(context.Background(), auth, "private")
	if receipt == nil || receipt.AppliedConfig.Model != "actual-model" || receipt.ConfigHash == auth.ConfigHash {
		t.Fatalf("receipt echoed request: %+v", receipt)
	}
}

func TestTeamTypedApprovalRoutesExactClaudeHookIdentity(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 10))
	key := claudeApprovalKey{sessionID: "owner-session", requestID: "hook-request"}
	sm.claudeApprovalResolved = map[claudeApprovalKey]time.Time{key: time.Now()}
	if err := sm.ResolveApprovalAction("owner-session", "hook-request", "once"); err == nil || !strings.Contains(err.Error(), "resolved") {
		t.Fatalf("known terminal request must converge: %v", err)
	}
	if err := sm.ResolveApprovalAction("other-session", "hook-request", "once"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("cross-session identity claimed: %v", err)
	}
	if err := sm.ResolveApprovalAction("owner-session", "hook-request", "always"); err == nil || !strings.Contains(err.Error(), "once or reject") {
		t.Fatalf("unsupported scope accepted: %v", err)
	}
}
func TestTeamDSHConfigCannotAdvertiseGlobalModelMutation(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 10))
	if cap := sm.TeamConfigCapabilities(context.Background(), adapter.AgentDSH); cap != nil {
		t.Fatal("DSH global-default mutation cannot satisfy v2 isolation")
	}
}

func TestTeamCodexRestartRestoresOnlyDurablyOwnedFrozenSettings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	t.Setenv("POCKETCTL_CODEX_HOMES", "")
	b, rpc := nativeMemoryCodexBackend(t)
	c, sm := b.coord, b.sm
	auth := collaborationAuth("message", "after-restart")
	workspace := collaborationWorkspace(t.TempDir(), auth.BindingID)
	c.projectCwd, c.codexHome = workspace, home
	c.admissionProbe = nil
	id := "frozen-team-thread"
	c.restoreManagedThreads([]string{id})
	dir := filepath.Join(home, "sessions")
	os.MkdirAll(dir, 0700)
	meta, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]any{"id": id, "cwd": workspace, "originator": "pocketctl", "source": "vscode"}})
	if err := os.WriteFile(filepath.Join(dir, "rollout-test-"+id+".jsonl"), append(meta, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	high := "high"
	config := protocol.TeamRuntimeConfig{Model: "frozen-model", ReasoningEffort: &high, PermissionProfile: "read_only"}
	record := collaborationNativeBinding{NativeSessionID: id, Agent: adapter.AgentCodex, BindingID: auth.BindingID, ConfigRevision: 2, ConfigHash: config.Hash(), RuntimeModel: config.Model, RuntimeEffort: high, RuntimePermission: config.PermissionProfile}
	if err := persistCollaborationNative(record, workspace); err != nil {
		t.Fatal(err)
	}
	params, permission := c.teamResumeParams(id)
	if params["model"] != "frozen-model" || permission == nil || permission.SandboxMode != "read-only" {
		t.Fatalf("lost frozen settings: %v %+v", params, permission)
	}
	raw, _ := json.Marshal(map[string]any{"model": "frozen-model", "reasoningEffort": "high", "approvalPolicy": "on-request", "sandbox": map[string]any{"type": "readOnly"}, "cwd": workspace, "thread": map[string]any{"id": id, "cwd": workspace, "status": map[string]any{"type": "idle"}, "turns": []any{}}})
	rpc.results["thread/resume"] = raw
	rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[]}`)
	c.subscribeTerminalThread(context.Background(), rpc, b.generation, id, newCodexProjection(b.generation))
	auth.RequestedConfig = &config
	auth.ConfigRevision = 2
	auth.ConfigHash = config.Hash()
	if receipt := sm.TeamConfigReceipt(context.Background(), auth, id); receipt == nil || receipt.ConfigHash != config.Hash() {
		t.Fatalf("restored native configuration not confirmed: %+v", receipt)
	}
	// Native provenance alone is insufficient without the daemon's registry.
	c.restoreManagedThreads(nil)
	params, permission = c.teamResumeParams(id)
	if permission != nil || params["model"] != nil {
		t.Fatalf("foreign native history acquired Team settings: %v", params)
	}
}

func TestTeamCodexReceiptUsesNativeResponseRatherThanRequestedEffort(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 10))
	low := "low"
	high := "high"
	sm.sessions["native-config"] = &ProcessState{SessionID: "native-config", Agent: adapter.AgentCodex, Model: "native-model", Effort: high, Permission: &protocol.PermissionConfig{Agent: adapter.AgentCodex, ApprovalPolicy: "on-request", SandboxMode: "workspace-write"}}
	auth := collaborationAuth("message", "native-config")
	auth.ConfigRevision = 1
	auth.RequestedConfig = &protocol.TeamRuntimeConfig{Model: "native-model", ReasoningEffort: &high, PermissionProfile: "request_approval"}
	auth.ConfigHash = auth.RequestedConfig.Hash()
	if sm.TeamConfigReceipt(context.Background(), auth, "native-config") != nil {
		t.Fatal("launch arguments cannot establish native confirmation")
	}
	var fields codexNativeConfigFields
	if err := json.Unmarshal([]byte(`{"model":"native-model","reasoningEffort":"low","approvalPolicy":"on-request","sandbox":{"type":"workspaceWrite"}}`), &fields); err != nil {
		t.Fatal(err)
	}
	sm.rememberNativeCodexConfig("native-config", fields)
	receipt := sm.TeamConfigReceipt(context.Background(), auth, "native-config")
	expected := protocol.TeamRuntimeConfig{Model: "native-model", ReasoningEffort: &low, PermissionProfile: "request_approval"}
	if receipt == nil || receipt.ConfigHash != expected.Hash() || receipt.ConfigHash == auth.ConfigHash {
		t.Fatalf("receipt did not report actual native state: %+v", receipt)
	}
	fields.Sandbox.Type = "dangerFullAccess"
	sm.rememberNativeCodexConfig("native-config", fields)
	if sm.TeamConfigReceipt(context.Background(), auth, "native-config") != nil {
		t.Fatal("unrepresentable dangerous native settings cannot be reported as request_approval")
	}
}
