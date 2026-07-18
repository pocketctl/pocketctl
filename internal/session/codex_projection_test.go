package session

import (
	"encoding/json"
	"testing"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func codexNotification(method, params string) codexapp.Inbound {
	return codexapp.Inbound{Method: method, Params: json.RawMessage(params)}
}

func TestCodexProjectionThreadAndTurnLifecycle(t *testing.T) {
	p := newCodexProjection(7)

	events := p.Project(codexNotification("thread/started", `{
		"thread":{"id":"thr_1","cwd":"/repo","name":"Managed task","status":{"type":"idle"}}
	}`))
	if len(events) != 1 {
		t.Fatalf("thread events=%+v", events)
	}
	if got := events[0]; got.Type != "session_discovered" || got.SessionID != "thr_1" || got.Cwd != "/repo" || got.Title != "Managed task" || got.Agent != "codex" || got.ControlMode != protocol.ControlManaged || got.Status != protocol.StatusIdle {
		t.Fatalf("thread event=%+v", got)
	}

	events = p.Project(codexNotification("turn/started", `{
		"threadId":"thr_1","turn":{"id":"turn_1","status":"inProgress","items":[]}
	}`))
	if len(events) != 1 || events[0].Type != "session_status" || events[0].SessionID != "thr_1" || events[0].Status != protocol.StatusRunning {
		t.Fatalf("turn started=%+v", events)
	}

	events = p.Project(codexNotification("turn/completed", `{
		"threadId":"thr_1","turn":{"id":"turn_1","status":"completed","items":[]}
	}`))
	if len(events) != 1 || events[0].Status != protocol.StatusCompleted {
		t.Fatalf("turn completed=%+v", events)
	}
	if duplicate := p.Project(codexNotification("turn/completed", `{
		"threadId":"thr_1","turn":{"id":"turn_1","status":"completed","items":[]}
	}`)); len(duplicate) != 0 {
		t.Fatalf("duplicate completion=%+v", duplicate)
	}
	late := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1","completedAtMs":124,
		"item":{"id":"late_1","type":"agentMessage","text":"late"}
	}`))
	if len(late) != 1 || late[0].Type != "agent_text" {
		t.Fatalf("late completed item re-opened turn=%+v", late)
	}
}

func TestCodexProjectionAgentDeltaAndAuthoritativeCompletion(t *testing.T) {
	p := newCodexProjection(3)

	first := p.Project(codexNotification("item/agentMessage/delta", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"item_1","delta":"Hel"
	}`))
	if len(first) != 2 || first[0].Type != "session_status" || first[0].Status != protocol.StatusRunning {
		t.Fatalf("late subscription synthesis=%+v", first)
	}
	assertCodexTextEvent(t, first[1], "Hel", "Hel", 1, false, true)

	second := p.Project(codexNotification("item/agentMessage/delta", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"item_1","delta":"lo"
	}`))
	if len(second) != 1 {
		t.Fatalf("second delta=%+v", second)
	}
	assertCodexTextEvent(t, second[0], "lo", "Hello", 2, false, true)

	completed := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1","completedAtMs":123,
		"item":{"id":"item_1","type":"agentMessage","text":"Hello","phase":"final_answer"}
	}`))
	if len(completed) != 1 {
		t.Fatalf("completed=%+v", completed)
	}
	assertCodexTextEvent(t, completed[0], "Hello", "Hello", 3, true, false)
	if duplicate := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1","completedAtMs":123,
		"item":{"id":"item_1","type":"agentMessage","text":"Hello","phase":"final_answer"}
	}`)); len(duplicate) != 0 {
		t.Fatalf("duplicate item completion=%+v", duplicate)
	}
}

func TestCodexProjectionUserCommandFileAndUsage(t *testing.T) {
	p := newCodexProjection(1)

	user := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1","completedAtMs":1,
		"item":{"id":"user_1","type":"userMessage","content":[{"type":"text","text":"fix it"},{"type":"localImage","path":"/tmp/a.png"}]}
	}`))
	if len(user) != 2 || user[1].Type != "user_text" || user[1].Text != "fix it" || user[1].PartID != "user_1" {
		t.Fatalf("user=%+v", user)
	}

	started := p.Project(codexNotification("item/started", `{
		"threadId":"thr_1","turnId":"turn_1","startedAtMs":2,
		"item":{"id":"cmd_1","type":"commandExecution","command":"go test ./...","cwd":"/repo","status":"inProgress","commandActions":[]}
	}`))
	if len(started) != 1 || started[0].Type != "tool_call" || started[0].CallID != "cmd_1" || started[0].Tool != "commandExecution" || started[0].Status != "inProgress" {
		t.Fatalf("command start=%+v", started)
	}
	var input map[string]any
	if err := json.Unmarshal(started[0].Input, &input); err != nil || input["command"] != "go test ./..." || input["cwd"] != "/repo" {
		t.Fatalf("command input=%s err=%v", started[0].Input, err)
	}

	output := p.Project(codexNotification("item/commandExecution/outputDelta", `{
		"threadId":"thr_1","turnId":"turn_1","itemId":"cmd_1","delta":"ok\n"
	}`))
	if len(output) != 1 || output[0].Type != "tool_result" || output[0].CallID != "cmd_1" || output[0].Output != "ok\n" || !output[0].Streaming {
		t.Fatalf("command output=%+v", output)
	}

	commandDone := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1","completedAtMs":3,
		"item":{"id":"cmd_1","type":"commandExecution","command":"go test ./...","cwd":"/repo","status":"completed","commandActions":[],"aggregatedOutput":"ok\n","exitCode":0}
	}`))
	if len(commandDone) != 1 || commandDone[0].Type != "tool_result" || commandDone[0].Output != "ok\n" || commandDone[0].Status != "completed" || commandDone[0].Streaming {
		t.Fatalf("command completed=%+v", commandDone)
	}

	file := p.Project(codexNotification("item/completed", `{
		"threadId":"thr_1","turnId":"turn_1","completedAtMs":4,
		"item":{"id":"patch_1","type":"fileChange","status":"completed","changes":[{"path":"a.go","kind":"update","diff":"@@"}]}
	}`))
	if len(file) != 1 || file[0].Type != "tool_result" || file[0].Tool != "fileChange" || len(file[0].Files) != 1 || file[0].Files[0] != "a.go" {
		t.Fatalf("file=%+v", file)
	}

	usage := p.Project(codexNotification("thread/tokenUsage/updated", `{
		"threadId":"thr_1","turnId":"turn_1","tokenUsage":{"last":{"inputTokens":10,"cachedInputTokens":4,"outputTokens":3,"reasoningOutputTokens":2,"totalTokens":13},"total":{"inputTokens":10,"cachedInputTokens":4,"outputTokens":3,"reasoningOutputTokens":2,"totalTokens":13}}
	}`))
	if len(usage) != 1 || usage[0].Type != "agent_text" || usage[0].Usage == nil || usage[0].Usage.InputTokens != 10 || usage[0].Usage.OutputTokens != 3 || usage[0].Usage.CacheRead != 4 {
		t.Fatalf("usage=%+v", usage)
	}
}

func TestCodexProjectionThreadStatusAndGenerationIsolation(t *testing.T) {
	p1 := newCodexProjection(1)
	p2 := newCodexProjection(2)
	n := codexNotification("thread/status/changed", `{"threadId":"thr_1","status":{"type":"active","activeFlags":[]}}`)
	for name, events := range map[string][]protocol.DaemonEvent{"generation one": p1.Project(n), "generation two": p2.Project(n)} {
		if len(events) != 1 || events[0].Status != protocol.StatusRunning {
			t.Fatalf("%s=%+v", name, events)
		}
	}
	if duplicate := p1.Project(n); len(duplicate) != 0 {
		t.Fatalf("same-generation duplicate=%+v", duplicate)
	}
	idle := codexNotification("thread/status/changed", `{"threadId":"thr_1","status":{"type":"idle"}}`)
	if events := p1.Project(idle); len(events) != 1 || events[0].Status != protocol.StatusIdle {
		t.Fatalf("idle transition=%+v", events)
	}
	if events := p1.Project(n); len(events) != 1 || events[0].Status != protocol.StatusRunning {
		t.Fatalf("second active transition=%+v", events)
	}
}

func assertCodexTextEvent(t *testing.T, got protocol.DaemonEvent, text, snapshot string, revision int, replace, streaming bool) {
	t.Helper()
	if got.Type != "agent_text" || got.SessionID != "thr_1" || got.PartID != "item_1" || got.Text != text || got.Snapshot != snapshot || got.Revision != revision || got.Replace != replace || got.Streaming != streaming || got.EventID == "" {
		t.Fatalf("text event=%+v", got)
	}
}
