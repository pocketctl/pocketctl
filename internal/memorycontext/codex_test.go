package memorycontext

import (
	"encoding/json"
	"testing"
)

func TestBuildCodexInputOrdersDeveloperBeforeUser(t *testing.T) {
	pack := &PreparedContext{PackID: "p1", StableText: "stable line", DynamicText: "dynamic line"}
	items := BuildCodexInput(pack, "user question")
	if len(items) != 2 {
		t.Fatalf("want 2 items, got %d", len(items))
	}
	first := items[0]
	if first["role"] != "developer" || first["tag"] != CodexDeveloperItemTag {
		t.Fatalf("first item must be the tagged developer item: %v", first)
	}
	if items[1]["text"] != "user question" {
		t.Fatalf("user text must be unchanged: %v", items[1])
	}
	envelope := first["text"].(string)
	if !containsStr(envelope, "<pocketctl_memory_context") || !containsStr(envelope, "stable line") {
		t.Fatalf("envelope malformed: %q", envelope)
	}
}

func TestBuildCodexInputWithoutPackIsLegacyShape(t *testing.T) {
	items := BuildCodexInput(nil, "hello")
	if len(items) != 1 || items[0]["text"] != "hello" {
		t.Fatalf("no pack must keep the legacy single item: %v", items)
	}
}

func TestIsCodexContextItemMatchesExplicitTagOnly(t *testing.T) {
	synthetic, _ := json.Marshal(map[string]string{"type": "text", "role": "developer", "tag": CodexDeveloperItemTag, "text": "x"})
	if !IsCodexContextItem(synthetic) {
		t.Fatal("tagged developer item must be recognized")
	}
	userItem, _ := json.Marshal(map[string]string{"type": "text", "text": "<pocketctl_memory_context"})
	if IsCodexContextItem(userItem) {
		t.Fatal("plain user text must never be filtered, even with the marker")
	}
}


func containsStr(h, n string) bool {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return true
		}
	}
	return false
}
