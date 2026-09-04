package memorycontext

import "testing"

// Task 1 contract fixtures: the adapter capability matrix frozen in
// docs/plans/2026-08-26-pocketctl-memory-phase-2.md §11.3 and ADR-P2-02.
// Every adapter starts Shadow-only; native hidden delivery is only ever the
// product of a live capability probe for a probed runtime — never a version
// string, never a default.

func TestManagedCodexAppServerRequiresLiveProbe(t *testing.T) {
	if got := ResolveCapability(RuntimeCodexAppServer, ProbeSupported); got != CapabilityNativeHiddenV1 {
		t.Fatalf("managed codex app-server with supported probe: want native_hidden_v1, got %s", got)
	}
	if got := ResolveCapability(RuntimeCodexAppServer, ProbeAbsent); got != CapabilityShadowOnly {
		t.Fatalf("managed codex app-server without probe evidence: want shadow_only, got %s", got)
	}
}

func TestManagedOpenCodeServerRequiresLiveProbe(t *testing.T) {
	if got := ResolveCapability(RuntimeOpenCodeServer, ProbeSupported); got != CapabilityNativeHiddenV1 {
		t.Fatalf("managed opencode server with supported probe: want native_hidden_v1, got %s", got)
	}
	if got := ResolveCapability(RuntimeOpenCodeServer, ProbeAbsent); got != CapabilityShadowOnly {
		t.Fatalf("managed opencode server without probe evidence: want shadow_only, got %s", got)
	}
}

func TestClaudePrintResumeRequiresAppendSystemPromptProbe(t *testing.T) {
	if got := ResolveCapability(RuntimeClaudePrintResume, ProbeSupported); got != CapabilityNativeHiddenV1 {
		t.Fatalf("claude print/resume with probed --append-system-prompt: want native_hidden_v1, got %s", got)
	}
	if got := ResolveCapability(RuntimeClaudePrintResume, ProbeAbsent); got != CapabilityShadowOnly {
		t.Fatalf("claude print/resume without probe evidence: want shadow_only, got %s", got)
	}
}

func TestClaudeInteractivePTYIsAlwaysShadowOnly(t *testing.T) {
	// A probe result must never upgrade the PTY path: it has no safe hidden
	// channel in V1, so even supported probes resolve to Shadow.
	if got := ResolveCapability(RuntimeClaudePTY, ProbeSupported); got != CapabilityShadowOnly {
		t.Fatalf("claude interactive PTY with supported probe: want shadow_only, got %s", got)
	}
	if got := ResolveCapability(RuntimeClaudePTY, ProbeAbsent); got != CapabilityShadowOnly {
		t.Fatalf("claude interactive PTY without probe: want shadow_only, got %s", got)
	}
}

func TestCodexCLITerminalIsShadowOnlyInV1(t *testing.T) {
	if got := ResolveCapability(RuntimeCodexCLITerminal, ProbeSupported); got != CapabilityShadowOnly {
		t.Fatalf("codex CLI terminal in V1: want shadow_only even with probe, got %s", got)
	}
}

func TestTerminalObservedSessionsNeverEnable(t *testing.T) {
	if got := ResolveCapability(RuntimeTerminalObserved, ProbeSupported); got != CapabilityShadowOnly {
		t.Fatalf("terminal-observed session: want shadow_only (not daemon-owned), got %s", got)
	}
}

func TestUnknownAdapterStaysShadowOnly(t *testing.T) {
	if got := ResolveCapability(RuntimeUnknown, ProbeSupported); got != CapabilityShadowOnly {
		t.Fatalf("unknown adapter without a reviewed native contract: want shadow_only, got %s", got)
	}
	if got := ResolveCapability(RuntimeZCode, ProbeSupported); got != CapabilityShadowOnly {
		t.Fatalf("zcode adapter before an explicit registration: want shadow_only, got %s", got)
	}
}
