package memorycontext

import (
	"context"
	"encoding/json"
	"testing"
)

func TestLifecycleHintsRemainOptionalAndReachCompiler(t *testing.T) {
	started := make(chan CompileRequest, 1)
	memory := &fakeMemory{compile: &CompileResponse{Outcome: "empty"}, compileStarted: started}
	c := coordinator(&fakeGrants{grant: readyGrant}, memory)
	req := newTurn()
	req.SceneID = "00000000-0000-4000-8000-000000000001"
	req.TaskScopeKey = "stable-task"
	req.Destination = "work"
	req.FactAt = "2026-10-01T00:00:00Z"
	c.Prepare(context.Background(), req)
	got := <-started
	if got.SceneID != req.SceneID || got.TaskScopeKey != req.TaskScopeKey || got.Destination != "work" || got.FactAt != req.FactAt {
		t.Fatalf("lifecycle hints lost: %+v", got)
	}
	old, _ := json.Marshal(CompileRequest{SchemaVersion: 1})
	var fields map[string]any
	_ = json.Unmarshal(old, &fields)
	for _, key := range []string{"scene_id", "task_scope_key", "destination", "fact_at", "known_at"} {
		if _, ok := fields[key]; ok {
			t.Fatalf("old protocol gained nonoptional %s", key)
		}
	}
}
