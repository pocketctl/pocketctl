package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func TestCodexObserverHydrationRestoresNativeLifecycle(t *testing.T) {
	const sid = "desktop-hydration"
	const started = `{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}` + "\n"
	const completed = `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}` + "\n"
	const nextStarted = `{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}}` + "\n"
	for _, tc := range []struct {
		name, records, want string
	}{
		{"completed before restart", started + completed, protocol.StatusIdle},
		{"still running", started, protocol.StatusRunning},
		{"new turn after completed turn", started + completed + nextStarted, protocol.StatusRunning},
		{"no lifecycle evidence", "", protocol.StatusBusy},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rollout.jsonl")
			data := `{"type":"session_meta","payload":{"id":"` + sid + `","originator":"Codex Desktop","source":"vscode"}}` + "\n" + tc.records
			if err := os.WriteFile(path, []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
			// A second fresh manager/tailer verifies daemon restart recovery too.
			for restart := 0; restart < 2; restart++ {
				out := make(chan protocol.DaemonEvent, 32)
				sm := session.NewSessionManager(out)
				sm.RegisterObservedSession(sid, "/project", protocol.StatusBusy, adapter.AgentCodexDesktop)
				activity := time.Now().Add(-2 * time.Minute).UTC()
				sm.RestoreSessionActivity(sid, activity)
				tailer, err := watcher.NewCodexObserverJSONLTailerFromStart(path)
				if err != nil {
					t.Fatal(err)
				}
				events, _, err := tailer.TailNewLines()
				tailer.Close()
				if err != nil {
					t.Fatal(err)
				}
				projected := codexObserverHydrationEvents(sm, events, sid, protocol.StatusBusy)
				statuses := 0
				for _, event := range projected {
					if !event.Resync {
						t.Fatalf("history became live: %+v", event)
					}
					if event.Type == "session_status" {
						statuses++
						if event.Status != tc.want || event.SessionID != sid || event.EventID != "" {
							t.Fatalf("snapshot must reflect native state with no replay-deduplicated ID: %+v", event)
						}
					}
				}
				if statuses != 1 {
					t.Fatalf("got %d status snapshots", statuses)
				}
				local := sm.ListSessions()[0]
				if local.Status != tc.want || !local.LastActivityAt.Equal(activity) {
					t.Fatalf("local recovery changed activity or lost status: %+v", local)
				}
				if len(out) != 0 {
					t.Fatal("history restoration emitted live lifecycle events")
				}
				sm.ResyncSessions()
				if reconnect := <-out; reconnect.Status != tc.want {
					t.Fatalf("reconnect reverted recovered status: %+v", reconnect)
				}
				for _, status := range []string{protocol.StatusRunning, protocol.StatusIdle} {
					if !observeJSONLLifecycle(sm, protocol.DaemonEvent{Type: "session_status", SessionID: sid, Status: status}) {
						t.Fatal("live lifecycle rejected after hydration")
					}
					if sm.ListSessions()[0].Status != status {
						t.Fatalf("live status not applied: %s", status)
					}
				}
			}
		})
	}
}
