package memorymcp

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestBoundedSelectedScopes(t *testing.T) {
	a := "11111111-1111-4111-8111-111111111111"
	b := "22222222-2222-4222-8222-222222222222"
	if got, ok := BoundedSelectedScopes([]string{a, b}); !ok || len(got) != 2 {
		t.Fatalf("valid selection rejected: %v %v", got, ok)
	}
	if _, ok := BoundedSelectedScopes(nil); ok {
		t.Fatal("empty selection must fail closed")
	}
	oversize := make([]string, MaxSelectedScopes+1)
	for i := range oversize {
		oversize[i] = fmt.Sprintf("%08d-1111-4111-8111-111111111111", i)
	}
	if _, ok := BoundedSelectedScopes(oversize); ok {
		t.Fatal("oversized selection must fail closed")
	}
	if _, ok := BoundedSelectedScopes([]string{a, a}); ok {
		t.Fatal("duplicate selection must fail closed")
	}
	if _, ok := BoundedSelectedScopes([]string{"not-a-uuid"}); ok {
		t.Fatal("malformed installation id must fail closed")
	}
}

func TestIPCGrantRequestScopeFieldSerialization(t *testing.T) {
	raw, err := json.Marshal(IpcGrantRequest{
		Type:                 "memory_mcp_grant_request",
		ScopeInstallationIDs: []string{"team-installation"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"scope_installation_ids":["team-installation"]`) {
		t.Fatalf("selected scopes missing from IPC request: %s", raw)
	}
}

func TestMemoryMcpGrantRequestScopeFieldSerialization(t *testing.T) {
	raw, err := json.Marshal(protocol.MemoryMcpGrantRequest{
		Type:                 "memory_mcp_grant",
		ScopeInstallationIDs: []string{"11111111-1111-4111-8111-111111111111"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "scope_installation_ids") {
		t.Fatalf("selection field missing from wire JSON: %s", raw)
	}
	var decoded protocol.MemoryMcpGrantRequest
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.ScopeInstallationIDs) != 1 {
		t.Fatalf("selection did not round-trip: %+v", decoded)
	}
}
