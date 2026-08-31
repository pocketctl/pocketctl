// Package memorycontext owns the daemon-side memory context coordination:
// capability resolution, grant handling, compile/admission calls, and native
// hidden-context delivery per agent adapter. Task 1 freezes only the
// capability contract; delivery adapters land in Tasks 11-14.
package memorycontext

// Runtime identifies the agent runtime a session is running on. It is a
// closed set: adapters without a reviewed native delivery contract are
// registered as RuntimeUnknown until one exists.
type Runtime string

const (
	RuntimeCodexAppServer   Runtime = "codex-app-server"
	RuntimeOpenCodeServer   Runtime = "opencode-server"
	RuntimeClaudePrintResume Runtime = "claude-print-resume"
	RuntimeClaudePTY        Runtime = "claude-pty"
	RuntimeCodexCLITerminal Runtime = "codex-cli-terminal"
	RuntimeTerminalObserved Runtime = "terminal-observed"
	RuntimeZCode            Runtime = "zcode"
	RuntimeUnknown          Runtime = "unknown"
)

// Capability is the delivery capability resolved for one runtime instance.
// CapabilityNativeHiddenV1 is only ever produced by a live capability probe
// for the exact runtime version (ADR-P2-02); every other path is Shadow.
type Capability string

const (
	CapabilityShadowOnly     Capability = "shadow_only"
	CapabilityNativeHiddenV1 Capability = "native_hidden_v1"
)

// ProbeEvidence reports whether a live capability probe for this exact
// runtime instance proved the native hidden-context channel. Probe results
// come from the adapter probes implemented in Tasks 12-14; a version string
// is never sufficient evidence.
type ProbeEvidence struct {
	supported bool
}

// ProbeAbsent is the zero evidence: no probe ran or the probe failed.
var ProbeAbsent = ProbeEvidence{supported: false}

// ProbeSupported marks evidence from a successful live probe.
var ProbeSupported = ProbeEvidence{supported: true}

// probeUpgradable runtimes may resolve to native hidden delivery with live
// probe evidence. Everything else is permanently Shadow in V1: the Claude
// interactive PTY has no safe hidden channel, terminal-observed sessions are
// not daemon-owned, and codex CLI terminal is not on the managed app-server.
var probeUpgradable = map[Runtime]bool{
	RuntimeCodexAppServer:    true,
	RuntimeOpenCodeServer:    true,
	RuntimeClaudePrintResume: true,
}

// ResolveCapability applies the frozen adapter matrix (plan §11.3): probe
// evidence upgrades only the three managed runtimes; all other runtimes stay
// Shadow-only regardless of any probe result.
func ResolveCapability(runtime Runtime, probe ProbeEvidence) Capability {
	if probe.supported && probeUpgradable[runtime] {
		return CapabilityNativeHiddenV1
	}
	return CapabilityShadowOnly
}
