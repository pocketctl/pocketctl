package main

import (
	"context"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
)

// fakeMultiAgentManager is a test double that implements the
// MultiAgentManager interface. It is the multi-agent counterpart of
// fakeAgentManager (which only implements the legacy Manager interface).
type fakeMultiAgentManager struct {
	status         agentcontrol.Status
	enableCalls    int
	disableCalls   int
	statusCalls    int
	noShellProfile bool
	lastAgent      string
}

func (f *fakeMultiAgentManager) DetectAgent(_ context.Context, agent string) (string, string, error) {
	f.lastAgent = agent
	return "/fake/" + agent, "9.9.9", nil
}

func (f *fakeMultiAgentManager) EnableAgentDetected(_ context.Context, agent, _ string, options agentcontrol.EnableOptions) (agentcontrol.Status, error) {
	f.enableCalls++
	f.lastAgent = agent
	f.noShellProfile = options.NoShellProfile
	return f.status, nil
}

func (f *fakeMultiAgentManager) DisableAgent(_ context.Context, agent string) error {
	f.disableCalls++
	f.lastAgent = agent
	return nil
}

func (f *fakeMultiAgentManager) StatusAgent(_ context.Context, agent string) agentcontrol.Status {
	f.statusCalls++
	f.lastAgent = agent
	return f.status
}
