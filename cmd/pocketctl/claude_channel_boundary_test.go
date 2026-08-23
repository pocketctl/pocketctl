package main

import (
	"bytes"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
)

// TestClaudeLauncherInvocationBoundary freezes the contract that a future
// Claude launcher invocation check (isClaudeLauncherInvocation) MUST be
// inserted BEFORE the generic subcommand switch in main() and MUST NOT
// alter the existing isCodexLauncherInvocation / isOpenCodeLauncherInvocation
// checks (design §1.3, §3.3, §Task 3).
//
// Until Task 3 lands, isClaudeLauncherInvocation does not exist and this
// test fails to compile — which is the loudest possible "boundary frozen"
// signal. Task 3 will add the function with this exact signature.
func TestClaudeLauncherInvocationBoundary(t *testing.T) {
	tests := []struct {
		name  string
		argv0 string
		args  []string
		want  bool
	}{
		// Invoked via Pocketctl-owned shim symlinked as `claude`.
		{"shim path", "/Users/me/.pocketctl/bin/claude", nil, true},
		{"shim windows", "claude.exe", nil, true},
		// Invoked via hidden subcommand contract. The canonical agent token
		// is "claude-code" (AgentClaudeCode), NOT "claude" — the launcher
		// dispatch matches on the canonical token. Design §Task 3.
		{"hidden subcommand", "pocketctl", []string{"__agent-launch", "claude-code", "fix", "the", "bug"}, true},
		{"hidden subcommand wrong token", "pocketctl", []string{"__agent-launch", "claude", "fix"}, false},
		// Must NOT match codex/opencode launcher invocations.
		{"codex shim", "/Users/me/.pocketctl/bin/codex", nil, false},
		{"opencode shim", "/Users/me/.pocketctl/bin/opencode", nil, false},
		{"codex subcommand", "pocketctl", []string{"__agent-launch", "codex", "resume", "id"}, false},
		{"opencode subcommand", "pocketctl", []string{"__agent-launch", "opencode"}, false},
		// Regular daemon/command dispatch must not be misclassified.
		{"daemon start", "pocketctl", []string{"daemon", "start"}, false},
		{"agent command", "pocketctl", []string{"agent", "claude-code", "status"}, false},
		{"hook", "pocketctl", []string{"__hook"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isClaudeLauncherInvocation(tt.argv0, tt.args)
			if got != tt.want {
				t.Fatalf("argv0=%q args=%q got=%v want=%v", tt.argv0, tt.args, got, tt.want)
			}
		})
	}
}

// TestClaudeLauncherArgsStripsHiddenPrefixOnly freezes that
// claudeLauncherArgs ONLY strips the `__agent-launch claude-code` hidden
// subcommand prefix or returns argv verbatim when invoked via the shim
// symlink. The --native escape flag is handled downstream by PlanClaude,
// NOT by this stripping function.
func TestClaudeLauncherArgsStripsHiddenPrefixOnly(t *testing.T) {
	tests := []struct {
		name  string
		argv0 string
		args  []string
		want  []string
	}{
		{"hidden prefix stripped", "pocketctl", []string{"__agent-launch", "claude-code", "--native", "fix"}, []string{"--native", "fix"}},
		{"shim argv verbatim", "/home/u/.pocketctl/bin/claude", []string{"--native", "--resume", "abc"}, []string{"--native", "--resume", "abc"}},
		{"shim continue verbatim", "/home/u/.pocketctl/bin/claude", []string{"--continue"}, []string{"--continue"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := claudeLauncherArgs(tt.argv0, tt.args)
			if !equalStringSlices(got, tt.want) {
				t.Fatalf("got=%v want=%v", got, tt.want)
			}
		})
	}
}

// TestClaudeNativeEscapeEndToEndStripsNativeAndExecsRealBinary verifies the
// end-to-end contract: `claude --native --resume X` results in the real
// Claude binary being exec'd with `--resume X` (no probe, no injection).
// This pairs PlanClaude's --native strip with ClaudeLauncher.Run.
func TestClaudeNativeEscapeEndToEndStripsNativeAndExecsRealBinary(t *testing.T) {
	// Tested in detail in internal/agentcontrol/claude_launcher_test.go
	// (TestClaudeLauncherNativeEscapeStripsOnlyNativeFlag). This assertion
	// only documents the boundary at the cmd layer; the real coverage lives
	// in the agentcontrol package.
}

// TestClaudeLauncherDoesNotRegisterAsRuntimeProvider freezes the boundary
// (design §1.3): daemonRuntimeProviders must still return ONLY OpenCode and
// Codex. Claude Channel MUST NOT masquerade as a RuntimeProvider. This test
// will fail when Task 3 accidentally adds Claude to the provider map.
func TestClaudeLauncherDoesNotRegisterAsRuntimeProvider(t *testing.T) {
	events := make(chan protocol.DaemonEvent, 8)
	sm := session.NewSessionManager(events)
	providers := daemonRuntimeProviders(sm)
	for name := range providers {
		if name == "claude" || name == "claude-code" {
			t.Fatalf("Claude must not be registered as a RuntimeProvider (design §1.3); found %q", name)
		}
	}
	if _, ok := providers["opencode"]; !ok {
		t.Fatalf("OpenCode provider must remain registered")
	}
	if _, ok := providers["codex"]; !ok {
		t.Fatalf("Codex provider must remain registered")
	}
}

// TestManagedAgentGateAcceptsClaudeCode verifies the `agent` command's
// managed-agent gate accepts the canonical Claude token "claude-code" and
// dispatches to the installer. ZCode must still be diverted before the gate.
// Design §Task 3.
func TestManagedAgentGateAcceptsClaudeCode(t *testing.T) {
	// claude-code is now a recognized managed agent. With a fake manager
	// that implements MultiAgentManager, enable should be dispatched.
	manager := &fakeMultiAgentManager{}
	var stdout, stderr bytes.Buffer
	err := runAgentCommand([]string{"claude-code", "status"}, &stdout, &stderr, manager)
	if err != nil {
		t.Fatalf("claude-code must be a recognized managed agent token: %v", err)
	}
	if manager.lastAgent != "claude-code" {
		t.Fatalf("lastAgent=%q want claude-code", manager.lastAgent)
	}
}

func TestClaudeEnableCleansLegacyGlobalHookOnce(t *testing.T) {
	original := removeLegacyClaudeUserHook
	t.Cleanup(func() { removeLegacyClaudeUserHook = original })
	calls := 0
	removeLegacyClaudeUserHook = func() error {
		calls++
		return nil
	}
	manager := &fakeMultiAgentManager{status: agentcontrol.Status{RealBinary: "/fake/claude"}}
	var stdout, stderr bytes.Buffer
	if err := runAgentCommand([]string{"claude-code", "enable", "--no-shell-profile"}, &stdout, &stderr, manager); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("legacy hook cleanup calls=%d want 1", calls)
	}
}

// TestManagedAgentGateStillExcludesZCodeAndForeignAgents freezes that ZCode
// is diverted to its sync command before the managed gate, and unknown
// agents are rejected.
func TestManagedAgentGateStillExcludesZCodeAndForeignAgents(t *testing.T) {
	var stdout, stderr bytes.Buffer
	manager := &fakeMultiAgentManager{}
	// ZCode is diverted before the managed-agent gate. It returns nil (prints
	// help) but MUST NOT increment the managed-agent status counter.
	if err := runAgentCommand([]string{zcodeAgentType}, &stdout, &stderr, manager); err != nil {
		t.Fatalf("zcode dispatch returned error: %v", err)
	}
	if manager.statusCalls != 0 {
		t.Fatalf("zcode must not reach the managed-agent gate; statusCalls=%d", manager.statusCalls)
	}
	// Unknown agent rejected.
	if err := runAgentCommand([]string{"nonsense-agent", "enable"}, &stdout, &stderr, manager); err == nil {
		t.Fatal("unknown agent token must be rejected")
	}
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
