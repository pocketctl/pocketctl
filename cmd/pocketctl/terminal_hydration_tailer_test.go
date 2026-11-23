package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

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

func TestDesktopRolloutWakeReadsOnlyCompleteRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tailer, err := newTerminalHydrationTailer(path, "session", adapter.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	defer tailer.Close()
	n, err := newRolloutNotifications()
	if err != nil {
		t.Fatal(err)
	}
	defer n.watcher.Close()
	writes, cancel := n.subscribe(path)
	defer cancel()
	wait := func() {
		t.Helper()
		select {
		case <-writes:
		case <-time.After(3 * time.Second):
			t.Fatal("missing file wakeup")
		}
	}
	wait()
	write := func(text string) {
		t.Helper()
		if _, err := f.WriteString(text); err != nil {
			t.Fatal(err)
		}
		if err := f.Sync(); err != nil {
			t.Fatal(err)
		}
		wait()
	}
	write(`{"type":"event_msg","payload":{"type":"agent_message",`)
	if events, lines, err := tailer.TailNewLines(); err != nil || len(events)+len(lines) != 0 {
		t.Fatalf("published incomplete record: %v %v %v", events, lines, err)
	}
	write(`"message":"first"}}` + "\n")
	events, lines, err := tailer.TailNewLines()
	if err != nil || len(lines) != 1 || len(events) != 1 || events[0].EventID == "" {
		t.Fatalf("missing completed record: %v %v %v", events, lines, err)
	}
	if events, lines, err := tailer.TailNewLines(); err != nil || len(events)+len(lines) != 0 {
		t.Fatalf("poll duplicated notification: %v %v %v", events, lines, err)
	}
}
