package session

import (
	"context"
	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"testing"
)

func TestCodexCreationCapabilitiesRespectLocalPolicyAndNativeApprovals(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := agentcontrol.DefaultConfig()
	cfg.Codex.State = agentcontrol.StateEnabled
	if err := agentcontrol.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	provider := sm.CodexRuntimeProvider()
	provider.resolve = func() (string, string, error) { return "/fake/codex", "0.144.1", nil }
	caps := agentcontrol.CodexCapabilities{Core: true, TerminalRemote: true, ThreadInjection: true, Approvals: true}
	provider.probe = func(context.Context, string, string) (agentcontrol.CodexCapabilities, error) { return caps, nil }
	got := sm.CodexCreationCapabilities(context.Background(), "")
	if !got.Supported || !got.ManagedRuntime || indexOfString(got.PermissionPresets, "full_access") >= 0 || indexOfString(got.ApprovalPolicies, "never") >= 0 {
		t.Fatalf("unsafe capabilities: %+v", got)
	}
	sm.SetRemotePermissionPolicy(adapter.RemotePermissionPolicy{AllowDangerous: true})
	got = sm.CodexCreationCapabilities(context.Background(), "")
	if indexOfString(got.PermissionPresets, "full_access") < 0 || indexOfString(got.ApprovalPolicies, "never") < 0 {
		t.Fatalf("missing explicit opt-in: %+v", got)
	}
	caps.Approvals = false
	got = sm.CodexCreationCapabilities(context.Background(), "")
	if indexOfString(got.ApprovalPolicies, "on-request") >= 0 {
		t.Fatalf("advertised unavailable approvals: %+v", got)
	}
	caps.ThreadInjection = false
	if got = sm.CodexCreationCapabilities(context.Background(), ""); got.Supported {
		t.Fatalf("unsupported empty-thread persistence advertised: %+v", got)
	}
	if got = sm.CodexCreationCapabilities(context.Background(), "not-allowlisted"); got.Supported || got.Reason != "invalid_codex_home" {
		t.Fatalf("unknown account: %+v", got)
	}
}
