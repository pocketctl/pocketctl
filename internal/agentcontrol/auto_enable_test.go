package agentcontrol

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestAutoEnableAgentsEnablesCompatibleUndecidedAgents(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := &fakeMultiAgentManager{
		detected: map[string]detectedAgent{
			AgentOpenCode: {path: "/opt/opencode", version: "1.17.11"},
			AgentCodex:    {path: "/opt/codex", version: "0.144.1"},
		},
	}
	var out bytes.Buffer
	result := AutoEnableAgents(context.Background(), &out, AutoEnableContext{}, manager)
	if len(result.Enabled) != 2 || len(result.Warnings) != 0 {
		t.Fatalf("result=%+v output=%q", result, out.String())
	}
	if manager.enableCalls[AgentOpenCode] != 1 || manager.enableCalls[AgentCodex] != 1 {
		t.Fatalf("enable calls=%v", manager.enableCalls)
	}
}

func TestAutoEnableAgentsRespectsDisabledAndNeverBlocksOnFailures(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := DefaultConfig()
	cfg.OpenCode.State = StateDisabled
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	manager := &fakeMultiAgentManager{
		detected: map[string]detectedAgent{
			AgentCodex: {err: ErrCodexNotFound},
		},
	}
	var out bytes.Buffer
	result := AutoEnableAgents(context.Background(), &out, AutoEnableContext{}, manager)
	if manager.detectCalls[AgentOpenCode] != 0 || manager.enableCalls[AgentOpenCode] != 0 {
		t.Fatalf("disabled OpenCode was touched: detect=%v enable=%v", manager.detectCalls, manager.enableCalls)
	}
	if len(result.Warnings) != 1 || !errors.Is(result.Warnings[0].Err, ErrCodexNotFound) {
		t.Fatalf("result=%+v", result)
	}
	if !strings.Contains(out.String(), "codex") {
		t.Fatalf("warning does not identify Codex: %q", out.String())
	}
	loaded, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Codex.State != StateUndecided {
		t.Fatalf("failed detection changed desired state: %+v", loaded.Codex)
	}
}

func TestAutoEnableAgentsSkipsDaemonChildrenAndRestartHandoffs(t *testing.T) {
	for _, context := range []AutoEnableContext{{Skip: true}, {IsDaemonChild: true}, {IsRestart: true}} {
		t.Run(strings.ReplaceAll(strings.TrimSpace(strings.Join([]string{
			boolName(context.Skip, "skip"),
			boolName(context.IsDaemonChild, "child"),
			boolName(context.IsRestart, "restart"),
		}, "-")), "--", "-"), func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			manager := &fakeMultiAgentManager{}
			result := AutoEnableAgents(contextpkg(), &bytes.Buffer{}, context, manager)
			if len(result.Enabled) != 0 || len(result.Warnings) != 0 || len(manager.detectCalls) != 0 {
				t.Fatalf("result=%+v manager=%+v", result, manager)
			}
		})
	}
}

func TestAutoEnableAgentsWarnsWhenEnabledCodexWasDowngraded(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := DefaultConfig()
	cfg.Codex.State = StateEnabled
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	manager := &fakeMultiAgentManager{
		detected: map[string]detectedAgent{
			AgentOpenCode: {err: ErrOpenCodeNotFound},
			AgentCodex:    {path: "/opt/codex", version: "0.144.0"},
		},
		status: map[string]Status{
			AgentCodex: {Agent: AgentCodex, State: StateEnabled, CapabilityReason: "Codex 0.144.0 is older than 0.144.1"},
		},
	}
	result := AutoEnableAgents(context.Background(), &bytes.Buffer{}, AutoEnableContext{}, manager)
	if len(result.Warnings) != 2 {
		t.Fatalf("warnings=%+v", result.Warnings)
	}
	if manager.enableCalls[AgentCodex] != 0 {
		t.Fatalf("downgraded Codex was re-enabled: %v", manager.enableCalls)
	}
	loaded, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Codex.State != StateEnabled {
		t.Fatalf("desired enabled state was lost: %+v", loaded.Codex)
	}
}

func contextpkg() context.Context { return context.Background() }

func boolName(value bool, name string) string {
	if value {
		return name
	}
	return ""
}

type detectedAgent struct {
	path    string
	version string
	err     error
}

type fakeMultiAgentManager struct {
	detected    map[string]detectedAgent
	detectCalls map[string]int
	enableCalls map[string]int
	enableErr   map[string]error
	status      map[string]Status
}

func (f *fakeMultiAgentManager) DetectAgent(_ context.Context, agent string) (string, string, error) {
	if f.detectCalls == nil {
		f.detectCalls = map[string]int{}
	}
	f.detectCalls[agent]++
	result := f.detected[agent]
	return result.path, result.version, result.err
}

func (f *fakeMultiAgentManager) EnableAgentDetected(_ context.Context, agent, _ string, _ EnableOptions) (Status, error) {
	if f.enableCalls == nil {
		f.enableCalls = map[string]int{}
	}
	f.enableCalls[agent]++
	return Status{Agent: agent, State: StateEnabled}, f.enableErr[agent]
}

func (f *fakeMultiAgentManager) DisableAgent(context.Context, string) error { return nil }

func (f *fakeMultiAgentManager) StatusAgent(_ context.Context, agent string) Status {
	return f.status[agent]
}
