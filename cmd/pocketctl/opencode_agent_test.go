package main

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
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
	got := serviceDaemonArgs(true, "wss://relay.example/ws")
	wantParts := []string{"daemon", "start", "--foreground", "--no-agent-auto-enable", "--prod", "--relay", "wss://relay.example/ws"}
	if strings.Join(got, " ") != strings.Join(wantParts, " ") {
		t.Fatalf("args=%v want %v", got, wantParts)
	}
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
