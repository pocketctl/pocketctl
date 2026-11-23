package session

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexTerminalDialogueProof(t *testing.T) {
	c := &codexCoordinator{}
	c.rememberDialogueInputLocked(UserMessageInput{SessionID: "session", RequestID: "request", MsgID: "msg"}, "native", "turn", "问题")
	in := c.dialogueInputs["session"]
	user := codexDialogueItem{ID: "native-user", ClientID: "msg", Type: "userMessage", Content: json.RawMessage(`[{"type":"text","text":"问题"}]`)}
	final := codexDialogueItem{ID: "answer", Type: "agentMessage", Phase: "final_answer", Text: "回复"}
	read := codexDialogueItem{ID: "inspect", Type: "commandExecution", Command: "cat README.md", CommandActions: []codexCommandAction{{Type: "read", Path: "README.md", Command: "cat README.md"}}}
	turn := codexDialogueTurn{ID: "native", Status: "completed", View: "full", Items: []codexDialogueItem{user, read, final}}
	p := in.proof(turn)
	// Shared wire vector with turn-dialogue.test.ts. Hash exact UTF-8 bytes.
	if p == nil || p.EventID != "codex-dialogue-v1:2911fdb3e1e9780213edb8d94c01114588ee30fe0a806b4887fc874fdbe3e4d7" {
		t.Fatal("missing or incompatible terminal proof")
	}
	edit := turn
	edit.Items = append([]codexDialogueItem(nil), turn.Items...)
	edit.Items[1] = codexDialogueItem{ID: "edit", Type: "fileChange", Changes: []codexDialogueFile{{Path: "main.go", Kind: codexFileChangeKind{Type: "update"}}}}
	if in.proof(edit) == nil {
		t.Fatal("ordinary native edit dropped dialogue proof")
	}
	edit.Items[1].Changes[0].Kind.MovePath = ".codex/skills/unit/SKILL.md"
	if in.proof(edit) != nil {
		t.Fatal("skill edit was eligible")
	}

	for _, mutate := range []func(*codexDialogueTurn){
		func(t *codexDialogueTurn) { t.View = "summary" }, func(t *codexDialogueTurn) { t.ID = "another" },
		func(t *codexDialogueTurn) { t.Status = "inProgress" }, func(t *codexDialogueTurn) { t.Items[0].ClientID = "other" },
		func(t *codexDialogueTurn) { t.Items[0].Content = json.RawMessage(`[{"type":"text","text":"other"}]`) },
		func(t *codexDialogueTurn) { t.Items[1] = user }, func(t *codexDialogueTurn) { t.Items[1] = final },
		func(t *codexDialogueTurn) { t.Items[1].Type = "mcpToolCall" }, func(t *codexDialogueTurn) { t.Items[1].Type = "collabAgentToolCall" },
		func(t *codexDialogueTurn) { t.Items[1].Command = "git commit" }, func(t *codexDialogueTurn) { t.Items[1].PluginID = "skill" },
		func(t *codexDialogueTurn) {
			t.Items[0].Content = json.RawMessage(`[{"type":"skill","name":"example"}]`)
		},
	} {
		bad := turn
		bad.Items = append([]codexDialogueItem(nil), turn.Items...)
		mutate(&bad)
		if in.proof(bad) != nil {
			t.Fatalf("accepted ambiguous turn %+v", bad)
		}
	}
}

func TestCodexDialogueUsesExactFullTerminalHistory(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	b.coord.runtime.PrivateStdio = false
	b.coord.runtime.RemoteURI = "unix:///fixture.sock"
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "request", MsgID: "msg"})
	page := json.RawMessage(`{"data":[{"id":"native","status":"completed","itemsView":"full","items":[{"type":"userMessage","clientId":"msg","content":[{"type":"text","text":"问题"}],"id":"u"},{"type":"agentMessage","phase":"final_answer","text":"回复","id":"a"}]}]}`)
	rpc.results["thread/turns/list"] = page
	if err := b.startTurn(ctx, "session", "问题", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	terminal := json.RawMessage(`{"threadId":"session","turn":{"id":"native","status":"completed","itemsView":"notLoaded"}}`)
	if p := b.coord.completedDialogueProof(b.generation, "session", terminal); p == nil || p.ParentInvocationID != protocol.MemoryInputEventID("session", "request", "msg") {
		t.Fatal("completed shared-terminal turn lost its accepted input")
	}
	// A replay or a second terminal has no outstanding dispatch to certify.
	if b.coord.completedDialogueProof(b.generation, "session", terminal) != nil {
		t.Fatal("reused a consumed dispatch")
	}
	if err := b.startTurn(ctx, "session", "问题", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	rpc.results["thread/turns/list"] = json.RawMessage(strings.Replace(string(page), `"id":"native"`, `"id":"successor"`, 1))
	if b.coord.completedDialogueProof(b.generation, "session", terminal) != nil {
		t.Fatal("bound a successor turn")
	}
}
