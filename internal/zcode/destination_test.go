package zcode

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestDestinationStores_ReplayLegacyContentButKeepTargetsIndependent(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "old", "Old task", "/work", 1, 1, 0)
		insertMessage(ctx, db, "m", "old", 0, 1, 1, userMsgJSON("historical content"))
		insertSession(ctx, db, "unselected", "Never synced", "/work", 2, 2, 0)
	}))
	root := t.TempDir()
	legacy := NewCursorStoreAt(filepath.Join(root, cursorFileName))
	rec := newEmitRecorder()
	o := testObserver(t, storage, legacy, rec.fn())
	convergePolls(t, o, legacy, rec, 10)
	// Retain only the actually selected historical session in the legacy file.
	legacy.mu.Lock()
	delete(legacy.state.Sessions, WireSessionID(testSourceID, "unselected"))
	err := legacy.writeCursor(legacy.state)
	legacy.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(legacy.Path())
	if err != nil {
		t.Fatal(err)
	}
	a, ja, err := destinationStoresAt(root, "ws://localhost:8080/ws", "account-a")
	if err != nil {
		t.Fatal(err)
	}
	b, jb, err := destinationStoresAt(root, "wss://relay.example/ws", "account-a")
	if err != nil {
		t.Fatal(err)
	}
	c, jc, err := destinationStoresAt(root, "wss://relay.example/ws", "account-b")
	if err != nil {
		t.Fatal(err)
	}
	if a.Path() == b.Path() || b.Path() == c.Path() || ja.Path() == jb.Path() || jb.Path() == jc.Path() {
		t.Fatal("destinations share cursor or journal")
	}
	for _, cs := range []*CursorStore{a, b, c} {
		r := newEmitRecorder()
		obs := testObserver(t, storage, cs, r.fn())
		obs.cfg.History, obs.cfg.LookbackDays = HistoryRecent, 3
		convergePolls(t, obs, cs, r, 10)
		if r.countType("user_text") != 1 {
			t.Fatalf("target inherited ACK or missed historical recovery: %d", r.countType("user_text"))
		}
		for _, ev := range r.snapshot() {
			if ev.SessionID == WireSessionID(testSourceID, "unselected") {
				t.Fatal("migration expanded history beyond known sessions")
			}
		}
	}
	again, _, err := destinationStoresAt(root, "wss://relay.example/ws", "account-a")
	if err != nil {
		t.Fatal(err)
	}
	r := newEmitRecorder()
	obs := testObserver(t, storage, again, r.fn())
	obs.cfg.History, obs.cfg.LookbackDays = HistoryRecent, 3
	convergePolls(t, obs, again, r, 10)
	if r.countType("user_text") != 0 {
		t.Fatal("returning to destination reset acknowledged progress")
	}
	after, err := os.ReadFile(legacy.Path())
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("legacy cursor was modified")
	}
}

// A reconnect must hydrate from the source, not publish bare cursor keys as
// ordinary root sessions. The legacy discovery ID may already name an empty
// discovery in the target Relay, so its repair needs a distinct event identity.
func TestObserver_ResyncRestoresHistoricalChildMetadata(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "parent", "Parent", "/work", 1, 1, 0)
		insertSession(ctx, db, "child", "Review", "/work", 2, 2, 0)
		if _, err := db.Exec("UPDATE session SET parent_id='parent', task_type='subagent_child' WHERE id='child'"); err != nil {
			t.Fatal(err)
		}
		insertMessage(ctx, db, "m", "child", 0, 2, 2, userMsgJSON("review this"))
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	convergePolls(t, o, cs, rec, 10)
	o.cfg.History, o.cfg.LookbackDays = HistoryRecent, 3
	rec.events = nil
	o.handleResync()
	convergePolls(t, o, cs, rec, 10)
	child := WireSessionID(testSourceID, "child")
	var discovered, linked bool
	registered := map[string]bool{}
	for _, ev := range rec.snapshot() {
		if ev.Type == "session_discovered" {
			registered[ev.SessionID] = true
		}
		if ev.Type == "subagent_discovered" && (!registered[ev.SessionID] || !registered[ev.AgentID]) {
			t.Error("relation emitted before parent/child discovery; a fresh Relay rejects it")
		}
		if ev.SessionID == child && ev.Type == "session_discovered" {
			discovered = true
			if !ev.Resync || ev.Title != "Review" || ev.Cwd != "/work" {
				t.Errorf("incomplete resync: %+v", ev)
			}
			if ev.EventID == NewMapper(testSourceID).SessionDiscovered(child, "", "", "", "completed").EventID {
				t.Error("repair collides with legacy empty discovery")
			}
		}
		if ev.Type == "subagent_discovered" && ev.AgentID == child {
			linked = true
		}
		if ev.Type == "user_text" {
			t.Error("same-destination reconnect replays acknowledged content")
		}
	}
	if !discovered || !linked {
		t.Fatalf("missing discovery or relation: discovered=%v linked=%v", discovered, linked)
	}
}

func TestObserver_SessionPagesDoNotStarveOlderSessions(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		for i := 0; i < 57; i++ {
			id := fmt.Sprintf("s%02d", i)
			insertSession(ctx, db, id, "Title", "/work", int64(i+1), int64(i+1), 0)
			insertMessage(ctx, db, "m"+id, id, 0, 1, 1, userMsgJSON("hello"))
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	convergePolls(t, o, cs, rec, 20)
	seen := map[string]bool{}
	for _, ev := range rec.snapshot() {
		if ev.Type == "user_text" {
			seen[ev.SessionID] = true
		}
	}
	if len(seen) != 57 {
		t.Fatalf("only %d/57 sessions delivered", len(seen))
	}
}

func TestObserver_ResyncRetriesBackpressureWithoutAnotherReconnect(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) { insertSession(ctx, db, "s", "Title", "/work", 1, 1, 0) }))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	convergePolls(t, o, cs, rec, 10)
	rec.events = nil
	o.cfg.Emit = func(protocol.DaemonEvent) bool { return false }
	o.handleResync()
	o.pollOnce(context.Background())
	o.cfg.Emit = rec.fn()
	convergePolls(t, o, cs, rec, 10)
	if rec.countType("session_discovered") == 0 {
		t.Fatal("rejected resync never retried")
	}
}

func TestObserver_FreshDestinationRegistersParentBeforeChildLink(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "parent", "Parent", "/work", 1, 1, 0)
		insertSession(ctx, db, "child", "Child", "/work", 2, 2, 0)
		if _, err := db.Exec("UPDATE session SET parent_id='parent' WHERE id='child'"); err != nil {
			t.Fatal(err)
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	rec := newEmitRecorder()
	o := testObserver(t, storage, cs, rec.fn())
	o.handleResync()
	convergePolls(t, o, cs, rec, 10)
	registered := map[string]bool{}
	for _, ev := range rec.snapshot() {
		if ev.Type == "session_discovered" {
			registered[ev.SessionID] = true
		}
		if ev.Type == "subagent_discovered" && (!registered[ev.SessionID] || !registered[ev.AgentID]) {
			t.Fatal("first connection linked child before registering parent")
		}
	}
}

func TestDestinationStores_RejectInvalidIdentityWithoutWriting(t *testing.T) {
	for _, tc := range []struct{ relay, account string }{{"", "a"}, {"file:///tmp/relay", "a"}, {"wss://relay.example/ws", ""}} {
		dir := t.TempDir()
		if _, _, err := destinationStoresAt(dir, tc.relay, tc.account); err == nil {
			t.Fatal("accepted invalid destination")
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatal("invalid destination wrote state")
		}
	}
}

func TestDestinationStores_LegacyVersionMigration(t *testing.T) {
	for _, version := range []int{1, CursorVersion, CursorVersion + 1} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			dir := t.TempDir()
			legacy := CursorFile{Version: version, SourceID: testSourceID, Sessions: map[string]SessionCursor{"zcode-selected": {AckMessageSequence: 23}}}
			data, err := json.Marshal(legacy)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, cursorFileName), data, 0600); err != nil {
				t.Fatal(err)
			}
			cs, _, err := destinationStoresAt(dir, "wss://relay.example/ws", "a")
			if version > CursorVersion {
				if err == nil {
					t.Fatal("future legacy version was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			snap, err := cs.Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			selected, ok := snap.File.Sessions["zcode-selected"]
			if !ok || selected.AckMessageSequence != 0 {
				t.Fatal("migration must retain selection but discard receipts")
			}
		})
	}
}

func TestObserver_StartUsesDestinationJournalAndPreservesOtherPending(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		insertSession(ctx, db, "s", "Title", "/work", 1, 1, 0)
		insertMessage(ctx, db, "m", "s", 0, 1, 1, userMsgJSON("pending content"))
	}))
	start := func(relay string) *Observer {
		o := NewObserver(ObserverConfig{RelayURL: relay, AccountID: "account", SourceID: testSourceID, StorageDir: storage,
			History: HistoryAll, ActivePoll: time.Hour, Emit: func(protocol.DaemonEvent) bool { return false }})
		if err := o.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		return o
	}
	a := start("ws://localhost:8080/ws")
	// Exercise the durable page path with a rejected output gate.
	a.resyncActive = false
	a.pollOnce(context.Background())
	a.Stop()
	beforeCursor, err := os.ReadFile(a.cursor.Path())
	if err != nil {
		t.Fatal(err)
	}
	beforeJournal, err := os.ReadFile(a.journal.Path())
	if err != nil {
		t.Fatal(err)
	}
	if len(beforeJournal) == 0 {
		t.Fatal("fixture did not persist pending payload")
	}
	b := start("wss://relay.example/ws")
	b.resyncActive = false
	b.pollOnce(context.Background())
	b.Stop()
	if a.cursor.Path() == b.cursor.Path() || a.journal.Path() == b.journal.Path() {
		t.Fatal("Start reused another target's state")
	}
	afterCursor, err := os.ReadFile(a.cursor.Path())
	if err != nil {
		t.Fatal(err)
	}
	afterJournal, err := os.ReadFile(a.journal.Path())
	if err != nil {
		t.Fatal(err)
	}
	if string(beforeCursor) != string(afterCursor) || string(beforeJournal) != string(afterJournal) {
		t.Fatal("starting another target changed pending state")
	}
	resumed := start("ws://localhost:8080/ws")
	resumed.resyncActive = false
	rec := newEmitRecorder()
	resumed.cfg.Emit = rec.fn()
	resumed.pollOnce(context.Background())
	resumed.Stop()
	if rec.countType("session_discovered") == 0 || rec.countType("user_text") != 1 {
		t.Fatal("returning to target did not recover its pending content")
	}
}
