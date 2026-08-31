package memorycontext

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestProbeClaudeAppendSystemPromptRequiresHelpEvidence(t *testing.T) {
	if ProbeClaudeAppendSystemPrompt("--help output without the flag") {
		t.Fatal("must not infer support without the documented flag")
	}
	if !ProbeClaudeAppendSystemPrompt("  --append-system-prompt <prompt>  Append") {
		t.Fatal("documented flag must be recognized")
	}
}

func TestProbeClaudeRuntimeExecutesExactBinaryHelp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix fixture")
	}
	dir := t.TempDir()
	supported := filepath.Join(dir, "claude-supported")
	unsupported := filepath.Join(dir, "claude-unsupported")
	if err := os.WriteFile(supported, []byte("#!/bin/sh\nprintf '%s\\n' '  --append-system-prompt <prompt>'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unsupported, []byte("#!/bin/sh\nprintf '%s\\n' 'usage: claude'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ResolveCapability(RuntimeClaudePrintResume, ProbeClaudeRuntime(context.Background(), supported)); got != CapabilityNativeHiddenV1 {
		t.Fatalf("supported exact runtime capability=%s", got)
	}
	if got := ResolveCapability(RuntimeClaudePrintResume, ProbeClaudeRuntime(context.Background(), unsupported)); got != CapabilityShadowOnly {
		t.Fatalf("unsupported exact runtime capability=%s", got)
	}
}

func TestAppendClaudeSystemPromptGuardsPackAndOrdering(t *testing.T) {
	base := []string{"-p", "question"}
	withPack := AppendClaudeSystemPrompt(base, &PreparedContext{StableText: "s"})
	if withPack[0] != "-p" || withPack[1] != "question" {
		t.Fatalf("visible prompt must stay first and unchanged: %v", withPack)
	}
	if withPack[2] != "--append-system-prompt" {
		t.Fatalf("flag must follow the prompt: %v", withPack)
	}
	if got := AppendClaudeSystemPrompt(base, nil); len(got) != 2 {
		t.Fatalf("no pack must keep legacy args: %v", got)
	}
}

func TestRedactClaudeCommandDropsPackText(t *testing.T) {
	cmd := RedactClaudeCommand([]string{"claude", "-p", "q", "--append-system-prompt", "SECRET-PACK"})
	for _, token := range []string{"SECRET-PACK"} {
		if containsStr(cmd, token) {
			t.Fatalf("pack text leaked into telemetry: %s", cmd)
		}
	}
	if !containsStr(cmd, "[context]") {
		t.Fatalf("redaction marker missing: %s", cmd)
	}
}
