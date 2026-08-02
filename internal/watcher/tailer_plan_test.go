package watcher

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestJSONLTailerRunFinalizesCodexPlanPartIdentity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session-1.jsonl")
	input := `tools.update_plan({plan:[{step:"Render",status:"in_progress"}]})`
	payload := map[string]any{
		"type": "custom_tool_call", "call_id": "call-1", "name": "exec", "input": input,
	}
	line, err := json.Marshal(map[string]any{"type": "response_item", "payload": payload})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(line, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewJSONLTailerFromStart(path, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := make(chan protocol.DaemonEvent, 2)
	go tailer.Run(ctx, output, nil)

	deadline := time.After(2500 * time.Millisecond)
	for {
		select {
		case event := <-output:
			if event.Type == "agent_plan" {
				if event.PartID != "plan:session-1" {
					t.Fatalf("agent_plan part_id=%q", event.PartID)
				}
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for agent_plan")
		}
	}
}
