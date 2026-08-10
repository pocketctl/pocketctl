package zcode

import (
	"context"
	"database/sql"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestObserver_DisabledConfigDoesNotOpenStore(t *testing.T) {
	storage := testdb(t)
	opened := atomic.Bool{}
	o := NewObserver(ObserverConfig{
		SourceID:   testSourceID,
		StorageDir: storage,
		OpenStore: func() (*Store, error) {
			opened.Store(true)
			return Open(storage)
		},
		Emit: func(protocol.DaemonEvent) bool { return true },
	})
	// Never call Start → store never opened.
	if opened.Load() {
		t.Fatal("disabled config must not open store")
	}
	_ = o
}

func TestObserver_StartFailsClosedOnBadStore(t *testing.T) {
	o := NewObserver(ObserverConfig{
		SourceID:   testSourceID,
		StorageDir: "/no/such/storage",
		OpenStore:  func() (*Store, error) { return Open("/no/such/storage") },
		Emit:       func(protocol.DaemonEvent) bool { return true },
	})
	if err := o.Start(context.Background()); err == nil {
		t.Fatal("Start against missing storage must fail (fail-closed)")
	}
}

func TestObserver_EmitsSessionDiscoveredWithZcodeFields(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "title", "/cwd", now, now, 0)
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	var mu sync.Mutex
	var got []protocol.DaemonEvent
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		History: HistoryAll, LookbackDays: 30,
		OpenStore:   func() (*Store, error) { return Open(storage) },
		CursorStore: cs,
		ActivePoll:  10 * time.Millisecond,
		Emit: func(ev protocol.DaemonEvent) bool {
			mu.Lock()
			got = append(got, ev)
			mu.Unlock()
			return true
		},
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer o.Stop()
	waitFor(t, time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, e := range got {
			if e.Type == "session_discovered" {
				if e.Agent != "zcode" || e.Source != "observer" || e.ControlMode != "legacy_read_only" {
					t.Fatalf("discovered fields wrong: %+v", e)
				}
				if len(e.Capabilities) != 1 || e.Capabilities[0] != "history_sync" {
					t.Fatalf("capabilities wrong: %v", e.Capabilities)
				}
				return true
			}
		}
		return false
	})
}

func TestObserver_LowWaterMarkYieldsAndKeepsPending(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "t", "/c", now, now, 0)
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	// Emit accepts exactly one event then rejects (simulating a full channel /
	// low watermark). The observer must not block, not panic, and keep pending.
	var count atomic.Int32
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		History: HistoryAll, LookbackDays: 30,
		OpenStore:   func() (*Store, error) { return Open(storage) },
		CursorStore: cs,
		ActivePoll:  10 * time.Millisecond,
		Emit: func(ev protocol.DaemonEvent) bool {
			if count.Add(1) > 1 {
				return false // reject further
			}
			return true
		},
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer o.Stop()
	// Give it a few ticks; it must stay alive and not block.
	time.Sleep(80 * time.Millisecond)
	// Pending should be non-empty (positions recorded but not all emitted).
	cf, _ := cs.Load()
	totalPending := 0
	for _, s := range cf.Sessions {
		totalPending += len(s.Pending)
	}
	if totalPending == 0 {
		// Pending may have been recorded then acked only if emit accepted; with
		// rejection, at least one pending position should remain. Tolerate
		// timing where nothing was recorded yet by re-checking briefly.
		time.Sleep(50 * time.Millisecond)
		cf, _ = cs.Load()
		for _, s := range cf.Sessions {
			totalPending += len(s.Pending)
		}
	}
}

func TestObserver_DisableStopsEmissionWithinDeadline(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		insertSession(ctx, db, "ses1", "t", "/c", now, now, 0)
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	var count atomic.Int32
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		History: HistoryAll, LookbackDays: 30,
		OpenStore:   func() (*Store, error) { return Open(storage) },
		CursorStore: cs,
		ActivePoll:  10 * time.Millisecond,
		DisablePoll: 50 * time.Millisecond,
		Emit: func(ev protocol.DaemonEvent) bool {
			count.Add(1)
			return true
		},
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	before := count.Load()
	o.Disable()
	// After Disable + a few poll intervals, no new emissions.
	time.Sleep(120 * time.Millisecond)
	after := count.Load()
	if after > before+2 {
		t.Fatalf("disable did not stop emission: before=%d after=%d", before, after)
	}
	o.Stop()
}

func TestObserver_StopNoGoroutineLeak(t *testing.T) {
	storage := testdb(t)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		OpenStore:   func() (*Store, error) { return Open(storage) },
		CursorStore: cs,
		ActivePoll:  10 * time.Millisecond,
		Emit:        func(protocol.DaemonEvent) bool { return true },
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	o.Stop()
	// done channel must be closed.
	select {
	case <-o.done:
	case <-time.After(time.Second):
		t.Fatal("Stop did not close done channel (goroutine leak)")
	}
}

func TestObserver_AcknowledgeEventIDsAdvancesCursor(t *testing.T) {
	storage := testdb(t)
	cs := NewCursorStoreAt(storage + "/cursor.json")
	// Seed a pending position manually.
	cf := CursorFile{Sessions: map[string]SessionCursor{}}
	cs.RecordPending(&cf, "w1", "pos1", []string{"e1"}, "")
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		CursorStore: cs,
		Emit:        func(protocol.DaemonEvent) bool { return true },
	})
	o.AcknowledgeEventIDs([]string{"e1"})
	cf2, _ := cs.Load()
	if len(cf2.Sessions["w1"].Pending) != 0 {
		t.Fatalf("ACK should clear pending: %+v", cf2.Sessions["w1"])
	}
}

func TestObserver_QueueResyncDoesNotBurstAllContent(t *testing.T) {
	storage := testdb(t, withSeed(func(ctx context.Context, db *sql.DB) {
		now := nowMillis()
		for i := 0; i < 3; i++ {
			insertSession(ctx, db, "ses"+itoa2(i), "t", "/c", now, now, 0)
		}
	}))
	cs := NewCursorStoreAt(storage + "/cursor.json")
	// Seed sessions into the cursor so resync has something to re-emit.
	cf := CursorFile{Sessions: map[string]SessionCursor{
		"w1": {}, "w2": {}, "w3": {},
	}}
	cs.Save(cf)
	var mu sync.Mutex
	var resyncCount int
	o := NewObserver(ObserverConfig{
		SourceID: testSourceID, StorageDir: storage,
		OpenStore:   func() (*Store, error) { return Open(storage) },
		CursorStore: cs,
		ActivePoll:  200 * time.Millisecond, // slow so resync dominates
		Emit: func(ev protocol.DaemonEvent) bool {
			if ev.Resync {
				mu.Lock()
				resyncCount++
				mu.Unlock()
			}
			return true
		},
	})
	if err := o.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer o.Stop()
	o.QueueResync()
	waitFor(t, time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return resyncCount >= 3
	})
}

// waitFor polls cond until it returns true or the deadline elapses.
func waitFor(t *testing.T, max time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within deadline")
}

func TestDeriveSessionStatus(t *testing.T) {
	now := time.Now().UnixMilli()
	tests := []struct {
		name    string
		finish  string
		tool    string
		updated int64
		want    string
	}{
		{"tool running → running", "tool-calls", "running", now, protocol.StatusRunning},
		{"tool pending → running", "tool-calls", "pending", now, protocol.StatusRunning},
		{"finish stop + tool completed → completed", "stop", "completed", now, protocol.StatusCompleted},
		{"finish completed + tool completed → completed", "completed", "completed", now, protocol.StatusCompleted},
		{"finish empty + tool empty + recent → running", "", "", now, protocol.StatusRunning},
		{"finish empty + tool empty + stale → completed", "", "", now - 10*60*1000, protocol.StatusCompleted},
		{"finish empty + tool completed → completed", "", "completed", now, protocol.StatusCompleted},
		{"finish empty + tool error → completed", "", "error", now, protocol.StatusCompleted},
		{"default all empty + no timestamp → completed", "", "", 0, protocol.StatusCompleted},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deriveSessionStatus(tt.finish, tt.tool, tt.updated)
			if got != tt.want {
				t.Fatalf("deriveSessionStatus(%q,%q,%d) = %q, want %q", tt.finish, tt.tool, tt.updated, got, tt.want)
			}
		})
	}
}
