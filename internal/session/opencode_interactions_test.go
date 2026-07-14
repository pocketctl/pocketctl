package session

import (
	"encoding/json"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func newOpenCodeInteractionManager() (*SessionManager, chan protocol.DaemonEvent) {
	out := make(chan protocol.DaemonEvent, 32)
	sm := NewSessionManager(out)
	sm.sessions["ses_1"] = &ProcessState{
		SessionID: "ses_1", Agent: adapter.AgentOpencode, Status: protocol.StatusRunning,
		PendingPermissions: make(map[string]PendingOpenCodePermission),
		PendingQuestions:   make(map[string]PendingOpenCodeQuestion),
	}
	return sm, out
}

func TestOpenCodeInteractionStateMultiplePendingAndDedup(t *testing.T) {
	sm, out := newOpenCodeInteractionManager()
	p1 := adapter.PermissionAsked{ID: "per_1", SessionID: "ses_1", Permission: "bash", Tool: "bash", Patterns: []string{"git *"}, Always: []string{"git status"}, Metadata: json.RawMessage(`{"command":"git status"}`), Version: adapter.PermissionVersionLegacy}
	p2 := adapter.PermissionAsked{ID: "per_2", SessionID: "ses_1", Permission: "edit", Tool: "edit", Version: adapter.PermissionVersionV2}
	q1 := adapter.QuestionAsked{ID: "que_1", SessionID: "ses_1", Questions: []protocol.QuestionInfo{{Question: "Choose", Options: []protocol.QuestionOption{{Label: "A"}}}}}

	if !sm.handleOpencodePermission(p1) || !sm.handleOpencodePermission(p2) || !sm.handleOpencodeQuestion(q1) {
		t.Fatal("new requests must be surfaced")
	}
	if sm.handleOpencodePermission(p1) || sm.handleOpencodeQuestion(q1) {
		t.Fatal("duplicate requests must not be surfaced twice")
	}

	sm.mu.RLock()
	state := sm.sessions["ses_1"]
	permissionCount := len(state.PendingPermissions)
	questionCount := len(state.PendingQuestions)
	status := state.Status
	sm.mu.RUnlock()
	if permissionCount != 2 || questionCount != 1 || status != protocol.StatusWaitingApproval {
		t.Fatalf("permissions=%d questions=%d status=%s", permissionCount, questionCount, status)
	}

	var approvalRequests, questionRequests int
	for len(out) > 0 {
		event := <-out
		switch event.Type {
		case "approval_request":
			approvalRequests++
			if event.RequestID == "per_1" && (event.PermissionName != "bash" || len(event.Patterns) != 1 || event.PermissionVersion != adapter.PermissionVersionLegacy) {
				t.Fatalf("full permission fields missing: %+v", event)
			}
		case "question_request":
			questionRequests++
			if len(event.Questions) != 1 {
				t.Fatalf("question fields missing: %+v", event)
			}
		}
	}
	if approvalRequests != 2 || questionRequests != 1 {
		t.Fatalf("approval=%d question=%d", approvalRequests, questionRequests)
	}
}

func TestOpenCodeInteractionStateResolutionKeepsOtherPending(t *testing.T) {
	sm, _ := newOpenCodeInteractionManager()
	sm.handleOpencodePermission(adapter.PermissionAsked{ID: "per_1", SessionID: "ses_1", Permission: "bash", Version: adapter.PermissionVersionLegacy})
	sm.handleOpencodePermission(adapter.PermissionAsked{ID: "per_2", SessionID: "ses_1", Permission: "edit", Version: adapter.PermissionVersionV2})
	sm.handleOpencodeQuestion(adapter.QuestionAsked{ID: "que_1", SessionID: "ses_1", Questions: []protocol.QuestionInfo{{Question: "Q"}}})

	if !sm.clearOpencodePermission("ses_1", "per_1") {
		t.Fatal("expected permission to clear")
	}
	sm.mu.RLock()
	state := sm.sessions["ses_1"]
	if len(state.PendingPermissions) != 1 || len(state.PendingQuestions) != 1 || state.Status != protocol.StatusWaitingApproval {
		t.Fatalf("unexpected state after permission clear: %+v", state)
	}
	sm.mu.RUnlock()

	if !sm.clearOpencodePermission("ses_1", "per_2") {
		t.Fatal("expected second permission to clear")
	}
	sm.mu.RLock()
	if sm.sessions["ses_1"].Status != protocol.StatusWaitingQuestion {
		t.Fatalf("question should keep waiting status: %s", sm.sessions["ses_1"].Status)
	}
	sm.mu.RUnlock()

	if !sm.clearOpencodeQuestion("ses_1", "que_1") {
		t.Fatal("expected question to clear")
	}
	sm.mu.RLock()
	if sm.sessions["ses_1"].Status != protocol.StatusIdle {
		t.Fatalf("last clear should fall back to idle, got %s", sm.sessions["ses_1"].Status)
	}
	sm.mu.RUnlock()
}

func TestOpenCodeInteractionStateSnapshots(t *testing.T) {
	sm, _ := newOpenCodeInteractionManager()
	sm.handleOpencodePermission(adapter.PermissionAsked{ID: "per_1", SessionID: "ses_1", Permission: "bash", Version: adapter.PermissionVersionLegacy})
	sm.handleOpencodeQuestion(adapter.QuestionAsked{ID: "que_1", SessionID: "ses_1", Questions: []protocol.QuestionInfo{{Question: "Q"}}})
	events := sm.PendingOpencodeInteractions("ses_1")
	if len(events) != 2 || events[0].RequestID == events[1].RequestID {
		t.Fatalf("snapshots=%+v", events)
	}
	if got := sm.PendingOpencodeInteractions("missing"); len(got) != 0 {
		t.Fatalf("unexpected missing snapshots=%+v", got)
	}
}

func TestOpenCodeInteractionStateRejectsCrossSessionResolution(t *testing.T) {
	sm, _ := newOpenCodeInteractionManager()
	sm.handleOpencodeQuestion(adapter.QuestionAsked{ID: "que_1", SessionID: "ses_1", Questions: []protocol.QuestionInfo{{Question: "Q", Custom: true}}})
	if err := sm.ResolveQuestion("other", "que_1", [][]string{{"answer"}}); err == nil {
		t.Fatal("cross-session question reply must fail")
	}
	if err := sm.ResolveApprovalAction("other", "per_1", "once"); err == nil {
		t.Fatal("cross-session permission reply must fail")
	}
}

func TestOpenCodeInteractionStateAuthoritativeSnapshotClearsStale(t *testing.T) {
	sm, out := newOpenCodeInteractionManager()
	sm.handleOpencodePermission(adapter.PermissionAsked{ID: "per_keep", SessionID: "ses_1", Permission: "bash", Version: adapter.PermissionVersionLegacy})
	sm.handleOpencodePermission(adapter.PermissionAsked{ID: "per_stale", SessionID: "ses_1", Permission: "edit", Version: adapter.PermissionVersionLegacy})
	sm.handleOpencodeQuestion(adapter.QuestionAsked{ID: "que_stale", SessionID: "ses_1", Version: adapter.PermissionVersionLegacy, Questions: []protocol.QuestionInfo{{Question: "Q"}}})
	for len(out) > 0 {
		<-out
	}

	sm.reconcileOpencodePermissionSnapshot("", adapter.PermissionVersionLegacy, []adapter.PermissionAsked{{ID: "per_keep", SessionID: "ses_1", Permission: "bash", Version: adapter.PermissionVersionLegacy}})
	sm.reconcileOpencodeQuestionSnapshot("", adapter.PermissionVersionLegacy, nil)

	sm.mu.RLock()
	state := sm.sessions["ses_1"]
	_, keepExists := state.PendingPermissions["per_keep"]
	_, staleExists := state.PendingPermissions["per_stale"]
	questionCount := len(state.PendingQuestions)
	sm.mu.RUnlock()
	if !keepExists || staleExists || questionCount != 0 {
		t.Fatalf("unexpected reconciled state: permissions=%+v questions=%+v", state.PendingPermissions, state.PendingQuestions)
	}

	resolved := map[string]bool{}
	for len(out) > 0 {
		event := <-out
		if event.Reason == "no_longer_pending" {
			resolved[event.RequestID] = true
		}
	}
	if !resolved["per_stale"] || !resolved["que_stale"] || resolved["per_keep"] {
		t.Fatalf("resolved events=%+v", resolved)
	}
}

func TestOpenCodeDynamicCommandParsingAndMapping(t *testing.T) {
	name, arguments, ok := parseOpenCodeSlashCommand("  /review   abc def  ")
	if !ok || name != "review" || arguments != "abc def" {
		t.Fatalf("name=%q arguments=%q ok=%v", name, arguments, ok)
	}
	for _, input := range []string{"hello", "/", " / review"} {
		if _, _, ok := parseOpenCodeSlashCommand(input); ok {
			t.Fatalf("unexpected slash parse for %q", input)
		}
	}
	items := mapOpenCodeCommands([]adapter.OpencodeCommand{{
		Name: "review", Description: "Review", Source: "skill", Template: "Review $ARGUMENTS",
		Hints: []string{"[scope]"}, Subtask: true, Agent: "build", Model: "openai/gpt-5",
	}})
	if len(items) != 1 || items[0].Kind != "skill" || items[0].ArgHint != "[scope]" || !items[0].Subtask || items[0].Template == "" {
		t.Fatalf("items=%+v", items)
	}
}

func TestOpenCodeAgentFilteringAndSwitchGate(t *testing.T) {
	agents := filterOpenCodeAgents([]adapter.OpencodeAgent{
		{Name: "build", Mode: "primary", Color: "#fff", Model: "openai/gpt-5"},
		{Name: "plan", Mode: "all"},
		{Name: "explore", Mode: "subagent"},
		{Name: "hidden", Mode: "primary", Hidden: true},
	})
	if len(agents) != 2 || agents[0].Name != "build" || agents[1].Name != "plan" {
		t.Fatalf("agents=%+v", agents)
	}
	allowed := &ProcessState{Status: protocol.StatusIdle}
	if err := validateOpenCodeAgentSwitchState(allowed); err != nil {
		t.Fatalf("idle switch rejected: %v", err)
	}
	for _, status := range []string{protocol.StatusRunning, protocol.StatusWaitingApproval, protocol.StatusWaitingQuestion, "busy"} {
		if err := validateOpenCodeAgentSwitchState(&ProcessState{Status: status}); err == nil {
			t.Fatalf("status %q should reject switch", status)
		}
	}
	if err := validateOpenCodeAgentSwitchState(&ProcessState{Status: protocol.StatusIdle, PendingPermissions: map[string]PendingOpenCodePermission{"p": {RequestID: "p"}}}); err == nil {
		t.Fatal("pending permission should reject switch")
	}
}
