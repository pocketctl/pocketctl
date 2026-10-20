package adapter

import (
	"github.com/pocketctl/pocketctl/internal/protocol"
	"testing"
)

func TestClaudeTaskToolsProjectOnlySuccessfulStructuredState(t *testing.T) {
	for _, mode := range []string{"jsonl", "stream"} {
		t.Run(mode, func(t *testing.T) {
			var parse func(string) ([]protocol.DaemonEvent, error)
			if mode == "jsonl" {
				parse = NewJSONLStreamParser().Parse
			} else {
				parse = NewClaudeAdapter("").ParseStreamLine
			}
			lines := []string{
				`{"type":"assistant","sessionId":"s","session_id":"s","message":{"content":[{"type":"tool_use","id":"c1","name":"TaskCreate","input":{"subject":"Inspect"}}]}}`,
				`{"type":"user","sessionId":"s","session_id":"s","timestamp":"2026-10-20T00:00:01Z","toolUseResult":{"task":{"id":"1","subject":"Inspect"}},"message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"created"}]}}`,
				`{"type":"assistant","sessionId":"s","session_id":"s","message":{"content":[{"type":"tool_use","id":"c2","name":"TaskUpdate","input":{"taskId":"1","status":"in_progress"}}]}}`,
				`{"type":"user","sessionId":"s","session_id":"s","timestamp":"2026-10-20T00:00:02Z","toolUseResult":{"success":true,"taskId":"1"},"message":{"content":[{"type":"tool_result","tool_use_id":"c2","content":"updated"}]}}`,
			}
			var plans []protocol.DaemonEvent
			for _, line := range lines {
				events, err := parse(line)
				if err != nil {
					t.Fatal(err)
				}
				for _, e := range events {
					if e.Type == "agent_plan" {
						plans = append(plans, e)
					}
				}
			}
			if len(plans) != 2 {
				t.Fatalf("plans=%d, want create and update", len(plans))
			}
			if plans[0].Plan[0].Status != "pending" || plans[1].Plan[0].Status != "in_progress" || plans[1].PreviousEventID != plans[0].EventID || plans[1].Revision <= plans[0].Revision {
				t.Fatalf("bad task state: %+v", plans)
			}
			_, _ = parse(lines[2])
			repeated, _ := parse(lines[3])
			for _, e := range repeated {
				if e.Type == "agent_plan" {
					t.Fatal("result replay generated another plan")
				}
			}
		})
	}
}

func TestClaudeTodoFailureDoesNotPublishRequestedState(t *testing.T) {
	p := NewJSONLStreamParser()
	p.Parse(`{"type":"assistant","sessionId":"s","message":{"content":[{"type":"tool_use","id":"c","name":"TodoWrite","input":{"todos":[{"content":"Inspect","status":"completed"}]}}]}}`)
	events, _ := p.Parse(`{"type":"user","sessionId":"s","message":{"content":[{"type":"tool_result","tool_use_id":"c","is_error":true,"content":"failed"}]}}`)
	for _, e := range events {
		if e.Type == "agent_plan" {
			t.Fatal("failed write became completed plan")
		}
	}
}

func TestClaudeTodoSnapshotCanBeClearedWithoutResurrectingTasks(t *testing.T) {
	p := NewJSONLStreamParser()
	p.Parse(`{"type":"assistant","sessionId":"s","message":{"content":[{"type":"tool_use","id":"a","name":"TodoWrite","input":{"todos":[{"content":"A","status":"completed"},{"content":"B","status":"in_progress"},{"content":"C","status":"pending"}]}}]}}`)
	events, err := p.Parse(`{"type":"user","sessionId":"s","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"updated"}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	var first protocol.DaemonEvent
	for _, e := range events {
		if e.Type == "agent_plan" {
			first = e
		}
	}
	if len(first.Plan) != 3 || first.Plan[0].Status != "completed" || first.Plan[1].Status != "in_progress" || first.Plan[2].Status != "pending" {
		t.Fatalf("invalid snapshot: %+v", first.Plan)
	}
	p.Parse(`{"type":"assistant","sessionId":"s","message":{"content":[{"type":"tool_use","id":"b","name":"TodoWrite","input":{"todos":[]}}]}}`)
	events, _ = p.Parse(`{"type":"user","sessionId":"s","message":{"content":[{"type":"tool_result","tool_use_id":"b","content":"updated"}]}}`)
	var cleared protocol.DaemonEvent
	for _, e := range events {
		if e.Type == "agent_plan" {
			cleared = e
		}
	}
	if cleared.Status != "cleared" || len(cleared.Plan) != 0 || cleared.PreviousEventID != first.EventID {
		t.Fatal("empty snapshot did not clear previous plan")
	}
}
