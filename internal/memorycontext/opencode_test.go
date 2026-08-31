package memorycontext

import "testing"

func TestBuildOpenCodeSystemRendersMarkedEnvelope(t *testing.T) {
	pack := &PreparedContext{PackID: "p9", StableText: "s-line", DynamicText: "d-line"}
	system := BuildOpenCodeSystem(pack)
	if !containsStr(system, "<pocketctl_memory_context") || !containsStr(system, "s-line") || !containsStr(system, "d-line") {
		t.Fatalf("system envelope malformed: %q", system)
	}
	if BuildOpenCodeSystem(nil) != "" || BuildOpenCodeSystem(&PreparedContext{}) != "" {
		t.Fatal("no pack must yield an empty system (legacy wire shape)")
	}
	if !IsOpenCodeSystem(system) || IsOpenCodeSystem("ordinary system prompt") {
		t.Fatal("marker detection must key on the envelope only")
	}
}
