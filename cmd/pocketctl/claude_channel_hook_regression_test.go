package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDaemonStartDoesNotInjectGlobalClaudeHook freezes the Task 9 invariant
// (design §3.2): the daemon lifecycle MUST NOT call EnsureUserHook or
// RemoveUserHook. External terminal Claude sessions use the official
// Channel path; the in-process approval broker is kept only for daemon-
// owned PTYs via project-scoped EnsureHooks. A source-level scan is the
// cheapest durable guard against re-introducing the global mutation.
func TestDaemonStartDoesNotInjectGlobalClaudeHook(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	mainPath := filepath.Join(wd, "main.go")
	src, err := os.ReadFile(mainPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	for _, forbidden := range []string{"approval.EnsureUserHook", "approval.RemoveUserHook"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("main.go must not call %s — global ~/.claude/settings.json mutation "+
				"is forbidden in the daemon lifecycle (design §3.2, Task 9)", forbidden)
		}
	}
}

// TestAgentClaudeCodeEnableRunsLegacyCleanup ensures the agent.go path for
// `agent claude-code enable` references the legacy cleanup hook (so the
// one-shot idempotent migration actually runs). Design §Task 9.
func TestAgentClaudeCodeEnableRunsLegacyCleanup(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	agentPath := filepath.Join(wd, "agent.go")
	src, err := os.ReadFile(agentPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	if !strings.Contains(body, "removeLegacyClaudeUserHook") {
		t.Fatal("agent.go must wire removeLegacyClaudeUserHook into `agent claude-code enable` " +
			"so the idempotent legacy cleanup runs once per explicit enable (design §Task 9)")
	}
}
