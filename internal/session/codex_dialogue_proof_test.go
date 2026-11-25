package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func TestCodexTerminalDialogueProof(t *testing.T) {
	c := &codexCoordinator{}
	c.rememberDialogueInputLocked(UserMessageInput{SessionID: "session", RequestID: "request", MsgID: "msg"}, "native", "turn", "问题")
	in := c.dialogueInputs[codexDialogueKey{"session", "native"}]
	user := codexDialogueItem{ID: "native-user", ClientID: "msg", Type: "userMessage", Content: json.RawMessage(`[{"type":"text","text":"问题"}]`)}
	final := codexDialogueItem{ID: "answer", Type: "agentMessage", Phase: "final_answer", Text: "回复"}
	read := codexDialogueItem{ID: "inspect", Type: "commandExecution", Command: "cat README.md", CommandActions: []codexCommandAction{{Type: "read", Path: "README.md", Command: "cat README.md"}}}
	turn := codexDialogueTurn{ID: "native", Status: "completed", View: "full", Items: []codexDialogueItem{user, read, final}}
	p, _ := in.certify(turn)
	// Shared wire vector with turn-dialogue.test.ts. Hash exact UTF-8 bytes.
	if p == nil || p.EventID != "codex-dialogue-v1:2911fdb3e1e9780213edb8d94c01114588ee30fe0a806b4887fc874fdbe3e4d7" {
		t.Fatal("missing or incompatible terminal proof")
	}
	edit := turn
	edit.Items = append([]codexDialogueItem(nil), turn.Items...)
	edit.Items[1] = codexDialogueItem{ID: "edit", Type: "fileChange", Changes: []codexDialogueFile{{Path: "main.go", Kind: codexFileChangeKind{Type: "update"}}}}
	if p, _ := in.certify(edit); p == nil {
		t.Fatal("ordinary native edit dropped dialogue proof")
	}
	edit.Items[1].Changes[0].Kind.MovePath = ".codex/skills/unit/SKILL.md"
	if p, _ := in.certify(edit); p != nil {
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
		if p, _ := in.certify(bad); p != nil {
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
	if p := b.coord.completedDialogueReceipt(b.generation, "session", terminal); p == nil || p.ParentInvocationID != protocol.MemoryInputEventID("session", "request", "msg") {
		t.Fatal("completed shared-terminal turn lost its accepted input")
	}
	// A replay or a second terminal has no outstanding dispatch to certify.
	if b.coord.completedDialogueReceipt(b.generation, "session", terminal) != nil {
		t.Fatal("reused a consumed dispatch")
	}
	if err := b.startTurn(ctx, "session", "问题", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	rpc.results["thread/turns/list"] = json.RawMessage(strings.Replace(string(page), `"id":"native"`, `"id":"successor"`, 1))
	if p := b.coord.completedDialogueReceipt(b.generation, "session", terminal); p == nil || p.LineageComplete || p.SourceGapReason != "codex_history_unavailable" {
		t.Fatalf("wrong receipt for missing native turn: %+v", p)
	}
}

func TestCodexDialogueReceiptPreservesPreviousAcceptedTurn(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "first-request", MsgID: "first-msg"})
	if err := b.startTurn(ctx, "session", "question", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"next"}}`)
	ctx = withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "next-request", MsgID: "next-msg"})
	if err := b.startTurn(ctx, "session", "question", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[{"id":"next","status":"inProgress","itemsView":"full","items":[]},{"id":"native","status":"completed","itemsView":"full","items":[{"type":"userMessage","id":"u","clientId":"first-msg","content":[{"type":"text","text":"question"}]},{"type":"agentMessage","id":"a","phase":"final_answer","text":"reply"}]}]}`)
	terminal := json.RawMessage(`{"threadId":"session","turn":{"id":"native","status":"completed","itemsView":"notLoaded"}}`)
	proof := b.coord.completedDialogueReceipt(b.generation, "session", terminal)
	if proof == nil || proof.ParentInvocationID != protocol.MemoryInputEventID("session", "first-request", "first-msg") {
		t.Fatalf("lost exact prior accepted turn: %+v", proof)
	}
}
func TestObservedMemoryPathSurvivesWire(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	sm.sessions["s"] = &ProcessState{SessionID: "s", Agent: "codex", Source: "terminal"}
	for _, tc := range []struct {
		resync       bool
		path, reason string
	}{{false, "readonly_observation", "no_live_dispatch_binding"}, {true, "historical_resync", "historical_replay"}} {
		ev := protocol.DaemonEvent{Type: "user_text", SessionID: "s", TurnID: "t", EventID: "observed", Text: "PRIVATE", MemoryNative: &protocol.MemoryNativeEvent{Producer: "codex", RecordID: "record"}, Resync: tc.resync}
		sm.EnrichOutgoingEvent(&ev)
		wire, _ := json.Marshal(ev.MemorySource)
		var p map[string]any
		if json.Unmarshal(wire, &p) != nil || p["source_path"] != tc.path || p["source_gap_reason"] != tc.reason || p["accepted_input_event_id"] != nil || p["skill_state"] != "unknown" || p["lineage_complete"] != false || strings.Contains(string(wire), "PRIVATE") {
			t.Fatalf("observation provenance: %s", wire)
		}
	}
}

func TestCodexLiveCompletionWaitsForAcceptedInput(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	b.coord.runtime.PrivateStdio = false
	b.coord.runtime.RemoteURI = "unix:///fixture.sock"
	b.coord.markSubscribed("session")
	p := newCodexProjection(b.generation)
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "req", MsgID: "msg"})
	terminal := codexNotification("turn/completed", `{"threadId":"session","turn":{"id":"native","status":"completed","itemsView":"full","items":[{"type":"userMessage","clientId":"msg","content":[{"type":"text","text":"question"}],"id":"u"},{"type":"agentMessage","phase":"final_answer","text":"reply","id":"a"}]}}`)
	finished := make(chan struct{})
	// The reader and the dispatch writer use separate goroutines on the real client.
	w := &beforeReplyCodexClient{fakeCodexRuntimeClient: rpc, before: func() {
		b.coord.projectLive(p, codexNotification("item/completed", `{"threadId":"session","turnId":"native","item":{"type":"agentMessage","phase":"final_answer","text":"reply","id":"a"}}`))
		go func() { b.coord.projectLive(p, terminal); close(finished) }()
		select {
		case <-finished:
			t.Fatal("unacknowledged terminal reached projection")
		case <-time.After(20 * time.Millisecond):
		}
	}}
	b.client = w
	b.coord.mu.Lock()
	b.coord.runtime.Client = w
	b.coord.mu.Unlock()
	if err := b.startTurn(ctx, "session", "question", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("accepted terminal stuck")
	}
	accepted := protocol.MemoryInputEventID("session", "req", "msg")
	var root, answer, terminalSeen bool
	for _, ev := range drainEvents(b.sm.outputCh) {
		if ev.Type == protocol.EventTypeTurnStatus && !b.sm.ObserveTurnStatusEvent(ev) {
			continue
		}
		b.sm.EnrichOutgoingEvent(&ev)
		switch {
		case ev.Type == "user_text" && ev.MsgID == "msg":
			root = ev.MemorySource != nil && ev.MemorySource.SourcePath == "managed_dispatch" && ev.MemorySource.AcceptedInputEventID == accepted
		case ev.Type == "agent_text" && ev.MessagePhase == "final_answer":
			p := ev.MemorySource
			answer = p != nil && p.AcceptedInputEventID == accepted && !p.LineageComplete && p.SkillState == "unknown" && p.SourceGapReason == "accepted_input_without_output_binding"
		case ev.Type == protocol.EventTypeTurnStatus && ev.TurnStatus == protocol.TurnStateCompleted:
			p := ev.MemorySource
			terminalSeen = root && p != nil && p.LineageComplete && p.AcceptedInputEventID == accepted && p.ParentInvocationID == accepted && strings.HasPrefix(p.EventID, "codex-dialogue-v1:")
		}
	}
	if !root || !answer || !terminalSeen {
		t.Fatalf("root=%v final=%v completed certificate=%v", root, answer, terminalSeen)
	}
}

func TestCodexAcceptedSteerCannotAttributeFinalToFirstInput(t *testing.T) {
	b, rpc := nativeMemoryCodexBackend(t)
	b.sm.sessions["thread"] = &ProcessState{SessionID: "thread", Agent: adapter.AgentCodex, Source: "daemon", Backend: b}
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"native"}}`)
	ctx := withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "req1", MsgID: "msg1"})
	if err := b.startTurn(ctx, "thread", "question", protocol.SessionConfig{}); err != nil {
		t.Fatal(err)
	}
	drainEvents(b.sm.outputCh)
	rpc.results["turn/steer"] = json.RawMessage(`{"turnId":"native"}`)
	ctx = withUserMessageCorrelation(context.Background(), userMessageCorrelation{RequestID: "req2", MsgID: "msg2"})
	if err := b.send(ctx, "thread", "amendment"); err != nil {
		t.Fatal(err)
	}
	echo := findEvents(drainEvents(b.sm.outputCh), "user_text")
	if len(echo) != 1 || echo[0].MemorySource == nil || echo[0].MemorySource.AcceptedInputEventID != protocol.MemoryInputEventID("thread", "req2", "msg2") {
		t.Errorf("missing accepted steer input: %+v", echo)
	}
	p := newCodexProjection(b.generation)
	for _, ev := range p.Project(codexNotification("item/completed", `{"threadId":"thread","turnId":"native","item":{"type":"agentMessage","id":"a","phase":"final_answer","text":"reply"}}`)) {
		if ev.Type != "agent_text" {
			continue
		}
		b.sm.EnrichOutgoingEvent(&ev)
		if ev.MemorySource == nil || ev.MemorySource.LineageComplete || ev.MemorySource.AcceptedInputEventID != "" || ev.MemorySource.SourcePath != "managed_dispatch" || ev.MemorySource.SourceGapReason != "codex_input_unconfirmed" {
			t.Fatalf("multi-input final attributed to one input: %+v", ev.MemorySource)
		}
	}
}

// Ordinary live rollout tailers intentionally have no transport event_id.
// Exercise the physical reader through the outgoing classifier so its
// observation survives the provenance parser without granting a causal root.
func TestCodexRolloutObservationLocatorDoesNotClaimManagedInput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	const meta = `{"type":"session_meta","payload":{"id":"thread"}}`
	const start = `{"type":"event_msg","payload":{"type":"task_started","turn_id":"native"}}`
	const input = `{"type":"event_msg","payload":{"type":"user_message","message":"PRIVATE"}}`
	if err := os.WriteFile(path, []byte(meta+"\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	tailer, err := watcher.NewJSONLTailer(path, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString(strings.Join([]string{start, input, input, ""}, "\r\n"))
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 16))
	sm.sessions["thread"] = &ProcessState{SessionID: "thread", Agent: adapter.AgentCodex, Source: "terminal"}
	read := func(tailer *watcher.JSONLTailer) []string {
		evs, _, err := tailer.TailNewLines()
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, ev := range evs {
			if ev.Type != "user_text" {
				continue
			}
			sm.EnrichOutgoingEvent(&ev)
			p := ev.MemorySource
			if ev.EventID != "" || p == nil || !strings.HasPrefix(p.EventID, "observed:jsonl:") || p.SourcePath != "readonly_observation" || p.SourceGapReason != "native_metadata_unavailable" || p.LineageComplete || p.SkillState != "unknown" || p.AcceptedInputEventID != "" {
				t.Fatalf("observed input acquired a transport identity or lost its receipt: %+v", p)
			}
			ids = append(ids, p.EventID)
		}
		return ids
	}
	ids := read(tailer)
	reopened, err := watcher.NewJSONLTailerFromStart(path, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if other := read(reopened); len(ids) != 2 || ids[0] == ids[1] || !reflect.DeepEqual(ids, other) {
		t.Fatalf("unstable physical locators: %v vs %v", ids, other)
	}
}
