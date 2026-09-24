package session

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/agentcontrol"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const codexThreadIdleGrace = 60 * time.Second

func (c *codexCoordinator) threadStateSnapshot() ([]string, []string, uint64) {
	c.subscribeMu.Lock()
	defer c.subscribeMu.Unlock()
	var threads, detached []string
	for id := range c.managedThreads {
		threads = append(threads, id)
		if c.detachedThreads[id] {
			detached = append(detached, id)
		}
	}
	sort.Strings(threads)
	sort.Strings(detached)
	return threads, detached, c.threadStateVersion
}

func (c *codexCoordinator) detachedSessionStatus(id string) string {
	if c.sm != nil {
		c.sm.mu.RLock()
		defer c.sm.mu.RUnlock()
		if ps := c.sm.sessions[id]; ps != nil && ps.Status == protocol.StatusKilled {
			return protocol.StatusKilled
		}
	}
	return protocol.StatusIdle
}

// Serializes daemon mutations and unload for one thread, never the event pump
// or unrelated threads. Native clients are additionally protected by leases
// and app-server's own subscriber/activity checks.
func (c *codexCoordinator) threadOperationLock(id string) *sync.Mutex {
	lock, _ := c.threadOperations.LoadOrStore(id, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func (c *codexCoordinator) threadDetached(id string) bool {
	c.subscribeMu.Lock()
	defer c.subscribeMu.Unlock()
	return c.detachedThreads[id]
}

func (c *codexCoordinator) detachedThreadSnapshot() []string {
	c.subscribeMu.Lock()
	defer c.subscribeMu.Unlock()
	var ids []string
	for id, detached := range c.detachedThreads {
		if detached {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (c *codexCoordinator) restoreDetachedThreads(ids []string) {
	c.subscribeMu.Lock()
	defer c.subscribeMu.Unlock()
	c.detachedThreads = make(map[string]bool)
	for _, id := range ids {
		if _, owned := c.managedThreads[id]; owned {
			c.detachedThreads[id] = true
		}
	}
}

func (c *codexCoordinator) threadInUse(id string, generation uint64) bool {
	if c.currentTurn(id) != "" {
		return true
	}
	if c.sm == nil {
		return false
	}
	for _, lease := range c.sm.leases.Active(generation) {
		// A new TUI has no thread id at acquire time. Until it exits, retain
		// this generation's threads rather than guess which one it owns.
		if lease.Agent == agentcontrol.AgentCodex && (lease.SessionID == "" || lease.SessionID == id) {
			return true
		}
	}
	if broker := c.interactionBroker(); broker != nil && broker.HasPending(id) {
		return true
	}
	c.sm.mu.RLock()
	defer c.sm.mu.RUnlock()
	if ps := c.sm.sessions[id]; ps != nil {
		switch ps.Status {
		case protocol.StatusRunning, protocol.StatusBusy, protocol.StatusRetry, protocol.StatusWaitingApproval, protocol.StatusWaitingQuestion:
			return true
		}
	}
	return false
}

// Caller holds the per-thread operation lock. Keep ownership/history and the
// backend, but drop this connection's subscription. Unsubscribe acknowledges
// detachment, not writer-lock release: app-server performs the idle unload.
func (c *codexCoordinator) releaseThread(ctx context.Context, id string, client codexRuntimeClient, generation uint64) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if active, gen, ok := c.backendClient(); ok && (active != client || gen != generation) {
		return fmt.Errorf("Codex runtime changed before thread release")
	}
	if c.threadInUse(id, generation) {
		return fmt.Errorf("Codex session is still in use; finish or interrupt the active task and detach other terminals before closing")
	}
	if c.threadDetached(id) {
		return c.persist()
	}
	c.subscribeMu.Lock()
	if c.detachedThreads == nil {
		c.detachedThreads = make(map[string]bool)
	}
	c.detachedThreads[id] = true // suppress unload notifications before the RPC returns
	c.threadStateVersion++
	c.subscribeMu.Unlock()
	var result struct {
		Status string `json:"status"`
	}
	err := client.Call(ctx, "thread/unsubscribe", map[string]any{"threadId": id}, &result)
	if err == nil && result.Status != "unsubscribed" && result.Status != "notSubscribed" && result.Status != "notLoaded" {
		err = fmt.Errorf("unexpected unsubscribe status %q", result.Status)
	}
	if err != nil {
		c.subscribeMu.Lock()
		delete(c.detachedThreads, id)
		c.threadStateVersion++
		c.subscribeMu.Unlock()
		return fmt.Errorf("Codex thread/unsubscribe: %w", err)
	}
	c.subscribeMu.Lock()
	delete(c.subscribed, id)
	delete(c.idleThreads, id)
	c.subscribeMu.Unlock()
	slog.Info("Codex thread detached", "thread", id, "generation", generation, "unload_pending", result.Status != "notLoaded")
	return c.persist()
}

// beginThreadOperation makes remote sends work after idle unload, using the
// current connection after a daemon reconnect. The returned backend is a copy.
func (b *CodexAppServerBackend) beginThreadOperation(ctx context.Context, id string, resume bool) (*CodexAppServerBackend, func(), error) {
	lock := b.coord.threadOperationLock(id)
	lock.Lock()
	unlock := lock.Unlock
	current := *b
	b.coord.mu.Lock()
	stopped := b.coord.shuttingDown
	b.coord.mu.Unlock()
	if stopped {
		unlock()
		return nil, nil, fmt.Errorf("Codex runtime is shutting down")
	}
	if client, generation, ok := b.coord.backendClient(); ok {
		current.client, current.generation = client, generation
	}
	if err := ctx.Err(); err != nil {
		unlock()
		return nil, nil, err
	}
	b.coord.subscribeMu.Lock()
	_, known := b.coord.managedThreads[id]
	_, subscribed := b.coord.subscribed[id]
	needsResume := b.coord.detachedThreads[id] || (known && !subscribed)
	b.coord.subscribeMu.Unlock()
	if resume && needsResume {
		if err := current.client.Call(ctx, "thread/resume", map[string]any{"threadId": id}, nil); err != nil {
			unlock()
			return nil, nil, fmt.Errorf("resume released Codex session: %w", err)
		}
		if active, gen, ok := b.coord.backendClient(); ok && (active != current.client || gen != current.generation) {
			unlock()
			return nil, nil, fmt.Errorf("Codex runtime changed while resuming session")
		}
		b.coord.markSubscribed(id)
	}
	b.coord.subscribeMu.Lock()
	delete(b.coord.idleThreads, id)
	b.coord.subscribeMu.Unlock()
	return &current, unlock, nil
}

func (c *codexCoordinator) reapIdleThreads(ctx context.Context, now time.Time) {
	c.subscribeMu.Lock()
	dirty := c.threadStateVersion != c.threadStateSaved
	c.subscribeMu.Unlock()
	if dirty {
		if err := c.persist(); err != nil {
			slog.Warn("persist Codex thread lifecycle failed", "error", err)
		}
	}
	client, generation, ok := c.backendClient()
	if !ok {
		return
	}
	for _, id := range c.managedThreadSnapshot() {
		if ctx.Err() != nil {
			return
		}
		lock := c.threadOperationLock(id)
		if !lock.TryLock() {
			continue
		}
		func() {
			defer lock.Unlock()
			c.subscribeMu.Lock()
			_, subscribing := c.subscribing[id]
			_, subscribed := c.subscribed[id]
			c.subscribeMu.Unlock()
			if subscribing || !subscribed || c.threadDetached(id) {
				return
			}
			busy := c.threadInUse(id, generation)
			c.subscribeMu.Lock()
			if c.idleThreads == nil {
				c.idleThreads = make(map[string]time.Time)
			}
			since, seen := c.idleThreads[id]
			if busy {
				delete(c.idleThreads, id)
			} else if !seen {
				c.idleThreads[id] = now
			}
			c.subscribeMu.Unlock()
			if busy || !seen || now.Sub(since) < codexThreadIdleGrace {
				return
			}
			rpcCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if err := c.releaseThread(rpcCtx, id, client, generation); err != nil {
				slog.Warn("Codex idle thread release failed", "thread", id, "error", err)
			}
		}()
	}
}

func (c *codexCoordinator) reapThreads(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			c.reapIdleThreads(ctx, now)
		}
	}
}
