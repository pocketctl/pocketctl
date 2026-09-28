package memorycontext

import (
	"encoding/json"
	"testing"
)

func TestBuildCodexInputKeepsMemoryOutOfUserInput(t *testing.T) {
	pack := &PreparedContext{PackID: "p1", StableText: "stable line", DynamicText: "dynamic line"}
	items := BuildCodexInput(pack, "user question")
	if len(items) != 1 || len(items[0]) != 2 || items[0]["type"] != "text" || items[0]["text"] != "user question" {
		t.Fatalf("turn/start must contain only unchanged user input: %v", items)
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

func TestIsCodexContextItemMatchesNativeDeveloperID(t *testing.T) {
	for _, raw := range []string{
		`{"type":"message","id":"pocketctl-memory-context:p1","role":"developer","content":[{"type":"input_text","text":"secret"}]}`,
	} {
		if !IsCodexContextItem(json.RawMessage(raw)) {
			t.Fatal("native developer item ID must identify hidden history")
		}
	}
	for _, raw := range []string{
		`{"type":"message","id":"pocketctl-memory-context:p1","role":"user","content":[{"type":"input_text","text":"<pocketctl_memory_context"}]}`,
		`{"type":"message","id":"foreign-id","role":"developer","content":[{"type":"input_text","text":"<pocketctl_memory_context"}]}`,
		`{"type":"message","id":"pocketctl-memory-contextual:p1","role":"developer","content":[]}`,
	} {
		if IsCodexContextItem(json.RawMessage(raw)) {
			t.Fatalf("ordinary history was filtered: %s", raw)
		}
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
