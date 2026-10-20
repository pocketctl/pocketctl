package session

import "testing"

func TestManagedStructuredPlanProjectsStatusesAndDeduplicates(t *testing.T) {
	p := newCodexProjection(1)
	input := codexNotification("turn/plan/updated", `{"threadId":"s","turnId":"t","plan":[{"step":"A","status":"completed"},{"step":"B","status":"inProgress"},{"step":"C","status":"pending"}]}`)
	events := p.Project(input)
	if len(events) != 1 || events[0].Type != "agent_plan" {
		t.Fatalf("structured plan discarded: %+v", events)
	}
	if events[0].Plan[1].Status != "in_progress" || events[0].SourceTurnID != "t" {
		t.Fatalf("invalid normalized plan: %+v", events[0])
	}
	if len(p.Project(input)) != 0 {
		t.Fatal("duplicate plan emitted")
	}
	next := p.Project(codexNotification("turn/plan/updated", `{"threadId":"s","turnId":"t","plan":[{"step":"A","status":"completed"},{"step":"B","status":"completed"},{"step":"C","status":"pending"}]}`))
	if len(next) != 1 || next[0].Revision <= events[0].Revision || next[0].PreviousEventID != events[0].EventID {
		t.Fatal("plan successor lost ordering")
	}
	invalid := p.Project(codexNotification("turn/plan/updated", `{"threadId":"s","turnId":"t","plan":[{"step":"A","status":"unknown"}]}`))
	if len(invalid) != 0 {
		t.Fatal("invalid plan accepted")
	}
}

func TestManagedPlanClearAndNewProjectionRevision(t *testing.T) {
	p := newCodexProjection(1)
	input := codexNotification("turn/plan/updated", `{"threadId":"s","turnId":"t","plan":[{"step":"A","status":"pending"}]}`)
	first := p.Project(input)[0]
	fresh := newCodexProjection(2).Project(input)[0]
	if fresh.Revision <= first.Revision {
		t.Fatal("new projector resets plan revision")
	}
	cleared := p.Project(codexNotification("turn/plan/updated", `{"threadId":"s","turnId":"t","plan":[]}`))
	if len(cleared) != 1 || cleared[0].Status != "cleared" || cleared[0].PreviousEventID != first.EventID {
		t.Fatal("missing plan tombstone")
	}
}
