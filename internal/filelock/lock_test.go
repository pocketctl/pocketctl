package filelock

import (
	"testing"
	"time"
)

func TestTryLockAcquireAndConflict(t *testing.T) {
	m := New()

	ok, holder := m.TryLock("sessA", "/repo/main.go")
	if !ok || holder != "" {
		t.Fatalf("first TryLock: want (true, \"\"), got (%v, %q)", ok, holder)
	}

	// Same session renews → ok.
	ok, _ = m.TryLock("sessA", "/repo/main.go")
	if !ok {
		t.Fatal("renewal by same session should succeed")
	}

	// Different session conflicts.
	ok, holder = m.TryLock("sessB", "/repo/main.go")
	if ok || holder != "sessA" {
		t.Fatalf("conflicting TryLock: want (false, \"sessA\"), got (%v, %q)", ok, holder)
	}
}

func TestIsLockedByOther(t *testing.T) {
	m := New()
	m.TryLock("sessA", "/repo/a.go")

	if held, h := m.IsLockedByOther("sessA", "/repo/a.go"); held {
		t.Fatalf("owner should not see its own lock as held-by-other: %q", h)
	}
	if held, h := m.IsLockedByOther("sessB", "/repo/a.go"); !held || h != "sessA" {
		t.Fatalf("other session should see lock held by sessA, got (%v, %q)", held, h)
	}
	if held, _ := m.IsLockedByOther("sessB", "/repo/unlocked.go"); held {
		t.Fatal("unlocked file should not report held")
	}
}

func TestReleaseAndReleaseAll(t *testing.T) {
	m := New()
	m.TryLock("sessA", "/repo/a.go")
	m.TryLock("sessA", "/repo/b.go")
	m.TryLock("sessB", "/repo/c.go")

	// Release by wrong holder is a no-op.
	m.Release("sessB", "/repo/a.go")
	if held, _ := m.IsLockedByOther("sessB", "/repo/a.go"); !held {
		t.Fatal("Release by non-holder should not free the lock")
	}

	// ReleaseAll by owner frees only owner's locks.
	m.ReleaseAll("sessA")
	if held, _ := m.IsLockedByOther("sessB", "/repo/a.go"); held {
		t.Fatal("a.go should be free after ReleaseAll(sessA)")
	}
	if held, _ := m.IsLockedByOther("sessA", "/repo/c.go"); !held {
		t.Fatal("sessB's lock on c.go must survive ReleaseAll(sessA)")
	}
}

func TestExpiredLockTakeover(t *testing.T) {
	m := New()
	// Manually plant an expired lock.
	m.mu.Lock()
	m.locks["/repo/stale.go"] = &lockEntry{sessionID: "ghost", deadline: time.Now().Add(-time.Minute)}
	m.mu.Unlock()

	// A new session can take over because the old lease expired.
	ok, holder := m.TryLock("sessNew", "/repo/stale.go")
	if !ok || holder != "" {
		t.Fatalf("expired lock should be takeable, got (%v, %q)", ok, holder)
	}
}

func TestSweepEvictsExpired(t *testing.T) {
	m := New()
	m.TryLock("sessA", "/repo/x.go")
	// Force expiration.
	m.mu.Lock()
	m.locks["/repo/x.go"].deadline = time.Now().Add(-time.Second)
	m.mu.Unlock()

	m.sweep(time.Now())
	if held, _ := m.IsLockedByOther("sessB", "/repo/x.go"); held {
		t.Fatal("sweep should have evicted the expired lock")
	}
}
