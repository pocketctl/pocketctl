package adapter

import (
	"testing"
)

// TestRegistryContainsAllAgents verifies the registry holds the four known
// agent types (claude-code, codex, opencode, zcode) and that the three existing
// agents are unchanged by the zcode addition.
func TestRegistryContainsAllAgents(t *testing.T) {
	t.Parallel()

	want := map[string]bool{
		AgentClaude:   false,
		AgentCodex:    false,
		AgentOpencode: false,
		AgentZcode:    false,
	}
	for _, p := range All() {
		if _, ok := want[p.Type]; ok {
			want[p.Type] = true
		}
	}
	for agent, seen := range want {
		if !seen {
			t.Fatalf("agent %q missing from registry All()", agent)
		}
	}
}

// TestExistingAgentsUnchangedByZcode guards that registering zcode did not alter
// the three pre-existing providers' identity, backend, or discovery kind.
func TestExistingAgentsUnchangedByZcode(t *testing.T) {
	t.Parallel()

	claude, ok := Get(AgentClaude)
	if !ok {
		t.Fatal("claude-code not registered")
	}
	if claude.CLIName != "claude" || claude.Package != "@anthropic-ai/claude-code" {
		t.Fatalf("claude identity changed: %+v", claude)
	}
	if claude.Backend != BackendSubprocess || claude.Discovery != DiscoveryCLI {
		t.Fatalf("claude backend/discovery changed: backend=%v discovery=%v", claude.Backend, claude.Discovery)
	}

	codex, ok := Get(AgentCodex)
	if !ok {
		t.Fatal("codex not registered")
	}
	if codex.CLIName != "codex" || codex.Package != "@openai/codex" {
		t.Fatalf("codex identity changed: %+v", codex)
	}
	if codex.Backend != BackendSubprocess || codex.Discovery != DiscoveryCLI {
		t.Fatalf("codex backend/discovery changed: backend=%v discovery=%v", codex.Backend, codex.Discovery)
	}

	opencode, ok := Get(AgentOpencode)
	if !ok {
		t.Fatal("opencode not registered")
	}
	if opencode.CLIName != "opencode" || opencode.Package != "opencode-ai" {
		t.Fatalf("opencode identity changed: %+v", opencode)
	}
	if opencode.Backend != BackendServer || opencode.Discovery != DiscoveryCLI {
		t.Fatalf("opencode backend/discovery changed: backend=%v discovery=%v", opencode.Backend, opencode.Discovery)
	}
}
