package agentcontrol

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

const completeCodexSchema = `
initialize thread/start thread/resume thread/turns/list
turn/start turn/steer turn/interrupt
item/commandExecution/requestApproval item/fileChange/requestApproval
item/permissions/requestApproval item/tool/requestUserInput
mcpServer/elicitation/request serverRequest/resolved`

func TestCodexProbeReportsGranularCapabilities(t *testing.T) {
	probe := CodexProbe{
		Timeout: time.Second,
		Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			switch strings.Join(args, " ") {
			case "--help":
				return []byte("--remote <ADDR> --remote-auth-token-env <ENV_VAR>"), nil
			case "app-server --help":
				return []byte("--listen <URL> unix:// ws://"), nil
			default:
				t.Fatalf("unexpected args: %v", args)
				return nil, nil
			}
		},
		GenerateSchema: func(context.Context, string) ([]byte, error) {
			return []byte(completeCodexSchema), nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/opt/codex", "0.144.1")
	if err != nil {
		t.Fatal(err)
	}
	if !caps.Managed() || !caps.Core || !caps.TerminalRemote || !caps.Steer || !caps.Approvals || !caps.UserInput || !caps.MCPElicitation {
		t.Fatalf("incomplete capabilities: %+v", caps)
	}
	if caps.SchemaHash == "" {
		t.Fatal("schema hash is empty")
	}
}

func TestCodexProbeRejectsOldVersionWithoutRunningCommands(t *testing.T) {
	probe := CodexProbe{Run: func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("old version must not execute capability probes")
		return nil, nil
	}}
	caps, err := probe.Probe(context.Background(), "/opt/codex", "0.144.0")
	if !errors.Is(err, ErrCodexVersionUnsupported) {
		t.Fatalf("error=%v, want ErrCodexVersionUnsupported", err)
	}
	if caps.Managed() {
		t.Fatalf("old version reported managed: %+v", caps)
	}
}

func TestCodexProbeRequiresCoreButKeepsPartialCapabilities(t *testing.T) {
	probe := CodexProbe{
		Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) == 1 {
				return []byte("--remote <ADDR>"), nil
			}
			return []byte("--listen <URL> unix://"), nil
		},
		GenerateSchema: func(context.Context, string) ([]byte, error) {
			return []byte("initialize thread/start thread/resume turn/start turn/interrupt"), nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/opt/codex", "0.144.1")
	if !errors.Is(err, ErrCodexCapabilities) {
		t.Fatalf("error=%v, want ErrCodexCapabilities", err)
	}
	if !caps.TerminalRemote || caps.Core || caps.Managed() {
		t.Fatalf("unexpected partial capabilities: %+v", caps)
	}
}

func TestCodexProbeHonorsTimeout(t *testing.T) {
	probe := CodexProbe{
		Timeout: 20 * time.Millisecond,
		Run: func(ctx context.Context, _ string, _ ...string) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	start := time.Now()
	_, err := probe.Probe(context.Background(), "/opt/codex", "0.144.1")
	if !errors.Is(err, ErrCodexProbeTimeout) {
		t.Fatalf("error=%v, want ErrCodexProbeTimeout", err)
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("timeout took %v", elapsed)
	}
}
