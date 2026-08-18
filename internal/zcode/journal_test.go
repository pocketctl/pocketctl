package zcode

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func newJournal(t *testing.T) *PreparedEventJournal {
	t.Helper()
	return NewPreparedEventJournalAt(filepath.Join(t.TempDir(), "prepared-events.jsonl"))
}

func journalEvent(id, wire string) protocol.DaemonEvent {
	return protocol.DaemonEvent{Type: "user_text", EventID: id, SessionID: wire, Text: "payload-" + id}
}

func mustOpenJournal(t *testing.T, j *PreparedEventJournal) {
	t.Helper()
	if err := j.Open(); err != nil {
		t.Fatalf("journal open: %v", err)
	}
	t.Cleanup(func() { _ = j.Close() })
}

func TestJournal_PrepareBatchOneAppendOneSync(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	events := make([]protocol.DaemonEvent, 0, 5)
	for i := 0; i < 5; i++ {
		events = append(events, journalEvent(id5(i), "w1"))
	}
	if err := j.PrepareBatch("w1", events); err != nil {
		t.Fatal(err)
	}
	if got := j.appendCount; got != 1 {
		t.Fatalf("appends = %d, want 1 (per page, not per event)", got)
	}
	if got := j.syncCount; got != 1 {
		t.Fatalf("syncs = %d, want 1", got)
	}
	// A second identical page is a no-op: zero appends.
	if err := j.PrepareBatch("w1", events); err != nil {
		t.Fatal(err)
	}
	if got := j.appendCount; got != 1 {
		t.Fatalf("identical re-prepare appended again: %d", got)
	}
}

func id5(i int) string {
	return "e" + string(rune('a'+i))
}

func TestJournal_AppendFailureCreatesNoLiveEntry(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	j.testWriteErr = errors.New("disk full")
	events := []protocol.DaemonEvent{journalEvent("e1", "w1")}
	if err := j.PrepareBatch("w1", events); err == nil {
		t.Fatal("append failure must error")
	}
	j.testWriteErr = nil
	if _, ok, err := j.Load("e1"); err != nil || ok {
		t.Fatalf("failed append published a live entry: ok=%v err=%v", ok, err)
	}
	// The retry after recovery succeeds.
	if err := j.PrepareBatch("w1", events); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := j.Load("e1"); !ok {
		t.Fatal("recovered prepare lost the payload")
	}
}

func TestJournal_DuplicateEventIDDifferentPayloadFailsClosed(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1")}); err != nil {
		t.Fatal(err)
	}
	conflicting := journalEvent("e1", "w1")
	conflicting.Text = "DIFFERENT"
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{conflicting}); !errors.Is(err, ErrPreparedEventConflict) {
		t.Fatalf("error = %v, want ErrPreparedEventConflict", err)
	}
	// The live entry keeps the original payload.
	got, ok, _ := j.Load("e1")
	if !ok || got.Text != "payload-e1" {
		t.Fatalf("conflict replaced the payload: %+v", got)
	}
}

func TestJournal_SessionMismatchFailsClosed(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	ev := journalEvent("e1", "w1")
	if err := j.PrepareBatch("w2", []protocol.DaemonEvent{ev}); err == nil {
		t.Fatal("wire session mismatch must fail")
	}
}

func TestJournal_AckRemovesLiveIdempotent(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1"), journalEvent("e2", "w1")}); err != nil {
		t.Fatal(err)
	}
	if err := j.Acknowledge([]string{"e1", "unknown-id"}); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := j.Load("e1"); ok {
		t.Fatal("ack did not remove the live payload")
	}
	if _, ok, _ := j.Load("e2"); !ok {
		t.Fatal("ack removed an unacknowledged payload")
	}
	// Duplicate and unknown acks append nothing.
	before := j.appendCount
	if err := j.Acknowledge([]string{"e1", "unknown-id"}); err != nil {
		t.Fatal(err)
	}
	if got := j.appendCount; got != before {
		t.Fatalf("idempotent ack appended: %d > %d", got, before)
	}
}

func TestJournal_ReopenFoldsPutsAndTombstones(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prepared-events.jsonl")
	j := NewPreparedEventJournalAt(path)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1"), journalEvent("e2", "w1")}); err != nil {
		t.Fatal(err)
	}
	if err := j.Acknowledge([]string{"e2"}); err != nil {
		t.Fatal(err)
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	j2 := NewPreparedEventJournalAt(path)
	if err := j2.Open(); err != nil {
		t.Fatal(err)
	}
	defer j2.Close()
	if _, ok, _ := j2.Load("e1"); !ok {
		t.Fatal("reopen lost the live payload")
	}
	if _, ok, _ := j2.Load("e2"); ok {
		t.Fatal("reopen resurrected the tombstoned payload")
	}
}

func TestJournal_TruncatedTailRecoverable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "prepared-events.jsonl")
	j := NewPreparedEventJournalAt(path)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1")}); err != nil {
		t.Fatal(err)
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	// Append a truncated (partial) final line, as after a mid-write crash.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"version":1,"op":"put_batch","events":[{"event_id":"e2"`); err != nil {
		t.Fatal(err)
	}
	f.Close()
	j2 := NewPreparedEventJournalAt(path)
	if err := j2.Open(); err != nil {
		t.Fatalf("truncated tail must be recoverable: %v", err)
	}
	defer j2.Close()
	if _, ok, _ := j2.Load("e1"); !ok {
		t.Fatal("complete record lost behind truncated tail")
	}
	// Reconcile decides safety: e2 referenced by cursor would fail.
	if err := j2.Reconcile(map[string]struct{}{"e1": {}}); err != nil {
		t.Fatalf("reconcile over truncated tail: %v", err)
	}
	if err := j2.Reconcile(map[string]struct{}{"e2": {}}); !errors.Is(err, ErrPreparedPayloadMissing) {
		t.Fatalf("missing tail payload must be typed, got %v", err)
	}
}

func TestJournal_TruncatedTailCanAppendAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prepared-events.jsonl")
	j := NewPreparedEventJournalAt(path)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1")}); err != nil {
		t.Fatal(err)
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"version":1,"op":"put_batch","events":[`); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	j2 := NewPreparedEventJournalAt(path)
	if err := j2.Open(); err != nil {
		t.Fatal(err)
	}
	if err := j2.Reconcile(map[string]struct{}{"e1": {}}); err != nil {
		t.Fatal(err)
	}
	if err := j2.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e2", "w1")}); err != nil {
		t.Fatal(err)
	}
	if err := j2.Close(); err != nil {
		t.Fatal(err)
	}

	j3 := NewPreparedEventJournalAt(path)
	if err := j3.Open(); err != nil {
		t.Fatalf("journal did not remain appendable after truncated-tail recovery: %v", err)
	}
	defer j3.Close()
	for _, id := range []string{"e1", "e2"} {
		if _, ok, err := j3.Load(id); err != nil || !ok {
			t.Fatalf("reopened journal missing %s: ok=%v err=%v", id, ok, err)
		}
	}
}

func TestJournal_CompleteFinalRecordWithoutNewlineCanAppendAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prepared-events.jsonl")
	j := NewPreparedEventJournalAt(path)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1")}); err != nil {
		t.Fatal(err)
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 || data[len(data)-1] != '\n' {
		t.Fatal("fixture journal did not end with newline")
	}
	if err := os.WriteFile(path, data[:len(data)-1], 0o600); err != nil {
		t.Fatal(err)
	}

	j2 := NewPreparedEventJournalAt(path)
	if err := j2.Open(); err != nil {
		t.Fatal(err)
	}
	if err := j2.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e2", "w1")}); err != nil {
		t.Fatal(err)
	}
	if err := j2.Close(); err != nil {
		t.Fatal(err)
	}
	j3 := NewPreparedEventJournalAt(path)
	if err := j3.Open(); err != nil {
		t.Fatalf("journal with repaired newline did not reopen: %v", err)
	}
	defer j3.Close()
	for _, id := range []string{"e1", "e2"} {
		if _, ok, err := j3.Load(id); err != nil || !ok {
			t.Fatalf("reopened journal missing %s: ok=%v err=%v", id, ok, err)
		}
	}
}

func TestJournal_MalformedNonFinalFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "prepared-events.jsonl")
	good := `{"version":1,"op":"put_batch","events":[{"event_id":"e1","wire_session_id":"w1","payload":{"type":"user_text","event_id":"e1","session_id":"w1"}}]}` + "\n"
	if err := os.WriteFile(path, []byte(good+"{broken\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	j := NewPreparedEventJournalAt(path)
	if err := j.Open(); err == nil {
		t.Fatal("malformed non-final record must fail closed")
	}
}

func TestJournal_ReconcileTrimsOrphansAndReportsMissing(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1"), journalEvent("e2", "w1")}); err != nil {
		t.Fatal(err)
	}
	// e3 is referenced but absent: typed failure.
	if err := j.Reconcile(map[string]struct{}{"e1": {}, "e3": {}}); !errors.Is(err, ErrPreparedPayloadMissing) {
		t.Fatalf("error = %v, want ErrPreparedPayloadMissing", err)
	}
	// e2 is an orphan: trimmed from the live index.
	if err := j.Reconcile(map[string]struct{}{"e1": {}}); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := j.Load("e2"); ok {
		t.Fatal("orphan payload survived reconciliation")
	}
	if _, ok, _ := j.Load("e1"); !ok {
		t.Fatal("referenced payload was trimmed")
	}
}

func TestJournal_CompactionPreservesLiveOnly(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	// Cross the operation threshold with puts and tombstones so tombstoned
	// entries reach the live count (here: everything acked, live goes to 1).
	for batch := 0; batch < 32; batch++ {
		events := make([]protocol.DaemonEvent, 0, 16)
		ids := make([]string, 0, 16)
		for i := 0; i < 16; i++ {
			id := id5(batch) + id5(i)
			ev := journalEvent(id, "w1")
			events = append(events, ev)
			ids = append(ids, id)
		}
		if err := j.PrepareBatch("w1", events); err != nil {
			t.Fatal(err)
		}
		if err := j.Acknowledge(ids); err != nil {
			t.Fatal(err)
		}
	}
	// One surviving live entry.
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("LIVE", "w1")}); err != nil {
		t.Fatal(err)
	}
	if err := j.compactLockedForTest(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(j.Path())
	if err != nil {
		t.Fatal(err)
	}
	blob := string(data)
	if strings.Contains(blob, "e1") || !strings.Contains(blob, "LIVE") {
		t.Fatalf("compaction did not preserve exactly the live set:\n%s", blob)
	}
	// The compacted journal reopens cleanly with the live payload.
	j2 := NewPreparedEventJournalAt(j.Path())
	if err := j2.Open(); err != nil {
		t.Fatal(err)
	}
	defer j2.Close()
	if _, ok, _ := j2.Load("LIVE"); !ok {
		t.Fatal("compaction lost the live payload")
	}
	if _, ok, _ := j2.Load(id5(0) + id5(0)); ok {
		t.Fatal("compaction resurrected a tombstoned payload")
	}
}

func TestJournal_CompactionRenameFailureKeepsAppendHandle(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1")}); err != nil {
		t.Fatal(err)
	}
	originalPath := j.path
	blockedTarget := filepath.Join(t.TempDir(), "destination-is-a-directory")
	if err := os.Mkdir(blockedTarget, 0o700); err != nil {
		t.Fatal(err)
	}
	j.path = blockedTarget
	if err := j.compactLockedForTest(); err == nil {
		t.Fatal("compaction rename over a directory unexpectedly succeeded")
	}
	j.path = originalPath

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("failed compaction poisoned the append handle: %v", recovered)
		}
	}()
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e2", "w1")}); err != nil {
		t.Fatalf("append after failed compaction: %v", err)
	}
}

func TestJournal_Mode0600(t *testing.T) {
	j := newJournal(t)
	mustOpenJournal(t, j)
	if err := j.PrepareBatch("w1", []protocol.DaemonEvent{journalEvent("e1", "w1")}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(j.Path())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("journal perm = %o, want 0600", perm)
	}
}
