package watcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// newTestWatcher builds a SessionWatcher with initialized maps and a buffered
// event channel, without starting fsnotify — handlers can be driven directly.
func newTestWatcher() *SessionWatcher {
	return &SessionWatcher{
		eventsCh:      make(chan SessionEvent, 32),
		knownSessions: make(map[string]DiscoveredSession),
		fileToSession: make(map[string]string),
	}
}

func writeSessionFile(t *testing.T, path string, s DiscoveredSession) {
	t.Helper()
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestForkOnClearReDiscoversSession reproduces the /clear bug: Claude Code keeps
// one ~/.claude/sessions/<pid>.json per process and rewrites its sessionId in
// place when the conversation forks. The in-place Write must retire the old
// session and surface the new one as "discovered" (so a tailer starts), not a
// bare "changed" (which left the new session untailed until a daemon restart).
func TestForkOnClearReDiscoversSession(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "11723.json")
	const oldSid = "8c36190f-old"
	const newSid = "8d98966c-new"

	sw := newTestWatcher()

	// Initial discovery of the terminal session.
	writeSessionFile(t, pidFile, DiscoveredSession{Pid: 11723, SessionID: oldSid, Cwd: "/x", Status: "idle"})
	sw.handleNewFile(pidFile)

	// /clear: same per-PID file, new sessionId, arrives as a Write.
	writeSessionFile(t, pidFile, DiscoveredSession{Pid: 11723, SessionID: newSid, Cwd: "/x", Status: "busy"})
	sw.handleChangedFile(pidFile)

	events := drainEvents(sw.eventsCh)

	var discoveredOld, discoveredNew, removedOld bool
	for _, e := range events {
		switch {
		case e.Action == "discovered" && e.Session.SessionID == oldSid:
			discoveredOld = true
		case e.Action == "discovered" && e.Session.SessionID == newSid:
			discoveredNew = true
		case e.Action == "removed" && e.Session.SessionID == oldSid:
			removedOld = true
		case e.Action == "changed" && e.Session.SessionID == newSid:
			t.Fatalf("fork emitted bare 'changed' for new session — tailer would never start")
		}
	}

	if !discoveredOld {
		t.Errorf("expected initial 'discovered' for old session")
	}
	if !removedOld {
		t.Errorf("expected 'removed' for superseded old session %s", oldSid)
	}
	if !discoveredNew {
		t.Errorf("expected 'discovered' for forked new session %s — without it no tailer starts", newSid)
	}
	if got := sw.fileToSession[pidFile]; got != newSid {
		t.Errorf("fileToSession not repointed: got %q want %q", got, newSid)
	}
	if _, stillKnown := sw.knownSessions[oldSid]; stillKnown {
		t.Errorf("old session should be dropped from knownSessions after fork")
	}
}

// TestStatusUpdateStaysChanged guards against over-firing: a normal in-place
// status update (same sessionId) must remain a "changed" event.
func TestStatusUpdateStaysChanged(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "200.json")
	const sid = "stable-sid"

	sw := newTestWatcher()
	writeSessionFile(t, pidFile, DiscoveredSession{Pid: 200, SessionID: sid, Status: "idle"})
	sw.handleNewFile(pidFile)

	writeSessionFile(t, pidFile, DiscoveredSession{Pid: 200, SessionID: sid, Status: "busy"})
	sw.handleChangedFile(pidFile)

	events := drainEvents(sw.eventsCh)
	for _, e := range events {
		if e.Action == "removed" {
			t.Fatalf("status update wrongly emitted 'removed' for %s", e.Session.SessionID)
		}
	}
	if len(events) == 0 || events[len(events)-1].Action != "changed" {
		t.Fatalf("expected final 'changed' event for status update, got %+v", events)
	}
}
