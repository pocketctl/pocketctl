package watcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/turn"
)

func TestCodexTailerSeedsRolloutSessionForNativeTurn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	const sessionID = "rollout-live-session"
	const sourceTurnID = "turn-live-1"
	if err := os.WriteFile(path, []byte(`{"type":"session_meta","payload":{"id":"`+sessionID+`"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	tailer, err := NewJSONLTailer(path, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()

	appended := `{"type":"event_msg","payload":{"type":"task_started","turn_id":"` + sourceTurnID + `"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"agent_message","message":"live output"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"` + sourceTurnID + `"}}` + "\n"
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(appended); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	events, _, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 5 {
		t.Fatalf("events = %+v", events)
	}
	wantTurnID := turn.LogicalTurnID(adapter.AgentCodex, sessionID, "", "native", sourceTurnID)
	for _, index := range []int{0, 2, 3} {
		event := events[index]
		if event.SessionID != sessionID || event.TurnID != wantTurnID || event.SourceTurnID != sourceTurnID ||
			event.TurnOrigin != protocol.TurnOriginNative || event.TurnConfidence != protocol.TurnConfidenceNative {
			t.Fatalf("event[%d] missing live native turn identity: %+v", index, event)
		}
	}
	if events[0].Type != protocol.EventTypeTurnStatus || events[0].TurnStatus != protocol.TurnStateRunning ||
		events[2].Type != "agent_text" || events[3].Type != protocol.EventTypeTurnStatus || events[3].TurnStatus != protocol.TurnStateCompleted {
		t.Fatalf("unexpected lifecycle sequence: %+v", events)
	}
}

func TestCodexDesktopTailerParsesCodexUserAssistantToolModelAndUsageEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout-desktop.jsonl")
	lines := []string{
		`{"type":"session_meta","payload":{"id":"desktop-parser","originator":"Codex Desktop"}}`,
		`{"type":"turn_context","payload":{"model":"gpt-5.6"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"desktop question"}}`,
		`{"type":"event_msg","payload":{"type":"agent_message","message":"desktop answer","phase":"final_answer"}}`,
		`{"type":"response_item","payload":{"type":"function_call","call_id":"desktop-call","name":"exec","arguments":"{}"}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"desktop-call","output":"done"}}`,
		`{"type":"event_msg","payload":{"type":"token_count","last_token_usage":{"input_tokens":13,"output_tokens":5}}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Desktop is the published session identity; its persisted format remains
	// Codex JSONL and therefore must be selected explicitly here.
	tailer, err := NewJSONLTailerFromStart(path, adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	events, _, err := tailer.TailNewLines()
	if err != nil {
		t.Fatal(err)
	}

	seen := map[string]bool{}
	for _, event := range events {
		switch event.Type {
		case "session_model_changed":
			seen["model"] = event.Model == "gpt-5.6"
		case "user_text":
			seen["user"] = seen["user"] || event.Text == "desktop question"
		case "agent_text":
			seen["assistant"] = seen["assistant"] || event.Text == "desktop answer"
		case "tool_call":
			seen["tool_call"] = event.CallID == "desktop-call" && event.Tool == "exec"
		case "tool_result":
			seen["tool_result"] = event.CallID == "desktop-call" && event.Output == "done"
		}
		if event.Usage != nil && event.Usage.InputTokens == 13 && event.Usage.OutputTokens == 5 {
			seen["usage"] = true
		}
	}
	for _, key := range []string{"model", "user", "assistant", "tool_call", "tool_result", "usage"} {
		if !seen[key] {
			t.Fatalf("missing Codex %s event from Desktop history: events=%+v", key, events)
		}
	}
}

func TestCodexDesktopObserverTailerUsesStablePositionBasedEventIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout-desktop-stable.jsonl")
	lines := []string{
		`{"type":"session_meta","payload":{"id":"desktop-stable","originator":"Codex Desktop"}}`,
		`{"type":"event_msg","payload":{"type":"agent_message","message":"same fixture text"}}`,
		`{"type":"event_msg","payload":{"type":"agent_message","message":"same fixture text"}}`,
		`{"type":"event_msg","payload":{"type":"task_started","turn_id":"fixture-turn"}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	read := func() []protocol.DaemonEvent {
		t.Helper()
		tailer, err := NewCodexObserverJSONLTailerFromStart(path)
		if err != nil {
			t.Fatal(err)
		}
		defer tailer.Close()
		events, _, err := tailer.TailNewLines()
		if err != nil {
			t.Fatal(err)
		}
		return events
	}

	first := read()
	second := read()
	if len(first) != 4 || len(second) != len(first) {
		t.Fatalf("events first=%+v second=%+v", first, second)
	}
	for i := range first {
		if first[i].EventID == "" || first[i].EventID != second[i].EventID {
			t.Fatalf("event[%d] unstable identity: first=%q second=%q", i, first[i].EventID, second[i].EventID)
		}
	}
	// Identical content on two physical source records is two legitimate native
	// events, so line position (not content alone) must keep their IDs distinct.
	if first[0].EventID == first[1].EventID {
		t.Fatalf("identical physical records collided at %q", first[0].EventID)
	}
	// One task_started record projects turn_status plus session_status; the
	// per-record output ordinal keeps those two distinct without losing restart stability.
	if first[2].EventID == first[3].EventID {
		t.Fatalf("multiple projections from one record collided at %q", first[2].EventID)
	}
}

func TestCodexDesktopObserverTailerCanonicalizesStableSourcePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-desktop-path.jsonl")
	content := []byte(`{"type":"event_msg","payload":{"type":"agent_message","message":"fixture"}}` + "\n")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	relativePath, err := filepath.Rel(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	cleanEquivalentPath := filepath.Dir(path) + string(os.PathSeparator) + "." + string(os.PathSeparator) + filepath.Base(path)

	readID := func(sourcePath string) string {
		t.Helper()
		tailer, err := NewCodexObserverJSONLTailerFromStart(sourcePath)
		if err != nil {
			t.Fatal(err)
		}
		defer tailer.Close()
		events, _, err := tailer.TailNewLines()
		if err != nil {
			t.Fatal(err)
		}
		if len(events) != 1 || events[0].EventID == "" {
			t.Fatalf("events for %q = %+v", sourcePath, events)
		}
		return events[0].EventID
	}

	absoluteID := readID(path)
	if relativeID := readID(relativePath); relativeID != absoluteID {
		t.Fatalf("relative alias changed source identity: absolute=%q relative=%q", absoluteID, relativeID)
	}
	if equivalentID := readID(cleanEquivalentPath); equivalentID != absoluteID {
		t.Fatalf("clean-equivalent alias changed source identity: absolute=%q equivalent=%q", absoluteID, equivalentID)
	}

	otherPath := filepath.Join(dir, "rollout-desktop-other.jsonl")
	if err := os.WriteFile(otherPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if otherID := readID(otherPath); otherID == absoluteID {
		t.Fatalf("different rollout files collided at %q", absoluteID)
	}
}
