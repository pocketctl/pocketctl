package usageanalytics

import "testing"

func TestClaudeNative(t *testing.T) {
	if ClaudeCall("i", "mcp__server__tool", "", "").ToolKind != "mcp" {
		t.Fatal("mcp")
	}
	for _, name := range []string{"Read", "Skill", "server/tool", "SKILL.md"} {
		if ClaudeCall("i", name, "", "").EvidenceKind != "claude_native_tool" {
			t.Fatal(name)
		}
	}
	if ClaudeCall("", "Read", "", "") != nil {
		t.Fatal("missing id")
	}
}
