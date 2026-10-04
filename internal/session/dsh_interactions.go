package session

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func (c *dshCoordinator) hostEvent(raw json.RawMessage) {
	var event struct {
		Args     []json.RawMessage `json:"args"`
		Type     string            `json:"type"`
		ClientID string            `json:"clientId"`
		Event    string            `json:"event"`
		EventID  string            `json:"eventId"`
		AgentID  string            `json:"agentId"`
		Request  struct {
			ToolName string `json:"toolName"`
			CallID   string `json:"callId"`
			Reason   string `json:"reason"`
			Wait     struct {
				CallID string `json:"callId"`
			} `json:"wait"`
			Questions []struct {
				ID          string                    `json:"id"`
				Header      string                    `json:"header"`
				Question    string                    `json:"question"`
				Detail      string                    `json:"detail"`
				Options     []protocol.QuestionOption `json:"options"`
				MultiSelect bool                      `json:"multiSelect"`
			} `json:"questions"`
		} `json:"request"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return
	}
	switch event.Type {
	case "emit":
		if event.Event == "api-session/added" && len(event.Args) > 0 {
			var summary dshSummary
			if json.Unmarshal(event.Args[0], &summary) == nil {
				c.attach(summary, "terminal")
			}
		}

	case "ready":
		c.mu.Lock()
		c.clientID = event.ClientID
		c.mu.Unlock()
	case "waterfall":
		if event.Event != "approval/request" && event.Event != "user-questions/request" {
			return
		}
		// Unauthorised workspaces must not leak interaction contents to Relay.
		if c.sm.dshBackendFor(event.AgentID) == nil {
			return
		}
		pending := dshPending{SessionID: event.AgentID, Kind: event.Event, CallID: event.Request.CallID}
		if pending.Kind == "user-questions/request" {
			pending.CallID = event.Request.Wait.CallID
		}
		for _, q := range event.Request.Questions {
			text := q.Question
			if q.Detail != "" {
				text += "\n\n" + q.Detail
			}
			pending.Questions = append(pending.Questions, protocol.QuestionInfo{ID: q.ID, Header: q.Header, Question: text, Options: q.Options, Multiple: q.MultiSelect, Custom: true})
		}
		c.mu.Lock()
		c.pending[event.EventID] = pending
		c.mu.Unlock()
		ev := protocol.DaemonEvent{Type: "approval_request", SessionID: event.AgentID, RequestID: event.EventID, Tool: event.Request.ToolName, CallID: event.Request.CallID, Text: event.Request.Reason, AvailableDecisions: []string{"accept", "decline"}}
		security := approvalSecurityContext("high", true, []string{protocol.RiskReasonRequestsPermissions}, []string{"once", "reject"})
		ev.SecurityContext = securityContextForPublication(c.sm.trustedActionPolicy, &security)
		ev.Input, _ = json.Marshal(map[string]any{"reason": event.Request.Reason})
		if event.Event == "user-questions/request" {
			ev.Type = "question_request"
			ev.Questions = pending.Questions
			ev.Tool = "ask_user_question"
			ev.AvailableDecisions = nil
		}
		status := protocol.StatusWaitingApproval
		if ev.Type == "question_request" {
			status = protocol.StatusWaitingQuestion
		}
		c.sm.SetSessionStatus(event.AgentID, status)
		c.sm.outputCh <- ev
	case "cancel":
		c.mu.Lock()
		pending, ok := c.pending[event.EventID]
		delete(c.pending, event.EventID)
		c.mu.Unlock()
		if ok {
			kind := "approval_resolved"
			if pending.Kind == "user-questions/request" {
				kind = "question_resolved"
			}
			c.sm.outputCh <- protocol.DaemonEvent{Type: kind, SessionID: pending.SessionID, RequestID: event.EventID, Reason: "resolved_elsewhere"}
			c.sm.SetSessionStatus(pending.SessionID, protocol.StatusRunning)
		}
	}
}

func (b *dshBackend) resolveApproval(ctx context.Context, id, requestID, action string) error {
	value := "rejected"
	switch action {
	case "once":
		value = "allowed-once"
	case "reject":
	default:
		return fmt.Errorf("DSH supports once or reject approval decisions")
	}
	security := approvalSecurityContext("high", true, []string{protocol.RiskReasonRequestsPermissions}, []string{"once", "reject"})
	if err := b.coord.sm.enforceTrustedApprovalAction("dsh", &security, action); err != nil {
		return err
	}
	return b.resolve(ctx, id, requestID, "approval/request", value)
}

func (b *dshBackend) resolveQuestion(ctx context.Context, id, requestID string, answers [][]string) error {
	c := b.coord
	c.mu.Lock()
	pending, ok := c.pending[requestID]
	c.mu.Unlock()
	if !ok || pending.SessionID != id {
		return &ResolvedElsewhereError{RequestID: requestID}
	}
	if len(answers) != len(pending.Questions) {
		return fmt.Errorf("DSH expects an answer for every question")
	}
	var batch []any
	for i, q := range pending.Questions {
		selected := []string{}
		custom := []string{}
		for _, answer := range answers[i] {
			matched := false
			for _, option := range q.Options {
				if option.Label == answer {
					matched = true
					break
				}
			}
			if matched {
				selected = append(selected, answer)
			} else {
				custom = append(custom, answer)
			}
		}
		if !q.Multiple && len(answers[i]) > 1 {
			return fmt.Errorf("DSH question %s accepts one answer", q.ID)
		}
		item := map[string]any{"id": q.ID, "selected": selected}
		if len(custom) > 1 {
			return fmt.Errorf("DSH question %s accepts at most one custom answer", q.ID)
		}
		if len(custom) > 0 {
			item["custom"] = custom[0]
		}
		batch = append(batch, item)
	}
	return b.resolve(ctx, id, requestID, "user-questions/request", map[string]any{"answers": batch})
}

func (b *dshBackend) resolve(ctx context.Context, id, requestID, kind string, value any) error {
	return b.resolveOutcome(ctx, id, requestID, kind, map[string]any{"kind": "result", "value": value})
}

func (b *dshBackend) rejectQuestion(ctx context.Context, id, requestID string) error {
	return b.resolveOutcome(ctx, id, requestID, "user-questions/request", map[string]any{"kind": "rejected", "error": map[string]any{"name": "UserQuestionError", "code": "ASK_ABORTED", "message": "The user declined to answer"}})
}

func (b *dshBackend) resolveOutcome(ctx context.Context, id, requestID, kind string, outcome any) error {
	c := b.coord
	client, err := c.connect(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	pending, ok := c.pending[requestID]
	clientID := c.clientID
	c.mu.Unlock()
	if !ok || pending.SessionID != id || pending.Kind != kind || clientID == "" {
		return &ResolvedElsewhereError{RequestID: requestID}
	}
	// Native Host arbitrates competing clients. Its cancel event withdraws
	// the card everywhere; never synthesize a winning decision from an HTTP ACK.
	return client.Call(ctx, "$events/result", map[string]any{"clientId": clientID, "eventId": requestID, "outcome": outcome}, nil)
}

// The winning client receives no $events cancel. Confirm its result from
// durable native evidence instead; an HTTP ACK alone can also mean a late reply.
func (c *dshCoordinator) settleInteraction(id, kind, callID, outcome string) {
	c.mu.Lock()
	var resolved []string
	for requestID, p := range c.pending {
		if p.SessionID == id && p.Kind == kind && (p.CallID == callID || (kind == "user-questions/request" && p.CallID == "")) {
			resolved = append(resolved, requestID)
			delete(c.pending, requestID)
		}
	}
	c.mu.Unlock()
	for _, requestID := range resolved {
		event := protocol.DaemonEvent{Type: "approval_resolved", SessionID: id, RequestID: requestID}
		if kind == "user-questions/request" {
			event.Type = "question_resolved"
			event.Rejected = outcome == "rejected"
		} else {
			event.Approved = outcome == "allowed-once" || outcome == "allowed"
			event.Action = "reject"
			if event.Approved {
				event.Action = "once"
			}
		}
		c.sm.outputCh <- event
		c.sm.SetSessionStatus(id, protocol.StatusRunning)
	}
}
