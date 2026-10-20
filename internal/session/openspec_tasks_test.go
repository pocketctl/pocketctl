package session

import (
	"github.com/pocketctl/pocketctl/internal/protocol"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOpenSpecTasksBoundSourcesAndRestart(t *testing.T) {
	root := t.TempDir()
	rel := "openspec/changes/feature/tasks.md"
	path := filepath.Join(root, rel)
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte("- [ ] 1. Build\n- [x] 2. Test\n```md\n- [ ] example\n```\n"), 0600)
	cwd := func(string) (string, bool) { return root, true }
	tracker := NewOpenSpecTasks(cwd)
	state := filepath.Join(t.TempDir(), "bindings.json")
	if err := tracker.LoadBindings(state); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if got := tracker.Poll(now); len(got) != 0 {
		t.Fatal("cwd must not implicitly bind changes")
	}
	tracker.Observe(protocol.DaemonEvent{Type: "agent_file_change", SessionID: "s", Path: rel})
	events := tracker.Poll(now)
	if len(events) != 1 || len(events[0].Plan) != 2 || events[0].Plan[0].Status != "pending" || events[0].Plan[1].Status != "completed" {
		t.Fatalf("bad snapshot: %+v", events)
	}
	if len(tracker.Poll(now)) != 0 {
		t.Fatal("unchanged snapshot emitted")
	}
	restart := NewOpenSpecTasks(cwd)
	if err := restart.LoadBindings(state); err != nil {
		t.Fatal(err)
	}
	replayed := restart.Poll(now)
	if len(replayed) != 1 || replayed[0].EventID != events[0].EventID || replayed[0].Revision != events[0].Revision {
		t.Fatalf("restart must idempotently replay possibly undelivered snapshot: %+v", replayed)
	}
	os.WriteFile(path, []byte("- [x] 1. Build\n"), 0600)
	next := restart.Poll(now)
	if len(next) != 1 || next[0].PreviousEventID != events[0].EventID || next[0].Revision <= events[0].Revision {
		t.Fatalf("restart lost causal identity: %+v", next)
	}
	os.Remove(path)
	cleared := restart.Poll(now.Add(time.Second))
	if len(cleared) != 1 || cleared[0].Status != "cleared" {
		t.Fatalf("missing tombstone: %+v", cleared)
	}
}
func TestOpenSpecSymlinkEscapeDoesNotClear(t *testing.T) {
	root := t.TempDir()
	rel := "openspec/changes/f/tasks.md"
	path := filepath.Join(root, rel)
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte("- [ ] Work"), 0600)
	tracker := NewOpenSpecTasks(func(string) (string, bool) { return root, true })
	tracker.Observe(protocol.DaemonEvent{Type: "agent_file_change", SessionID: "s", Path: rel})
	if len(tracker.Poll(time.Now())) != 1 {
		t.Fatal("missing initial snapshot")
	}
	outside := filepath.Join(t.TempDir(), "secret")
	os.WriteFile(outside, []byte("- [x] Outside"), 0600)
	os.Remove(path)
	os.Symlink(outside, path)
	if len(tracker.Poll(time.Now())) != 0 {
		t.Fatal("escape must preserve last known snapshot")
	}
}

func TestOpenSpecExplicitCommandsAndUnrelatedSessions(t *testing.T) {
	root := t.TempDir()
	tracker := NewOpenSpecTasks(func(string) (string, bool) { return root, true })
	tracker.Observe(protocol.DaemonEvent{Type: "user_text", SessionID: "a", Text: "/opsx:apply feature"})
	tracker.Observe(protocol.DaemonEvent{Type: "tool_use", SessionID: "b", Input: []byte(`{"cmd":"cat openspec/changes/second/tasks.md"}`)})
	tracker.Observe(protocol.DaemonEvent{Type: "tool_use", SessionID: "c", Input: []byte(`{"file_path":"/outside/openspec/changes/private/tasks.md"}`)})
	tracker.Observe(protocol.DaemonEvent{Type: "tool_use", SessionID: "a", AgentID: "child", Path: "openspec/changes/child/tasks.md"})
	if len(tracker.bindings) != 2 {
		t.Fatalf("unexpected bindings: %+v", tracker.bindings)
	}
}
