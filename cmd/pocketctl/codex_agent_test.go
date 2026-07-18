package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
)

func TestAgentCodexCommandsUseCodexManager(t *testing.T) {
	manager := &fakeCodexAgentManager{status: agentcontrol.Status{
		Agent: agentcontrol.AgentCodex, Detected: true, Version: "0.144.1",
		State: agentcontrol.StateEnabled, EffectiveMode: string(agentcontrol.LaunchManaged),
		RealBinary: "/opt/codex", ShimPath: "/home/u/.pocketctl/bin/codex",
	}}
	for _, args := range [][]string{{"codex", "enable", "--no-shell-profile"}, {"codex", "status"}, {"codex", "disable"}} {
		var stdout, stderr bytes.Buffer
		if err := runAgentCommand(args, &stdout, &stderr, manager); err != nil {
			t.Fatalf("args=%v error=%v stderr=%s", args, err, stderr.String())
		}
	}
	if manager.detectAgent != agentcontrol.AgentCodex || manager.enableAgent != agentcontrol.AgentCodex || manager.disableAgent != agentcontrol.AgentCodex || manager.statusAgent != agentcontrol.AgentCodex {
		t.Fatalf("wrong manager routing: %+v", manager)
	}
}

func TestDaemonRegistersCodexProviderWithoutRestart(t *testing.T) {
	sm := session.NewSessionManager(make(chan protocol.DaemonEvent, 1))
	providers := daemonRuntimeProviders(sm)
	if providers[agentcontrol.AgentOpenCode] == nil || providers[agentcontrol.AgentCodex] == nil {
		t.Fatalf("providers=%v", providers)
	}
}

func TestAgentHelpListsCodexLifecycleCommands(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := runAgentCommand([]string{"help"}, &stdout, &stderr, &fakeCodexAgentManager{}); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"codex enable", "codex disable", "codex status", "codex help", "codex --native"} {
		if !strings.Contains(stdout.String(), command) {
			t.Fatalf("help missing %q:\n%s", command, stdout.String())
		}
	}
}

type fakeCodexAgentManager struct {
	status       agentcontrol.Status
	detectAgent  string
	enableAgent  string
	disableAgent string
	statusAgent  string
}

func (f *fakeCodexAgentManager) DetectAgent(_ context.Context, agent string) (string, string, error) {
	f.detectAgent = agent
	return "/opt/" + agent, "0.144.1", nil
}

func (f *fakeCodexAgentManager) EnableAgentDetected(_ context.Context, agent, _ string, _ agentcontrol.EnableOptions) (agentcontrol.Status, error) {
	f.enableAgent = agent
	return f.status, nil
}

func (f *fakeCodexAgentManager) DisableAgent(_ context.Context, agent string) error {
	f.disableAgent = agent
	return nil
}

func (f *fakeCodexAgentManager) StatusAgent(_ context.Context, agent string) agentcontrol.Status {
	f.statusAgent = agent
	return f.status
}
