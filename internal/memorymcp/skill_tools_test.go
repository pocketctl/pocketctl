package memorymcp

import (
	"encoding/json"
	"testing"
)

func TestSkillToolsReadOnlyAndScopeSelection(t *testing.T) {
	const installation = "12345678-1234-4123-8123-123456789012"
	for _, name := range []string{"memory_list_skills", "memory_get_skill", "memory_resolve_skill"} {
		msg := jsonRpcMessage{Method: "tools/call", Params: json.RawMessage(`{"name":"` + name + `","arguments":{"installation_id":"` + installation + `"}}`)}
		if !allowedMemoryTool(msg) {
			t.Fatalf("read tool rejected: %s", name)
		}
		scopes, err := selectedScopesForMCPMessage(msg)
		if err != nil || len(scopes) != 1 || scopes[0] != installation {
			t.Fatalf("scope not selected: %s %v", name, err)
		}
	}
	for _, name := range []string{"memory_publish_skill", "memory_execute_skill", "memory_generate_skill", "memory_replay_skill", "shell"} {
		if allowedMemoryTool(jsonRpcMessage{Method: "tools/call", Params: json.RawMessage(`{"name":"` + name + `"}`)}) {
			t.Fatalf("mutation allowed: %s", name)
		}
	}
}
