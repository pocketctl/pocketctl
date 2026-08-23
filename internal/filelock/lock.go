// Package filelock provides an in-process, file-level lock manager used to
// coordinate concurrent edits across multiple agent sessions that share the
// same working directory (Scheme C).
//
// Locks are keyed by the normalized absolute file path and held by a session
// ID. Each lock carries a lease deadline; a background reaper sweeps expired
// locks so a crashed session doesn't permanently hold a file. The same session
// re-acquiring a lock refreshes its lease (idempotent renewal).
//
// The manager is intentionally process-local: it coordinates sessions within a
// single daemon. Cross-daemon coordination (rare — a daemon owns a host) is out
// of scope.
package filelock

import (
	"context"
	"sync"
	"time"
)

// LeaseDuration is how long a lock stays valid before the reaper may reclaim it.
// Long enough for an agent turn to complete; short enough that an orphaned lock
// (session crashed without cleanup) self-expires.
const LeaseDuration = 10 * time.Minute

// reaperInterval is how often the background sweeper runs.
const reaperInterval = 30 * time.Second

// LockManager coordinates file locks across sessions.
type LockManager struct {
	mu    sync.Mutex
	locks map[string]*lockEntry // normalized absPath → lock
}

type lockEntry struct {
	sessionID string
	deadline  time.Time
}

// New returns an unlocked LockManager.
func New() *LockManager {
	return &LockManager{locks: make(map[string]*lockEntry)}
}

// TryLock acquires (or renews) a lock on absPath for sessionID. Returns
// (true, "") on success. If another live session holds the lock, returns
// (false, holderSessionID).
func (m *LockManager) TryLock(sessionID, absPath string) (bool, string) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()

	if e, ok := m.locks[absPath]; ok {
		if e.sessionID == sessionID {
			// Renewal — same holder refreshes the lease.
			e.deadline = now.Add(LeaseDuration)
			return true, ""
		}
		if e.deadline.After(now) {
			// Held by another live session.
			return false, e.sessionID
		}
		// Expired — fall through to take over.
	}
	m.locks[absPath] = &lockEntry{sessionID: sessionID, deadline: now.Add(LeaseDuration)}
	return true, ""
}

// IsLockedByOther reports whether absPath is held by a session other than
// sessionID (and the lease hasn't expired). It does NOT acquire the lock.
func (m *LockManager) IsLockedByOther(sessionID, absPath string) (bool, string) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()

	e, ok := m.locks[absPath]
	if !ok {
		return false, ""
	}
	if e.sessionID == sessionID {
		return false, ""
	}
	if !e.deadline.After(now) {
		return false, ""
	}
	return true, e.sessionID
}

// Release frees a single file lock, but only if sessionID is the current
// holder. No-op otherwise (the lock may have expired and been taken over).
func (m *LockManager) Release(sessionID, absPath string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.locks[absPath]; ok && e.sessionID == sessionID {
		delete(m.locks, absPath)
	}
}

// ReleaseAll frees every lock held by sessionID. Called when a session exits
// or is killed so its files become available to other sessions immediately.
func (m *LockManager) ReleaseAll(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for path, e := range m.locks {
		if e.sessionID == sessionID {
			delete(m.locks, path)
		}
	}
}

// StartReaper launches a background goroutine that periodically evicts expired
// locks. It returns when ctx is cancelled.
func (m *LockManager) StartReaper(ctx context.Context) {
	go func() {
		t := time.NewTicker(reaperInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				m.sweep(now)
			}
		}
	}()
}

func (m *LockManager) sweep(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for path, e := range m.locks {
		if !e.deadline.After(now) {
			delete(m.locks, path)
		}
	}
}
