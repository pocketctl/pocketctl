package adapter

import (
	"errors"
	"testing"
)

// TestZcodeProviderRegistration verifies the zcode provider is registered with
// the observer backend/storage discovery, no CLI/package/update, and that the
// factory helpers do NOT fall back to a Claude-backed launcher/storage.
func TestZcodeProviderRegistration(t *testing.T) {
	t.Parallel()

	p, ok := Get(AgentZcode)
	if !ok {
		t.Fatalf("Get(%q) = false, want true (zcode must be registered)", AgentZcode)
	}
	if p.Type != AgentZcode {
		t.Fatalf("Provider.Type = %q, want %q", p.Type, AgentZcode)
	}
	if p.Backend != BackendObserver {
		t.Fatalf("Provider.Backend = %v, want BackendObserver", p.Backend)
	}
	if p.Discovery != DiscoveryStorage {
		t.Fatalf("Provider.Discovery = %v, want DiscoveryStorage", p.Discovery)
	}
	if p.CLIName != "" {
		t.Fatalf("Provider.CLIName = %q, want empty (no ZCode CLI launch)", p.CLIName)
	}
	if p.Package != "" {
		t.Fatalf("Provider.Package = %q, want empty (no npm queries for ZCode)", p.Package)
	}
	if p.UpdateCmd != "" {
		t.Fatalf("Provider.UpdateCmd = %q, want empty (ZCode not manageable)", p.UpdateCmd)
	}
}

// TestZcodeBackendKindNotSubprocess ensures BackendKindFor never routes zcode
// into the subprocess spawn path.
func TestZcodeBackendKindNotSubprocess(t *testing.T) {
	t.Parallel()

	if got := BackendKindFor(AgentZcode); got != BackendObserver {
		t.Fatalf("BackendKindFor(%q) = %v, want BackendObserver", AgentZcode, got)
	}
}

// TestZcodeFactoryHelpersFailClosed verifies that the factory helpers invoked by
// generic callers do NOT silently fall back to a Claude-backed launcher/storage
// for zcode. Each must return a fail-closed sentinel that surfaces
// ErrObserverReadOnly so callers can never start or drive a ZCode session.
func TestZcodeFactoryHelpersFailClosed(t *testing.T) {
	t.Parallel()

	if _, err := NewStorageTyped(AgentZcode); !errors.Is(err, ErrObserverReadOnly) {
		t.Fatalf("NewStorageTyped(zcode) err = %v, want ErrObserverReadOnly", err)
	}
	if _, err := NewLauncherTyped(AgentZcode); !errors.Is(err, ErrObserverReadOnly) {
		t.Fatalf("NewLauncherTyped(zcode) err = %v, want ErrObserverReadOnly", err)
	}
	if _, err := NewAdapterTyped(AgentZcode, ""); !errors.Is(err, ErrObserverReadOnly) {
		t.Fatalf("NewAdapterTyped(zcode) err = %v, want ErrObserverReadOnly", err)
	}
	if _, err := NewParserTyped(AgentZcode); !errors.Is(err, ErrObserverReadOnly) {
		t.Fatalf("NewParserTyped(zcode) err = %v, want ErrObserverReadOnly", err)
	}
}

// TestZcodeAgentConstant pins the canonical agent type string.
func TestZcodeAgentConstant(t *testing.T) {
	t.Parallel()

	if AgentZcode != "zcode" {
		t.Fatalf("AgentZcode = %q, want %q", AgentZcode, "zcode")
	}
}

// TestBackendObserverDistinctFromOthers ensures BackendObserver is a distinct
// value, not accidentally equal to Subprocess/Server.
func TestBackendObserverDistinctFromOthers(t *testing.T) {
	t.Parallel()

	if BackendObserver == BackendSubprocess || BackendObserver == BackendServer {
		t.Fatalf("BackendObserver must be distinct from Subprocess(%v)/Server(%v)", BackendSubprocess, BackendServer)
	}
}

// TestDiscoveryKindValues pins the discovery kind enum and that the three
// subprocess/server agents remain DiscoveryCLI.
func TestDiscoveryKindValues(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		agent string
		want  DiscoveryKind
	}{
		{AgentClaude, DiscoveryCLI},
		{AgentCodex, DiscoveryCLI},
		{AgentOpencode, DiscoveryCLI},
		{AgentZcode, DiscoveryStorage},
	} {
		p, ok := Get(tt.agent)
		if !ok {
			t.Fatalf("Get(%q) = false, want true", tt.agent)
		}
		if p.Discovery != tt.want {
			t.Fatalf("Provider(%q).Discovery = %v, want %v", tt.agent, p.Discovery, tt.want)
		}
	}
}
