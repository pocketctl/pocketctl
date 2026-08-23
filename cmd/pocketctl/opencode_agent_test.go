package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/platform"
	"github.com/pocketctl/pocketctl/internal/session"
)

func TestAgentHelpListsOpenCodeLifecycleCommands(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := runAgentCommand([]string{"help"}, &stdout, &stderr, &fakeAgentManager{}); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"opencode enable", "opencode disable", "opencode status", "opencode help", "--native"} {
		if !strings.Contains(stdout.String(), command) {
			t.Fatalf("help missing %q:\n%s", command, stdout.String())
		}
	}
}

func TestDaemonAgentPromptContextOnlyInteractiveParentCanPrompt(t *testing.T) {
	interactive := os.FileMode(os.ModeCharDevice)
	tests := []struct {
		name        string
		noPrompt    bool
		restartFile string
		child       bool
		mode        os.FileMode
		wantTTY     bool
		wantSkip    bool
	}{
		{"interactive parent", false, "", false, interactive, true, false},
		{"no tty", false, "", false, 0, false, false},
		{"flag", true, "", false, interactive, true, true},
		{"restart", false, "/tmp/ready", false, interactive, true, true},
		{"child", false, "", true, interactive, true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := daemonAgentPromptContext(tt.noPrompt, tt.restartFile, tt.child, tt.mode)
			if got.IsTTY != tt.wantTTY {
				t.Fatalf("IsTTY=%v want %v", got.IsTTY, tt.wantTTY)
			}
			skipped := got.NoAgentPrompt || got.IsRestart || got.IsDaemonChild
			if skipped != tt.wantSkip {
				t.Fatalf("skip=%v context=%+v", skipped, got)
			}
		})
	}
}

func TestServiceDaemonArgsAlwaysDisableBackgroundAgentAutoEnable(t *testing.T) {
	got := serviceDaemonArgs(true, "wss://relay.example/ws", "")
	wantParts := []string{"daemon", "start", "--foreground", "--no-agent-auto-enable", "--prod", "--relay", "wss://relay.example/ws"}
	if strings.Join(got, " ") != strings.Join(wantParts, " ") {
		t.Fatalf("args=%v want %v", got, wantParts)
	}
}

func TestServiceDaemonArgsPersistsTrustedActionPolicy(t *testing.T) {
	got := serviceDaemonArgs(false, "ws://127.0.0.1:8080/ws", "observe")
	want := []string{
		"daemon", "start", "--foreground", "--no-agent-auto-enable",
		"--relay", "ws://127.0.0.1:8080/ws",
		"--trusted-action-policy", "observe",
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("args=%v want %v", got, want)
	}
}

func TestValidateTrustedActionPolicyFlagRejectsUnknownMode(t *testing.T) {
	for _, raw := range []string{"", "off", " OBSERVE ", "ON"} {
		got, err := validateTrustedActionPolicyFlag(raw)
		if err != nil {
			t.Fatalf("validateTrustedActionPolicyFlag(%q): %v", raw, err)
		}
		if raw == " OBSERVE " && got != "observe" {
			t.Fatalf("normalized mode=%q want observe", got)
		}
		if raw == "ON" && got != "on" {
			t.Fatalf("normalized mode=%q want on", got)
		}
	}
	if _, err := validateTrustedActionPolicyFlag("sometimes"); err == nil {
		t.Fatal("unknown trusted action policy mode was accepted")
	}
}

func TestEffectiveTrustedActionPolicyUsesExplicitThenEnvironmentThenOff(t *testing.T) {
	t.Setenv("POCKETCTL_TRUSTED_ACTION_POLICY_V1", " ON ")
	if got := effectiveTrustedActionPolicy("observe"); got != "observe" {
		t.Fatalf("explicit effective policy=%q want observe", got)
	}
	if got := effectiveTrustedActionPolicy(""); got != "on" {
		t.Fatalf("environment effective policy=%q want on", got)
	}
	t.Setenv("POCKETCTL_TRUSTED_ACTION_POLICY_V1", "invalid")
	if got := effectiveTrustedActionPolicy(""); got != "off" {
		t.Fatalf("invalid inherited policy=%q want fail-closed off", got)
	}
}

func TestDaemonServiceOptionsPreservesPath(t *testing.T) {
	pathEnv := "/opt/homebrew/bin:/usr/bin:/bin"
	daemonArgs := serviceDaemonArgs(false, "", "")
	got := daemonServiceOptions("/usr/local/bin/pocketctl", "/tmp/pocketctl.log", daemonArgs, pathEnv)
	if got.PathEnv != pathEnv {
		t.Fatalf("PATH=%q want %q", got.PathEnv, pathEnv)
	}
	if !strings.Contains(strings.Join(got.Args, " "), "--no-agent-auto-enable") {
		t.Fatalf("args=%v missing --no-agent-auto-enable", got.Args)
	}
}

func TestServiceInstallPassesCanonicalSecurityPolicyToSupervisor(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := config.SaveAuth("wss://relay.example/ws", "test-access-token", "test-refresh-token"); err != nil {
		t.Fatalf("SaveAuth: %v", err)
	}

	root := filepath.Join(home, "allowed root")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}

	capture := &capturingServiceManager{}
	previous := serviceMgr
	serviceMgr = capture
	t.Cleanup(func() { serviceMgr = previous })

	cmdServiceInstall([]string{
		"--relay", "wss://relay.example/ws",
		"--no-agent-auto-enable",
		"--allowed-cwd-root", root,
		"--allow-dangerous-remote-permissions",
	})

	want := []string{
		"daemon", "start", "--foreground", "--no-agent-auto-enable",
		"--relay", "wss://relay.example/ws",
		"--allowed-cwd-root", canonicalRoot,
		"--allow-dangerous-remote-permissions",
	}
	if !reflect.DeepEqual(capture.installed.Args, want) {
		t.Fatalf("installed service argv=%q want %q", capture.installed.Args, want)
	}
}

func TestPersistDaemonSecurityPolicyStoresEffectiveCanonicalPolicy(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, "workspace")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(home, "workspace-link")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}

	policy, err := session.NewCwdPolicy([]string{alias})
	if err != nil {
		t.Fatalf("NewCwdPolicy: %v", err)
	}
	if err := persistDaemonSecurityPolicy(policy, true, "on"); err != nil {
		t.Fatalf("persistDaemonSecurityPolicy: %v", err)
	}
	wantRoots := []string{canonicalRoot}
	if !reflect.DeepEqual(policy.Roots(), wantRoots) {
		t.Fatalf("effective roots=%q want %q", policy.Roots(), wantRoots)
	}
	persisted, err := config.LoadDaemonSecurityPolicy()
	if err != nil {
		t.Fatalf("LoadDaemonSecurityPolicy: %v", err)
	}
	want := config.DaemonSecurityPolicy{
		AllowedCwdRoots:                 wantRoots,
		AllowDangerousRemotePermissions: true,
		TrustedActionPolicy:             "on",
	}
	if !reflect.DeepEqual(persisted, want) {
		t.Fatalf("persisted policy=%+v want %+v", persisted, want)
	}
}

type capturingServiceManager struct {
	installed platform.ServiceOpts
}

func (m *capturingServiceManager) Install(opts platform.ServiceOpts) error {
	m.installed = opts
	return nil
}

func (m *capturingServiceManager) Uninstall() error { return nil }

func (m *capturingServiceManager) Status() (platform.ServiceStatus, error) {
	return platform.ServiceStatus{Installed: true, UnitPath: "/tmp/pocketctl.service"}, nil
}

func TestDaemonAgentAutoEnableContextOnlyUserParentCanMutate(t *testing.T) {
	tests := []struct {
		name        string
		skip        bool
		restartFile string
		child       bool
		wantSkip    bool
	}{
		{"user parent", false, "", false, false},
		{"flag", true, "", false, true},
		{"restart", false, "/tmp/ready", false, true},
		{"child", false, "", true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := daemonAgentAutoEnableContext(tt.skip, tt.restartFile, tt.child)
			if skipped := got.Skip || got.IsRestart || got.IsDaemonChild; skipped != tt.wantSkip {
				t.Fatalf("skip=%v context=%+v", skipped, got)
			}
		})
	}
}

func TestDaemonAgentStartupLinesIncludeVersionAndEnableResult(t *testing.T) {
	statuses := []agentcontrol.Status{
		{Agent: agentcontrol.AgentOpenCode, Detected: true, Version: "1.18.3", State: agentcontrol.StateEnabled},
		{Agent: agentcontrol.AgentCodex, Detected: true, Version: "0.144.6", State: agentcontrol.StateUndecided},
	}
	result := agentcontrol.AutoEnableResult{Warnings: []agentcontrol.AutoEnableWarning{{Agent: agentcontrol.AgentCodex, Err: context.DeadlineExceeded}}}
	output := strings.Join(daemonAgentStartupLines(statuses, result, false), "\n")
	for _, want := range []string{"opencode", "1.18.3", "successful", "codex", "0.144.6", "failed", context.DeadlineExceeded.Error()} {
		if !strings.Contains(output, want) {
			t.Fatalf("startup status missing %q:\n%s", want, output)
		}
	}
}

func TestDaemonAgentStartupLinesDistinguishDisabledAndSkipped(t *testing.T) {
	statuses := []agentcontrol.Status{
		{Agent: agentcontrol.AgentOpenCode, State: agentcontrol.StateDisabled},
		{Agent: agentcontrol.AgentCodex, State: agentcontrol.StateUndecided},
	}
	output := strings.Join(daemonAgentStartupLines(statuses, agentcontrol.AutoEnableResult{}, true), "\n")
	for _, want := range []string{"disabled", "skipped"} {
		if !strings.Contains(output, want) {
			t.Fatalf("startup status missing %q:\n%s", want, output)
		}
	}
}

func TestAgentOpenCodeCommandsCallManager(t *testing.T) {
	manager := &fakeAgentManager{status: agentcontrol.Status{Detected: true, State: agentcontrol.StateEnabled, RealBinary: "/opt/opencode", ShimPath: "/home/u/.pocketctl/bin/opencode", PathActive: true}}
	for _, args := range [][]string{{"opencode", "enable", "--no-shell-profile"}, {"opencode", "status"}, {"opencode", "disable"}} {
		var stdout, stderr bytes.Buffer
		if err := runAgentCommand(args, &stdout, &stderr, manager); err != nil {
			t.Fatalf("args=%v error=%v stderr=%s", args, err, stderr.String())
		}
	}
	if manager.enableCalls != 1 || !manager.noShellProfile || manager.disableCalls != 1 || manager.statusCalls != 1 {
		t.Fatalf("manager=%+v", manager)
	}
}

func TestAgentOpenCodeStatusContainsRequiredFields(t *testing.T) {
	manager := &fakeAgentManager{status: agentcontrol.Status{Detected: true, State: agentcontrol.StateDisabled, RealBinary: "/opt/opencode", ShimPath: "/shim", PathActive: false, RuntimeReachable: false}}
	var stdout, stderr bytes.Buffer
	if err := runAgentCommand([]string{"opencode", "status"}, &stdout, &stderr, manager); err != nil {
		t.Fatal(err)
	}
	for _, label := range []string{"Detected:", "State:", "Real binary:", "Launcher:", "PATH active:", "Runtime reachable:"} {
		if !strings.Contains(stdout.String(), label) {
			t.Fatalf("status missing %q:\n%s", label, stdout.String())
		}
	}
}

type fakeAgentManager struct {
	status         agentcontrol.Status
	enableCalls    int
	disableCalls   int
	statusCalls    int
	noShellProfile bool
}

func (f *fakeAgentManager) Detect(context.Context) (string, string, error) { return "", "", nil }
func (f *fakeAgentManager) EnableDetected(_ context.Context, _ string, options agentcontrol.EnableOptions) (agentcontrol.Status, error) {
	f.enableCalls++
	f.noShellProfile = options.NoShellProfile
	return f.status, nil
}
func (f *fakeAgentManager) Disable(context.Context) error { f.disableCalls++; return nil }
func (f *fakeAgentManager) Status(context.Context) agentcontrol.Status {
	f.statusCalls++
	return f.status
}
