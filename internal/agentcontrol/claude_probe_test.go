package agentcontrol

import (
	"context"
	"errors"
	"testing"
	"time"
)

const completeClaudeManifest = `{
  "shared_authority": true,
  "independent_subscription": true,
  "send_steer_interrupt": true,
  "pending_approvals": true,
  "first_writer_resolved": true,
  "reattach_after_restart": true
}`

func TestClaudeProbeDoesNotPromoteRemoteControlHelpToManaged(t *testing.T) {
	probe := ClaudeProbe{
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte("--remote-control --input-format stream-json --resume"), nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/opt/claude", "2.1.198")
	if !errors.Is(err, ErrClaudeManagedCapabilities) {
		t.Fatalf("error=%v want ErrClaudeManagedCapabilities", err)
	}
	if caps.Managed() || !caps.RemoteControlAdvertised || !caps.StreamJSONInput || !caps.Resume {
		t.Fatalf("unexpected partial capabilities: %+v", caps)
	}
}

func TestClaudeProbeAcceptsOnlyCompleteMachineReadableManifest(t *testing.T) {
	probe := ClaudeProbe{
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte("--remote-control --input-format stream-json --resume"), nil
		},
		Manifest: func(context.Context, string) ([]byte, error) {
			return []byte(completeClaudeManifest), nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/opt/claude", "future")
	if err != nil {
		t.Fatal(err)
	}
	if !caps.Managed() || caps.Version != "future" {
		t.Fatalf("managed capabilities=%+v", caps)
	}
}

func TestClaudeProbeRejectsPartialManifest(t *testing.T) {
	probe := ClaudeProbe{
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte("--remote-control"), nil
		},
		Manifest: func(context.Context, string) ([]byte, error) {
			return []byte(`{"shared_authority":true}`), nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/opt/claude", "future")
	if !errors.Is(err, ErrClaudeManagedCapabilities) || caps.Managed() {
		t.Fatalf("caps=%+v err=%v", caps, err)
	}
}

func TestClaudeProbeHonorsTimeout(t *testing.T) {
	probe := ClaudeProbe{
		Timeout: 20 * time.Millisecond,
		Run: func(ctx context.Context, _ string, _ ...string) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	_, err := probe.Probe(context.Background(), "/opt/claude", "2.1.198")
	if !errors.Is(err, ErrClaudeProbeTimeout) {
		t.Fatalf("error=%v want ErrClaudeProbeTimeout", err)
	}
}
