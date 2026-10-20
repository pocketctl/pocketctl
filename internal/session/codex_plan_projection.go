package session

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type managedPlanState struct {
	fingerprint, eventID string
	revision             int
}

// Native app-server plans are structured snapshots. item/plan text remains prose.
func (p *codexProjection) projectPlan(raw json.RawMessage) []protocol.DaemonEvent {
	var input struct {
		ThreadID    string              `json:"threadId"`
		TurnID      string              `json:"turnId"`
		Explanation string              `json:"explanation"`
		Plan        []protocol.PlanItem `json:"plan"`
	}
	if len(raw) > 256*1024 || json.Unmarshal(raw, &input) != nil || input.ThreadID == "" || input.TurnID == "" || input.Plan == nil || len(input.Explanation) > 8192 || len(input.Plan) > 100 {
		return nil
	}
	for i := range input.Plan {
		step := &input.Plan[i]
		step.Step = strings.TrimSpace(step.Step)
		if step.Status == "inProgress" {
			step.Status = "in_progress"
		}
		if step.Step == "" || len(step.Step) > 4096 || (step.Status != "pending" && step.Status != "in_progress" && step.Status != "completed") {
			return nil
		}
	}
	encoded, _ := json.Marshal(input)
	fingerprint := digest(encoded)
	if p.plans == nil {
		p.plans = make(map[string]managedPlanState)
	}
	previous := p.plans[input.ThreadID]
	if previous.fingerprint == fingerprint {
		return nil
	}
	// Native notifications carry no revision. Use an observation epoch so a fresh
	// projector after daemon restart does not reset to revision 1 and get ignored.
	revision := int(time.Now().UnixMicro())
	if revision <= previous.revision {
		revision = previous.revision + 1
	}
	eventID := fmt.Sprintf("codex:native-plan:%s:%d:%s", input.TurnID, revision, fingerprint)
	status := ""
	if len(input.Plan) == 0 {
		status = "cleared"
	}
	event := protocol.DaemonEvent{Status: status, Type: "agent_plan", SessionID: input.ThreadID, EventID: eventID, PreviousEventID: previous.eventID, Revision: revision, Explanation: input.Explanation, Plan: input.Plan}
	stampTurnIdentity(&event, input.ThreadID, input.TurnID, "")
	p.plans[input.ThreadID] = managedPlanState{fingerprint, eventID, revision}
	return []protocol.DaemonEvent{event}
}
