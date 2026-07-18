package session

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type fakeCodexResponse struct {
	id     string
	result json.RawMessage
	err    *codexapp.RPCError
}

type interactionCodexClient struct {
	*fakeCodexRuntimeClient
	responseMu sync.Mutex
	responses  []fakeCodexResponse
}

func newInteractionCodexClient() *interactionCodexClient {
	return &interactionCodexClient{fakeCodexRuntimeClient: newFakeCodexRuntimeClient()}
}

func (f *interactionCodexClient) Respond(id codexapp.RequestID, result any, rpcErr *codexapp.RPCError) error {
	raw, _ := json.Marshal(result)
	f.responseMu.Lock()
	f.responses = append(f.responses, fakeCodexResponse{id: id.Key(), result: raw, err: rpcErr})
	f.responseMu.Unlock()
	return nil
}

func codexServerRequest(t *testing.T, rawID, method, params string) codexapp.Inbound {
	t.Helper()
	var id codexapp.RequestID
	if err := json.Unmarshal([]byte(rawID), &id); err != nil {
		t.Fatal(err)
	}
	return codexapp.Inbound{ID: &id, Method: method, Params: json.RawMessage(params)}
}

func nextCodexEvent(t *testing.T, events <-chan protocol.DaemonEvent, eventType string) protocol.DaemonEvent {
	t.Helper()
	for i := 0; i < 8; i++ {
		event := <-events
		if event.Type == eventType {
			return event
		}
	}
	t.Fatalf("missing event type %s", eventType)
	return protocol.DaemonEvent{}
}

func TestCodexInteractionsApprovalIDsAndAvailableDecisionValidation(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 7, client)

	numeric := codexServerRequest(t, `1`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","startedAtMs":1,
		"command":"rm a","cwd":"/repo","reason":"needs write",
		"availableDecisions":["accept","decline"]
	}`)
	stringID := codexServerRequest(t, `"1"`, "item/fileChange/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"patch_1","startedAtMs":2,"reason":"edit"
	}`)
	interactions.Handle(numeric)
	first := nextCodexEvent(t, output, "approval_request")
	interactions.Handle(stringID)
	second := nextCodexEvent(t, output, "approval_request")
	if first.Type != "approval_request" || first.SessionID != "thr_1" || first.RequestID == "" || first.Tool != "commandExecution" || first.Command != "rm a" || first.Cwd != "/repo" {
		t.Fatalf("command approval=%+v", first)
	}
	if second.Type != "approval_request" || second.RequestID == first.RequestID || second.Tool != "fileChange" {
		t.Fatalf("file approval=%+v", second)
	}
	if err := interactions.ResolveApproval(context.Background(), "thr_1", first.RequestID, "always"); err == nil {
		t.Fatal("acceptForSession must be rejected when unavailable")
	}
	if err := interactions.ResolveApproval(context.Background(), "thr_1", first.RequestID, "once"); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	response := client.responses[len(client.responses)-1]
	client.responseMu.Unlock()
	if response.id != "n:1" || string(response.result) != `{"decision":"accept"}` {
		t.Fatalf("response=%+v", response)
	}
}

func TestCodexInteractionsRemoteResolutionWins(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 2, client)
	request := codexServerRequest(t, `99`, "item/fileChange/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"patch_1","startedAtMs":1
	}`)
	interactions.Handle(request)
	asked := nextCodexEvent(t, output, "approval_request")
	interactions.Handle(codexNotification("serverRequest/resolved", `{"threadId":"thr_1","requestId":99}`))
	resolved := nextCodexEvent(t, output, "approval_resolved")
	if resolved.Type != "approval_resolved" || resolved.RequestID != asked.RequestID || resolved.Reason != protocol.InteractionResolvedElsewhere {
		t.Fatalf("resolved=%+v", resolved)
	}
	err := interactions.ResolveApproval(context.Background(), "thr_1", asked.RequestID, "once")
	var resolvedElsewhere *ResolvedElsewhereError
	if !errors.As(err, &resolvedElsewhere) {
		t.Fatalf("resolve error=%v", err)
	}
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	if len(client.responses) != 0 {
		t.Fatalf("losing client wrote response=%+v", client.responses)
	}
}

func TestCodexInteractionsUserInputPreservesIDsAndRedactsSecrets(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 3, client)
	request := codexServerRequest(t, `"ask-1"`, "item/tool/requestUserInput", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"tool_1","autoResolutionMs":60000,
		"questions":[
			{"id":"mode","header":"Mode","question":"Choose","isOther":true,"options":[{"label":"A","description":"first"}]},
			{"id":"token","header":"Token","question":"Enter token","isSecret":true}
		]
	}`)
	interactions.Handle(request)
	asked := nextCodexEvent(t, output, "question_request")
	if asked.Type != "question_request" || asked.AutoResolutionMs != 60000 || len(asked.Questions) != 2 || asked.Questions[0].ID != "mode" || !asked.Questions[0].Custom || asked.Questions[1].ID != "token" || !asked.Questions[1].Secret {
		t.Fatalf("question=%+v", asked)
	}
	answers := [][]string{{"A"}, {"super-secret"}}
	if err := interactions.ResolveQuestion(context.Background(), "thr_1", asked.RequestID, answers); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	response := client.responses[len(client.responses)-1]
	client.responseMu.Unlock()
	var payload struct {
		Answers map[string]struct {
			Answers []string `json:"answers"`
		} `json:"answers"`
	}
	if err := json.Unmarshal(response.result, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Answers["mode"].Answers[0] != "A" || payload.Answers["token"].Answers[0] != "super-secret" {
		t.Fatalf("native answers=%v", payload.Answers)
	}
	resolved := nextCodexEvent(t, output, "question_resolved")
	if resolved.Type != "question_resolved" || resolved.RequestID != asked.RequestID || resolved.Answers != nil || !resolved.Redacted {
		t.Fatalf("resolved leaked secret=%+v", resolved)
	}
}

func TestSessionManagerRoutesCodexApprovalAndQuestionResponses(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 4, client)
	coord.interactions = interactions
	sm.codexProvider = &CodexRuntimeProvider{sm: sm, coordinator: coord}

	interactions.Handle(codexServerRequest(t, `10`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","startedAtMs":1,
		"availableDecisions":["cancel"]
	}`))
	approval := nextCodexEvent(t, output, "approval_request")
	if err := sm.ResolveApprovalAction("thr_1", approval.RequestID, "cancel"); err != nil {
		t.Fatal(err)
	}

	interactions.Handle(codexServerRequest(t, `11`, "item/tool/requestUserInput", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"tool_1",
		"questions":[{"id":"q","header":"Q","question":"Continue?","options":[{"label":"Yes","description":"continue"}]}]
	}`))
	question := nextCodexEvent(t, output, "question_request")
	if err := sm.RejectQuestion("thr_1", question.RequestID); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	if len(client.responses) != 2 || client.responses[0].err != nil || string(client.responses[0].result) != `{"decision":"cancel"}` || client.responses[1].err == nil || client.responses[1].err.Code != -32800 {
		t.Fatalf("responses=%+v", client.responses)
	}
}

func TestCodexInteractionsConcurrentApprovalHasOneWriter(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 64)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 8, client)
	interactions.Handle(codexServerRequest(t, `42`, "item/commandExecution/requestApproval", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","startedAtMs":1,
		"availableDecisions":["accept"]
	}`))
	asked := nextCodexEvent(t, output, "approval_request")
	const writers = 20
	var wg sync.WaitGroup
	results := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- interactions.ResolveApproval(context.Background(), "thr_1", asked.RequestID, "once")
		}()
	}
	wg.Wait()
	close(results)
	won := 0
	for err := range results {
		if err == nil {
			won++
			continue
		}
		var elsewhere *ResolvedElsewhereError
		if !errors.As(err, &elsewhere) {
			t.Fatalf("unexpected error=%v", err)
		}
	}
	client.responseMu.Lock()
	responses := len(client.responses)
	client.responseMu.Unlock()
	if won != 1 || responses != 1 {
		t.Fatalf("winners=%d responses=%d", won, responses)
	}
}

func TestCodexInteractionsMcpFormElicitationValidatesAndResponds(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 16)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 9, client)
	interactions.Handle(codexServerRequest(t, `77`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","turnId":"turn_1","serverName":"github","mode":"form",
		"message":"Configure request","requestedSchema":{"type":"object","required":["repo","retries"],"properties":{
			"repo":{"type":"string","minLength":2},
			"retries":{"type":"integer","minimum":1,"maximum":5},
			"dryRun":{"type":"boolean"},
			"regions":{"type":"array","items":{"type":"string","enum":["us","eu"]},"minItems":1}
		}}
	}`))
	asked := nextCodexEvent(t, output, "mcp_elicitation_request")
	if asked.MCPServer != "github" || asked.ElicitationMode != "form" || asked.Message != "Configure request" || len(asked.ElicitationSchema) == 0 {
		t.Fatalf("elicitation=%+v", asked)
	}
	if err := interactions.ResolveMcpElicitation(context.Background(), "thr_1", asked.RequestID, "accept", json.RawMessage(`{"repo":"x","retries":0,"regions":[]}`)); err == nil {
		t.Fatal("invalid form content was accepted")
	}
	content := json.RawMessage(`{"repo":"pocketctl","retries":2,"dryRun":true,"regions":["us"]}`)
	if err := interactions.ResolveMcpElicitation(context.Background(), "thr_1", asked.RequestID, "accept", content); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	response := client.responses[len(client.responses)-1]
	client.responseMu.Unlock()
	var payload struct {
		Action  string          `json:"action"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(response.result, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Action != "accept" || string(payload.Content) != string(content) {
		t.Fatalf("response=%s", response.result)
	}
	resolved := nextCodexEvent(t, output, "mcp_elicitation_resolved")
	if resolved.Action != "accept" || len(resolved.ElicitationContent) != 0 {
		t.Fatalf("resolved event persisted form content: %+v", resolved)
	}
}

func TestSessionManagerRoutesMcpElicitationDecline(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	coord := newCodexCoordinator(sm)
	interactions := newCodexInteractions(sm, 10, client)
	coord.interactions = interactions
	sm.codexProvider = &CodexRuntimeProvider{sm: sm, coordinator: coord}
	interactions.Handle(codexServerRequest(t, `78`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","serverName":"github","mode":"url","message":"Authorize","elicitationId":"e1","url":"https://example.test/auth"
	}`))
	asked := nextCodexEvent(t, output, "mcp_elicitation_request")
	if asked.ElicitationMode != "url" || asked.URL != "https://example.test/auth" || asked.ElicitationID != "e1" {
		t.Fatalf("url elicitation=%+v", asked)
	}
	if err := sm.ResolveMcpElicitation("thr_1", asked.RequestID, "decline", nil); err != nil {
		t.Fatal(err)
	}
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	if len(client.responses) != 1 || string(client.responses[0].result) != `{"action":"decline"}` {
		t.Fatalf("responses=%+v", client.responses)
	}
}

func TestCodexInteractionsRejectsUnsafeMcpURLAndDoesNotClassifyElicitationAsApproval(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 8)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 12, client)
	interactions.Handle(codexServerRequest(t, `80`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","serverName":"unsafe","mode":"url","message":"Open","url":"javascript:alert(1)"
	}`))
	select {
	case event := <-output:
		t.Fatalf("unsafe URL was advertised remotely: %+v", event)
	default:
	}
	interactions.Handle(codexServerRequest(t, `81`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","serverName":"github","mode":"url","message":"Open","url":"https://example.test/auth"
	}`))
	asked := nextCodexEvent(t, output, "mcp_elicitation_request")
	if interactions.KnowsApproval("thr_1", asked.RequestID) {
		t.Fatal("MCP elicitation was classified as an approval")
	}
}

func TestCodexInteractionsLeavesUnsupportedOpenAIFormToOfficialTUI(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 2)
	sm := NewSessionManager(output)
	client := newInteractionCodexClient()
	interactions := newCodexInteractions(sm, 11, client)
	interactions.Handle(codexServerRequest(t, `79`, "mcpServer/elicitation/request", `{
		"threadId":"thr_1","serverName":"custom","mode":"openai/form","message":"Unsupported","requestedSchema":{"providerSpecific":true}
	}`))
	select {
	case event := <-output:
		t.Fatalf("unsupported form was advertised remotely: %+v", event)
	default:
	}
	client.responseMu.Lock()
	defer client.responseMu.Unlock()
	if len(client.responses) != 0 {
		t.Fatalf("unsupported form was answered by daemon: %+v", client.responses)
	}
}
