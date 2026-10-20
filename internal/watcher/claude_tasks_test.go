package watcher

import (
	"github.com/pocketctl/pocketctl/internal/adapter"
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeTailFromEndRestoresTaskStateWithoutReplayingHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.jsonl")
	prefix := `{"type":"assistant","sessionId":"s","message":{"content":[{"type":"tool_use","id":"c1","name":"TaskCreate","input":{"subject":"A"}}]}}
{"type":"user","sessionId":"s","toolUseResult":{"task":{"id":"1","subject":"A"}},"message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"created"}]}}
`
	if err := os.WriteFile(path, []byte(prefix), 0600); err != nil {
		t.Fatal(err)
	}
	tailer, err := NewJSONLTailer(path, adapter.AgentClaude)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	_, err = f.WriteString(`{"type":"assistant","sessionId":"s","message":{"content":[{"type":"tool_use","id":"c2","name":"TaskUpdate","input":{"taskId":"1","status":"completed"}}]}}
{"type":"user","sessionId":"s","toolUseResult":{"success":true,"taskId":"1"},"message":{"content":[{"type":"tool_result","tool_use_id":"c2","content":"updated"}]}}
`)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	events, _, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, event := range events {
		if event.Type == "agent_plan" {
			count++
			if event.Plan[0].Status != "completed" {
				t.Fatal("stale state")
			}
		}
	}
	if count != 1 {
		t.Fatalf("plan events=%d, want only current update", count)
	}
}
