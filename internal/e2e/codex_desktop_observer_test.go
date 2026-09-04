//go:build !windows

package e2e

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

const desktopSessionID = "12121212-3434-5656-7878-909090909010"

func TestCodexDesktopRolloutProjectsObserverHistoryWithoutRestartDuplicates(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("POCKETCTL_CODEX_REPLAY_LOOKBACK", "0")
	t.Setenv("POCKETCTL_CODEX_EDITED_FILES", "1")

	now := time.Now().UTC().Truncate(time.Second)
	sourceActivity := now.Add(-90 * time.Second)
	rolloutPath := writeDesktopRollout(t, sourceActivity)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	codexWatcher := watcher.NewCodexSessionWatcher()
	if err := codexWatcher.Start(ctx); err != nil {
		t.Fatal(err)
	}

	var discovered watcher.SessionEvent
	select {
	case discovered = <-codexWatcher.Events():
	case <-time.After(3 * time.Second):
		t.Fatal("fresh Desktop rollout was not discovered")
	}
	if discovered.Action != "discovered" || discovered.Filepath != rolloutPath {
		t.Fatalf("watcher event = %+v", discovered)
	}
	wantSession := watcher.DiscoveredSession{
		SessionID: desktopSessionID, Cwd: "/fixture/project", Status: "busy",
		AgentType: adapter.AgentCodexDesktop, Source: "observer",
		ControlMode: protocol.ControlLegacyReadOnly, Capabilities: []string{"history_sync"},
	}
	if !reflect.DeepEqual(discovered.Session, wantSession) {
		t.Fatalf("Desktop watcher projection = %+v, want %+v", discovered.Session, wantSession)
	}

	managerEvents := make(chan protocol.DaemonEvent, 8)
	manager := session.NewSessionManager(managerEvents)
	if got := manager.RegisterObservedSession(
		discovered.Session.SessionID, discovered.Session.Cwd, discovered.Session.Status, discovered.Session.AgentType,
	); got != session.ObservedSessionNew {
		t.Fatalf("observer registration = %v, want new", got)
	}
	if restored, ok := manager.RestoreSessionActivity(desktopSessionID, sourceActivity); !ok || !restored.Equal(sourceActivity) {
		t.Fatalf("restored activity = %s, ok=%v", restored, ok)
	}

	first := readDesktopRollout(t, rolloutPath)
	assertDesktopHistory(t, first)
	for _, event := range first {
		if event.EventID == "" {
			t.Fatalf("restart-safe history event %s has no stable event_id: %+v", event.Type, event)
		}
		if event.Type == "session_model_changed" {
			manager.SetSessionModel(desktopSessionID, event.Model)
		}
	}

	manager.ResyncSessions()
	resync := <-managerEvents
	if resync.Type != "session_discovered" || resync.SessionID != desktopSessionID ||
		resync.Agent != adapter.AgentCodexDesktop || resync.Source != "observer" ||
		resync.ControlMode != protocol.ControlLegacyReadOnly ||
		!reflect.DeepEqual(resync.Capabilities, []string{"history_sync"}) ||
		resync.Model != "gpt-5.6-fixture" || resync.Status != "busy" || !resync.Resync ||
		resync.LastActivityAt != sourceActivity.Format(time.RFC3339Nano) {
		t.Fatalf("reconnect discovery = %+v", resync)
	}

	second := readDesktopRollout(t, rolloutPath)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("daemon-restart replay identities drifted:\nfirst=%+v\nsecond=%+v", first, second)
	}

	steadyTailer, err := watcher.NewCodexObserverJSONLTailerFromStart(rolloutPath)
	if err != nil {
		t.Fatal(err)
	}
	defer steadyTailer.Close()
	if _, _, err := steadyTailer.TailNewLines(); err != nil {
		t.Fatal(err)
	}
	if duplicate, _, err := steadyTailer.TailNewLines(); err != nil || len(duplicate) != 0 {
		t.Fatalf("unchanged rollout emitted duplicates: events=%+v err=%v", duplicate, err)
	}

	if err := manager.SendMessageWithInput(context.Background(), session.UserMessageInput{
		SessionID: desktopSessionID, Content: "must stay read only", RequestID: "fixture-request",
	}); !errors.Is(err, adapter.ErrObserverReadOnly) {
		t.Fatalf("observer send error = %v, want observer_read_only", err)
	}
}

func TestCodexDesktopReclassificationPreservesActivityAndCodexCLIIdentity(t *testing.T) {
	output := make(chan protocol.DaemonEvent, 4)
	manager := session.NewSessionManager(output)
	if !manager.RegisterTerminalSession(desktopSessionID, "/fixture/project", 0, "", "exited", adapter.AgentCodex) {
		t.Fatal("initial Codex CLI session was not registered")
	}
	original := time.Date(2026, time.September, 1, 1, 2, 3, 0, time.UTC)
	if _, ok := manager.RestoreSessionActivity(desktopSessionID, original); !ok {
		t.Fatal("failed to seed source activity")
	}
	if got := manager.RegisterObservedSession(
		desktopSessionID, "/fixture/project", "busy", adapter.AgentCodexDesktop,
	); got != session.ObservedSessionReclassified {
		t.Fatalf("registration = %v, want reclassified", got)
	}

	manager.ResyncSessions()
	event := <-output
	if event.Agent != adapter.AgentCodexDesktop || event.Source != "observer" ||
		event.ControlMode != protocol.ControlLegacyReadOnly ||
		!reflect.DeepEqual(event.Capabilities, []string{"history_sync"}) ||
		event.LastActivityAt != original.Format(time.RFC3339Nano) {
		t.Fatalf("reclassified session = %+v", event)
	}
	if event.Status != "busy" {
		t.Fatalf("reclassified status = %q, want busy", event.Status)
	}
}

func writeDesktopRollout(t *testing.T, mtime time.Time) string {
	t.Helper()
	codexHome := os.Getenv("CODEX_HOME")
	oldDate := mtime.AddDate(0, 0, -3)
	dir := filepath.Join(codexHome, "sessions", oldDate.Format("2006"), oldDate.Format("01"), oldDate.Format("02"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-2026-09-01T01-02-03-"+desktopSessionID+".jsonl")
	lines := []string{
		`{"type":"session_meta","payload":{"id":"` + desktopSessionID + `","cwd":"/fixture/project","originator":"Codex Desktop","source":"vscode"}}`,
		`{"type":"turn_context","payload":{"model":"gpt-5.6-fixture","effort":"high"}}`,
		`{"type":"event_msg","payload":{"type":"task_started","turn_id":"fixture-turn-1"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"fixture user request"}}`,
		`{"type":"response_item","payload":{"type":"function_call","call_id":"fixture-call-1","name":"exec","arguments":{"cmd":"printf fixture"}}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"fixture-call-1","output":"fixture tool result"}}`,
		`{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"fixture-patch-1","turn_id":"fixture-turn-1","success":true,"status":"completed","changes":{"fixture.txt":{"type":"add","content":"fixture file\n"}}}}`,
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"fixture-plan-1","name":"update_plan","input":{"explanation":"fixture plan","plan":[{"step":"fixture step","status":"completed"}]}}}`,
		`{"type":"event_msg","payload":{"type":"agent_message","message":"fixture assistant response"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fixture assistant response"}]}}`,
		`{"type":"event_msg","payload":{"type":"token_count","last_token_usage":{"input_tokens":13,"cached_input_tokens":5,"output_tokens":8,"reasoning_output_tokens":3,"total_tokens":21}}}`,
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"fixture-turn-1"}}`,
	}
	content := []byte{}
	for _, line := range lines {
		content = append(content, line...)
		content = append(content, '\n')
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return path
}

func readDesktopRollout(t *testing.T, path string) []protocol.DaemonEvent {
	t.Helper()
	tailer, err := watcher.NewCodexObserverJSONLTailerFromStart(path)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	events, _, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}
	for i := range events {
		if events[i].SessionID == "" {
			events[i].SessionID = desktopSessionID
		}
		protocol.FinalizeAgentPlanEvent(&events[i])
	}
	return events
}

func assertDesktopHistory(t *testing.T, events []protocol.DaemonEvent) {
	t.Helper()
	wantTypes := []string{
		"session_model_changed", "session_meta", "turn_status", "session_status", "user_text",
		"tool_call", "tool_result", "agent_file_change", "tool_call", "agent_plan",
		"agent_text", "agent_text", "turn_status", "session_status",
	}
	gotTypes := make([]string, len(events))
	for i := range events {
		gotTypes[i] = events[i].Type
		if events[i].SessionID != desktopSessionID {
			t.Fatalf("event[%d] session_id = %q", i, events[i].SessionID)
		}
	}
	if !reflect.DeepEqual(gotTypes, wantTypes) {
		t.Fatalf("history order = %v, want %v", gotTypes, wantTypes)
	}
	if events[0].Model != "gpt-5.6-fixture" || events[1].Effort != "high" {
		t.Fatalf("model/effort projection = %+v / %+v", events[0], events[1])
	}
	if events[4].Text != "fixture user request" || events[5].Tool != "exec" ||
		events[6].Output != "fixture tool result" || events[7].Path != "fixture.txt" ||
		events[9].PartID != "plan:"+desktopSessionID || events[10].Text != "fixture assistant response" {
		t.Fatalf("history content projection = %+v", events)
	}
	usage := events[11].Usage
	if usage == nil || usage.InputTokens != 13 || usage.CacheRead != 5 || usage.OutputTokens != 8 ||
		usage.ReasoningTokens != 3 || usage.TotalTokens != 21 {
		t.Fatalf("usage projection = %+v", usage)
	}
	if events[2].TurnStatus != protocol.TurnStateRunning || events[12].TurnStatus != protocol.TurnStateCompleted ||
		events[2].TurnID == "" || events[2].TurnID != events[12].TurnID {
		t.Fatalf("turn lifecycle = %+v / %+v", events[2], events[12])
	}
	for _, index := range []int{2, 7, 9, 12} {
		if strings.HasPrefix(events[index].EventID, "jsonl:") {
			t.Fatalf("native semantic event[%d] was replaced by fallback identity %q", index, events[index].EventID)
		}
	}
	if !strings.HasPrefix(events[2].EventID, "turn:") || !strings.HasPrefix(events[12].EventID, "turn:") ||
		!strings.HasPrefix(events[7].EventID, "codex:file-change:") ||
		!strings.HasPrefix(events[9].EventID, "codex:plan:") {
		t.Fatalf("native semantic identities = turn %q/%q file %q plan %q",
			events[2].EventID, events[12].EventID, events[7].EventID, events[9].EventID)
	}
	for _, index := range []int{0, 1, 4, 5, 6, 8, 10, 11} {
		if !strings.HasPrefix(events[index].EventID, "jsonl:") {
			t.Fatalf("identity-less projection event[%d] did not receive a fallback ID: %q", index, events[index].EventID)
		}
	}
}
