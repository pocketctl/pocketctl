package memorycontext

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// ClaudeDelivery: one-shot print/resume only, via a probed
// --append-system-prompt flag (plan 11.3). Interactive PTY stays Shadow.
// The pack never enters the visible prompt, any config file, or telemetry.

// ProbeClaudeAppendSystemPrompt reports whether the local claude binary
// documents --append-system-prompt for print mode. A version string is
// never sufficient evidence.
func ProbeClaudeAppendSystemPrompt(helpOutput string) bool {
	for _, line := range strings.Split(helpOutput, "\n") {
		if strings.Contains(line, "--append-system-prompt") {
			return true
		}
	}
	return false
}

// ProbeClaudeRuntime executes the exact resolved CLI binary under a short
// deadline. Only live help output documenting the hidden system channel is
// accepted as capability evidence; every execution or parsing failure is
// Shadow-only.
func ProbeClaudeRuntime(parent context.Context, binary string) ProbeEvidence {
	out, err := claudeHelp(parent, binary)
	if err != nil || !ProbeClaudeAppendSystemPrompt(out) {
		return ProbeAbsent
	}
	return ProbeSupported
}

func claudeHelp(parent context.Context, binary string) (string, error) {
	if strings.TrimSpace(binary) == "" {
		return "", fmt.Errorf("claude_context_probe_unavailable")
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binary, "--help").Output()
	if err != nil || len(out) > 256<<10 {
		return "", fmt.Errorf("claude_context_probe_unavailable")
	}
	return string(out), nil
}

// ClaudeContextRefreshArgs disables the native system-prompt snapshot when the
// exact CLI supports it. Otherwise resume can silently reuse the first Call's
// frozen context even though --append-system-prompt contains the current one.
// Older runtimes without this flag retain their original argument contract.
// Probe errors stop dispatch: they must not silently enable a stale snapshot.
func ClaudeContextRefreshArgs(ctx context.Context, binary string) ([]string, error) {
	help, err := claudeHelp(ctx, binary)
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(help, "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == "--system-prompt-snapshot" {
			return []string{"--system-prompt-snapshot", "off"}, nil
		}
	}
	return nil, nil
}

// AppendClaudeSystemPrompt returns the flag pair for a probed runtime; an
// unprobed runtime gets no flags (Shadow-only path).
func AppendClaudeSystemPrompt(args []string, pack *PreparedContext) []string {
	if pack == nil || (pack.StableText == "" && pack.DynamicText == "") {
		return args
	}
	return append(args, "--append-system-prompt", RenderCodexEnvelope(pack))
}

// RedactClaudeCommand prepares a process-arguments string for bounded
// telemetry: pack text carried in CLI args is dropped entirely.
func RedactClaudeCommand(args []string) string {
	redacted := make([]string, 0, len(args))
	skipNext := false
	for _, arg := range args {
		if skipNext {
			redacted = append(redacted, "[context]")
			skipNext = false
			continue
		}
		if arg == "--append-system-prompt" {
			redacted = append(redacted, arg)
			skipNext = true
			continue
		}
		redacted = append(redacted, arg)
	}
	return strings.Join(redacted, " ")
}
