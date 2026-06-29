package watcher

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeRollout(t *testing.T, dir, name, content string, mtime time.Time) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if !mtime.IsZero() {
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func drainEvents(ch chan SessionEvent) []SessionEvent {
	var out []SessionEvent
	for {
		select {
		case e := <-ch:
			out = append(out, e)
		default:
			return out
		}
	}
}

func TestCodexWatcher_DiscoversFreshSkipsHistorical(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CODEX_HOME", tmp) // watcher resolves $CODEX_HOME/sessions
	now := time.Now()
	dayDir := filepath.Join(tmp, "sessions", now.Format("2006"), now.Format("01"), now.Format("02"))

	// Fresh rollout (mtime now) — session id + cwd come from session_meta, not
	// the filename (codex UUIDs and the timestamp both contain dashes).
	writeRollout(t, dayDir, "rollout-2026-06-29T07-46-53-uuid-fresh.jsonl",
		`{"type":"session_meta","payload":{"id":"sess-fresh","cwd":"/work/a"}}`+"\n", now)
	// Historical rollout (mtime 10m ago) — must be ignored.
	writeRollout(t, dayDir, "rollout-2026-06-01T00-00-00-uuid-old.jsonl",
		`{"type":"session_meta","payload":{"id":"sess-old","cwd":"/work/b"}}`+"\n", now.Add(-10*time.Minute))

	cw := NewCodexSessionWatcher()
	cw.scan(now)

	got := drainEvents(cw.eventsCh)
	if len(got) != 1 {
		t.Fatalf("want 1 discovered event, got %d: %+v", len(got), got)
	}
	if ev := got[0]; ev.Action != "discovered" || ev.Session.SessionID != "sess-fresh" ||
		ev.Session.Cwd != "/work/a" || ev.Session.Status != "busy" {
		t.Fatalf("unexpected event: %+v", ev)
	}

	// A second scan must not re-emit already-seen files.
	cw.scan(now)
	if extra := drainEvents(cw.eventsCh); len(extra) != 0 {
		t.Fatalf("re-scan should emit nothing, got %+v", extra)
	}
}

func TestCodexWatcher_RetriesFileWithoutMeta(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CODEX_HOME", tmp)
	now := time.Now()
	dayDir := filepath.Join(tmp, "sessions", now.Format("2006"), now.Format("01"), now.Format("02"))

	// Brand-new rollout whose session_meta hasn't been flushed yet.
	p := writeRollout(t, dayDir, "rollout-2026-06-29T08-00-00-uuid-partial.jsonl",
		`{"type":"turn_context","payload":{}}`+"\n", now)

	cw := NewCodexSessionWatcher()
	cw.scan(now)
	if got := drainEvents(cw.eventsCh); len(got) != 0 {
		t.Fatalf("file without session_meta should not be discovered, got %+v", got)
	}
	if cw.seen[p] {
		t.Fatalf("file without meta should be left un-seen for a later retry")
	}

	// Once the meta is written, a subsequent scan discovers it.
	writeRollout(t, dayDir, "rollout-2026-06-29T08-00-00-uuid-partial.jsonl",
		`{"type":"session_meta","payload":{"id":"sess-late","cwd":"/work/c"}}`+"\n", now)
	cw.scan(now)
	got := drainEvents(cw.eventsCh)
	if len(got) != 1 || got[0].Session.SessionID != "sess-late" {
		t.Fatalf("expected discovery after meta flush, got %+v", got)
	}
}
