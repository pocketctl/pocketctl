package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestCodexTerminalHydrationRetainsStableReplayIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	raw := `{"type":"event_msg","payload":{"type":"agent_message","message":"same synthetic text"}}` + "\n"
	if err := os.WriteFile(path, []byte(raw+raw), 0600); err != nil {
		t.Fatal(err)
	}
	read := func() []protocol.DaemonEvent {
		t.Helper()
		tailer, err := newTerminalHydrationTailer(path, "session", adapter.AgentCodex)
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
	first, replay := read(), read()
	if len(first) != 2 || len(replay) != 2 {
		t.Fatal("missing source records")
	}
	for i := range first {
		if first[i].EventID == "" || first[i].EventID != replay[i].EventID {
			t.Fatalf("CLI history lacks restart-stable ID at record %d: %q / %q", i, first[i].EventID, replay[i].EventID)
		}
	}
	if first[0].EventID == first[1].EventID {
		t.Fatal("legitimate identical sends collapsed")
	}
}
