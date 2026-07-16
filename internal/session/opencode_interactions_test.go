package session

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

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

func TestOpenCodeStartSyncTriggersPerSessionRecovery(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recovered := make(chan string, 1)
	coordinator := &opencodeCoordinator{
		ctx:     ctx,
		tracked: make(map[string]context.CancelFunc),
		recoverSession: func(_ context.Context, sessionID string) {
			recovered <- sessionID
		},
	}
	coordinator.startSync("ses_recovered", false)
	select {
	case sessionID := <-recovered:
		if sessionID != "ses_recovered" {
			t.Fatalf("recovered session=%q", sessionID)
		}
	case <-time.After(time.Second):
		t.Fatal("startSync did not trigger per-session interaction recovery")
	}
	cancel()
}

func TestOpenCodeNativeStatusKeepsPendingInteractionPriority(t *testing.T) {
	sm, _ := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].PendingQuestions["que_1"] = PendingOpenCodeQuestion{RequestID: "que_1"}
	if got := sm.applyOpencodeRuntimeStatus("ses_1", protocol.StatusRetry); got != protocol.StatusWaitingQuestion {
		t.Fatalf("effective status=%q want waiting_question", got)
	}
	delete(sm.sessions["ses_1"].PendingQuestions, "que_1")
	if got := sm.applyOpencodeRuntimeStatus("ses_1", protocol.StatusBusy); got != protocol.StatusBusy {
		t.Fatalf("effective status=%q want busy", got)
	}
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

func TestOpenCodeInteractionEventValidatesGlobalDirectory(t *testing.T) {
	sm, out := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].Cwd = "/repo"
	coordinator := &opencodeCoordinator{sm: sm}
	event := adapter.SSEEvent{
		ID: "evt_1", Type: "permission.asked",
		Properties: json.RawMessage(`{"id":"per_1","sessionID":"ses_1","permission":"bash"}`),
	}
	coordinator.handleInteractionEvent(event)
	if len(sm.sessions["ses_1"].PendingPermissions) != 0 || len(out) != 0 {
		t.Fatal("global event without a directory must be ignored")
	}
	event.Directory = "/tmp/other"
	coordinator.handleInteractionEvent(event)
	if len(sm.sessions["ses_1"].PendingPermissions) != 0 || len(out) != 0 {
		t.Fatal("event from a different global directory must be ignored")
	}
	event.Directory = "/repo"
	coordinator.handleInteractionEvent(event)
	if len(sm.sessions["ses_1"].PendingPermissions) != 1 {
		t.Fatal("event from the session directory must be accepted")
	}
	sm.clearOpencodePermission("ses_1", "per_1")
	for len(out) > 0 {
		<-out
	}
	coordinator.handleInteractionEvent(event)
	if len(sm.sessions["ses_1"].PendingPermissions) != 0 || len(out) != 0 {
		t.Fatal("replayed global event ID must not recreate a resolved card")
	}
}

func TestOpenCodeInteractionResolutionRequiresGlobalDirectory(t *testing.T) {
	sm, _ := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].Cwd = "/repo"
	sm.handleOpencodePermission(adapter.PermissionAsked{ID: "per_1", SessionID: "ses_1", Permission: "bash", Version: adapter.PermissionVersionLegacy})
	sm.handleOpencodeQuestion(adapter.QuestionAsked{ID: "que_1", SessionID: "ses_1", Questions: []protocol.QuestionInfo{{Question: "Continue?"}}, Version: adapter.PermissionVersionLegacy})
	coordinator := &opencodeCoordinator{sm: sm}
	permissionResolved := adapter.SSEEvent{ID: "evt_per_done", Type: "permission.replied", Properties: json.RawMessage(`{"sessionID":"ses_1","permissionID":"per_1","response":"once"}`)}
	questionResolved := adapter.SSEEvent{ID: "evt_que_done", Type: "question.replied", Properties: json.RawMessage(`{"sessionID":"ses_1","requestID":"que_1","answers":[["Yes"]]}`)}
	coordinator.handleInteractionEvent(permissionResolved)
	coordinator.handleInteractionEvent(questionResolved)
	if len(sm.sessions["ses_1"].PendingPermissions) != 1 || len(sm.sessions["ses_1"].PendingQuestions) != 1 {
		t.Fatal("global resolutions without directory mutated pending state")
	}
	permissionResolved.Directory = "/repo"
	questionResolved.Directory = "/repo"
	coordinator.handleInteractionEvent(permissionResolved)
	coordinator.handleInteractionEvent(questionResolved)
	if len(sm.sessions["ses_1"].PendingPermissions) != 0 || len(sm.sessions["ses_1"].PendingQuestions) != 0 {
		t.Fatal("matching-directory global resolutions did not clear pending state")
	}
	coordinator.handleInteractionEvent(adapter.SSEEvent{ID: "evt_future_done", Type: "permission.replied", Directory: "/repo", Properties: json.RawMessage(`{"sessionID":"ses_1","permissionID":"per_future","response":"once"}`)})
	coordinator.handleInteractionEvent(adapter.SSEEvent{ID: "evt_future_asked", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_future","sessionID":"ses_1","permission":"bash"}`)})
	if _, replayed := sm.sessions["ses_1"].PendingPermissions["per_future"]; replayed {
		t.Fatal("resolution received before replayed asked did not tombstone the request lifecycle")
	}
}

func TestOpenCodeInteractionRequestTombstonesAreBounded(t *testing.T) {
	coordinator := &opencodeCoordinator{}
	for i := 0; i <= opencodeSeenEventLimit; i++ {
		coordinator.markInteractionResolved("permission", "ses_1", fmt.Sprintf("per_%d", i))
	}
	if len(coordinator.resolvedInteractions) != opencodeSeenEventLimit || len(coordinator.resolvedOrder) != opencodeSeenEventLimit {
		t.Fatalf("tombstone cache sizes map=%d order=%d", len(coordinator.resolvedInteractions), len(coordinator.resolvedOrder))
	}
	if coordinator.interactionResolved("permission", "ses_1", "per_0") {
		t.Fatal("oldest tombstone was not evicted")
	}
	if !coordinator.interactionResolved("permission", "ses_1", fmt.Sprintf("per_%d", opencodeSeenEventLimit)) {
		t.Fatal("newest tombstone missing")
	}
}

func TestOpenCodeInteractionSnapshotGenerationsAreScoped(t *testing.T) {
	sm, _ := newOpenCodeInteractionManager()
	sm.sessions["ses_1"].Cwd = "/repo"
	coordinator := newOpencodeCoordinator(sm)
	permissionLegacy := coordinator.captureInteractionGenerations([]string{"ses_1"}, "permission", adapter.PermissionVersionLegacy)["ses_1"]
	questionLegacy := coordinator.captureInteractionGenerations([]string{"ses_1"}, "question", adapter.PermissionVersionLegacy)["ses_1"]
	permissionV2 := coordinator.captureInteractionGenerations([]string{"ses_1"}, "permission", adapter.PermissionVersionV2)["ses_1"]
	questionV2 := coordinator.captureInteractionGenerations([]string{"ses_1"}, "question", adapter.PermissionVersionV2)["ses_1"]

	if !coordinator.applyPermissionSnapshot("ses_1", adapter.PermissionVersionLegacy, permissionLegacy, []adapter.PermissionAsked{{ID: "per_legacy", SessionID: "ses_1", Permission: "bash", Version: adapter.PermissionVersionLegacy}}) {
		t.Fatal("legacy permission snapshot was discarded")
	}
	if !coordinator.applyQuestionSnapshot("ses_1", adapter.PermissionVersionLegacy, questionLegacy, []adapter.QuestionAsked{{ID: "que_legacy", SessionID: "ses_1", Version: adapter.PermissionVersionLegacy, Questions: []protocol.QuestionInfo{{Question: "Legacy?"}}}}) {
		t.Fatal("legacy question snapshot was invalidated by permission scope")
	}
	if !coordinator.applyPermissionSnapshot("ses_1", adapter.PermissionVersionV2, permissionV2, []adapter.PermissionAsked{{ID: "per_v2", SessionID: "ses_1", Permission: "edit", Version: adapter.PermissionVersionV2}}) {
		t.Fatal("v2 permission snapshot was invalidated by legacy scopes")
	}
	if !coordinator.applyQuestionSnapshot("ses_1", adapter.PermissionVersionV2, questionV2, []adapter.QuestionAsked{{ID: "que_v2", SessionID: "ses_1", Version: adapter.PermissionVersionV2, Questions: []protocol.QuestionInfo{{Question: "V2?"}}}}) {
		t.Fatal("v2 question snapshot was invalidated by another scope")
	}

	stalePermissionLegacy := coordinator.captureInteractionGenerations([]string{"ses_1"}, "permission", adapter.PermissionVersionLegacy)["ses_1"]
	coordinator.handleInteractionEvent(adapter.SSEEvent{ID: "evt_new_scope", Type: "permission.asked", Directory: "/repo", Properties: json.RawMessage(`{"id":"per_new_scope","sessionID":"ses_1","permission":"bash"}`)})
	if coordinator.applyPermissionSnapshot("ses_1", adapter.PermissionVersionLegacy, stalePermissionLegacy, nil) {
		t.Fatal("same-scope stale permission snapshot was applied")
	}
	if _, ok := sm.sessions["ses_1"].PendingPermissions["per_new_scope"]; !ok {
		t.Fatal("same-scope newer mutation was overwritten")
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
