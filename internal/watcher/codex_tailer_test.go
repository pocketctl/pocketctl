package watcher

import (
	"os"
	"path/filepath"
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
