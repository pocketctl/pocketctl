package session

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/codexapp"
)

const (
	codexAdmissionTTL        = 5 * time.Minute
	codexAdmissionMaxThreads = 1024
	codexAdmissionMaxBytes   = 256 * 1024
	codexAdmissionTotalBytes = 16 * 1024 * 1024
)

type codexAdmissionFrame struct {
	message  codexapp.Inbound
	received time.Time
}

type codexAdmissionPending struct {
	created time.Time
	checked time.Time
	frames  []codexAdmissionFrame
	bytes   int
}

func codexAdmissionIdentity(message codexapp.Inbound) (string, bool) {
	var params struct {
		ThreadID string `json:"threadId"`
		Thread   struct {
			ID        string `json:"id"`
			Ephemeral bool   `json:"ephemeral"`
		} `json:"thread"`
	}
	if json.Unmarshal(message.Params, &params) != nil {
		return "", false
	}
	if params.ThreadID != "" {
		return params.ThreadID, message.Method == "thread/started" && params.Thread.Ephemeral
	}
	return params.Thread.ID, message.Method == "thread/started" && params.Thread.Ephemeral
}

// Content, turn activity, successful resume and old managed caches are not
// ownership evidence. A durable rollout must identify the exact thread.
func (c *codexCoordinator) admissionProof(id string) bool {
	if c.admissionProbe != nil {
		return c.admissionProbe(id)
	}
	if c.sm == nil {
		return false
	}
	c.sm.mu.RLock()
	ps := c.sm.sessions[id]
	owned := ps != nil && ps.Source == "daemon" && ps.Agent == adapter.AgentCodex && ps.Backend != nil
	observer := ps != nil && ps.Source == "observer"
	c.sm.mu.RUnlock()
	if observer {
		return false
	}
	if owned {
		return true
	}
	path, err := adapter.ResolveJSONLPathFor(adapter.AgentCodex, id, "")
	if err != nil {
		return false
	}
	meta, ok := adapter.ReadCodexRolloutMetadata(path)
	return ok && meta.ID == id && adapter.ClassifyCodexOrigin(meta).AgentType != adapter.AgentCodexDesktop
}

func (c *codexCoordinator) admissionAllowed(id string) bool {
	if id == "" {
		return true
	}
	c.admissionMu.Lock()
	defer c.admissionMu.Unlock()
	if c.admitted[id] {
		return true
	}
	if until := c.admissionIgnored[id]; time.Now().Before(until) {
		return false
	}
	if !c.admissionDisabled && !c.admissionProof(id) {
		return false
	}
	if c.admitted == nil {
		c.admitted = make(map[string]bool)
	}
	c.admitted[id] = true
	slog.Debug("Codex persistent thread admitted", "thread", id, "admission_disabled", c.admissionDisabled)
	return true
}

func (c *codexCoordinator) admissionGenerationCurrent(generation uint64) bool {
	c.admissionMu.Lock()
	defer c.admissionMu.Unlock()
	return generation >= c.admissionGeneration
}

// Only the event pump calls these queue operations. admissionMu also protects
// the defensive checks used by concurrent hydration/publication paths.
func (c *codexCoordinator) handleAdmissionMessage(ctx context.Context, message codexapp.Inbound, p *codexProjection, interactions *codexInteractions, now time.Time) {
	if ctx.Err() != nil {
		return
	}
	id, ephemeral := codexAdmissionIdentity(message)
	c.admissionMu.Lock()
	if p.generation < c.admissionGeneration {
		c.admissionMu.Unlock()
		return
	}
	if p.generation > c.admissionGeneration {
		if len(c.admissionPending) > 0 {
			slog.Warn("Codex admission pending reset; persistent threads require hydration", "count", len(c.admissionPending))
		}
		c.admissionGeneration = p.generation
		c.admissionPending = make(map[string]*codexAdmissionPending)
		c.admissionBytes = 0
		c.admitted = make(map[string]bool)
	}
	if c.admissionPending == nil {
		c.admissionPending = make(map[string]*codexAdmissionPending)
	}
	if c.admissionIgnored == nil {
		c.admissionIgnored = make(map[string]time.Time)
	}
	for key, until := range c.admissionIgnored {
		if !now.Before(until) {
			delete(c.admissionIgnored, key)
		}
	}
	if ephemeral && !c.admitted[id] && !c.admissionProof(id) {
		if len(c.admissionIgnored) >= codexAdmissionMaxThreads {
			for key := range c.admissionIgnored {
				delete(c.admissionIgnored, key)
				break
			}
		}
		c.admissionIgnored[id] = now.Add(codexAdmissionTTL)
		c.dropAdmissionLocked(id, "explicit_ephemeral")
	}
	ignored := now.Before(c.admissionIgnored[id])
	known := c.admitted[id]
	q := c.admissionPending[id]
	probe := q == nil || now.Sub(q.checked) >= time.Second || message.ID != nil
	if q != nil && probe {
		q.checked = now
	}
	c.admissionMu.Unlock()
	if ignored {
		c.rejectUnverifiedRequest(message, interactions)
		return
	}
	if id == "" || known || (probe && c.admissionAllowed(id)) {
		c.flushAdmission(ctx, id, p, interactions)
		c.dispatchAdmitted(ctx, message, p, interactions, now)
		if id != "" && !known {
			c.subscribeAdmitted(ctx, id, p)
		}
		return
	}
	if message.ID != nil {
		// Do not silently hang an approval/question or approve it on behalf of
		// an unverified identity. The native client receives an explicit error.
		c.rejectUnverifiedRequest(message, interactions)
		return
	}
	c.admissionMu.Lock()
	defer c.admissionMu.Unlock()
	if q == nil {
		if len(c.admissionPending) >= codexAdmissionMaxThreads {
			var oldest string
			for key, v := range c.admissionPending {
				if oldest == "" || v.created.Before(c.admissionPending[oldest].created) {
					oldest = key
				}
			}
			c.dropAdmissionLocked(oldest, "capacity")
		}
		q = &codexAdmissionPending{created: now, checked: now}
		c.admissionPending[id] = q
	}
	size := len(message.Params) + len(message.Method) + 64
	if size > codexAdmissionMaxBytes || q.bytes+size > codexAdmissionMaxBytes || c.admissionBytes+size > codexAdmissionTotalBytes {
		c.dropAdmissionLocked(id, "buffer_limit_requires_hydration")
		return
	}
	q.frames = append(q.frames, codexAdmissionFrame{message: message, received: now})
	q.bytes += size
	c.admissionBytes += size
}

func (c *codexCoordinator) dropAdmissionLocked(id, reason string) {
	if q := c.admissionPending[id]; q != nil {
		c.admissionBytes -= q.bytes
		delete(c.admissionPending, id)
		slog.Warn("Codex admission candidate released", "thread", id, "reason", reason, "frames", len(q.frames))
	}
}

func (c *codexCoordinator) flushAdmission(ctx context.Context, id string, p *codexProjection, interactions *codexInteractions) {
	c.admissionMu.Lock()
	q := c.admissionPending[id]
	if q != nil {
		c.admissionBytes -= q.bytes
		delete(c.admissionPending, id)
	}
	c.admissionMu.Unlock()
	if q != nil {
		for _, f := range q.frames {
			c.dispatchAdmitted(ctx, f.message, p, interactions, f.received)
		}
	}
}

func (c *codexCoordinator) retryAdmissions(ctx context.Context, p *codexProjection, interactions *codexInteractions, now time.Time) {
	if ctx.Err() != nil || !c.admissionGenerationCurrent(p.generation) {
		return
	}
	c.admissionMu.Lock()
	var ids []string
	for id, q := range c.admissionPending {
		if now.Sub(q.created) >= codexAdmissionTTL {
			c.dropAdmissionLocked(id, "expired_requires_hydration")
			continue
		}
		if len(ids) < 16 && now.Sub(q.checked) >= time.Second {
			ids = append(ids, id)
			q.checked = now
		}
	}
	c.admissionMu.Unlock()
	for _, id := range ids {
		if c.admissionAllowed(id) {
			c.flushAdmission(ctx, id, p, interactions)
			c.subscribeAdmitted(ctx, id, p)
		}
	}
}

func (c *codexCoordinator) dispatchAdmitted(ctx context.Context, message codexapp.Inbound, p *codexProjection, interactions *codexInteractions, received time.Time) {
	if ctx.Err() != nil || !c.admissionGenerationCurrent(p.generation) {
		return
	}
	if interactions != nil {
		interactions.Handle(message)
	}
	c.projectLiveAt(p, message, received)
	// A failed resume must remain retryable on subsequent status notifications.
	c.maybeSubscribeTerminalThread(ctx, message, p)
}

func (c *codexCoordinator) subscribeAdmitted(ctx context.Context, id string, p *codexProjection) {
	params, _ := json.Marshal(map[string]string{"threadId": id})
	c.maybeSubscribeTerminalThread(ctx, codexapp.Inbound{Method: "thread/status/changed", Params: params}, p)
}

func (c *codexCoordinator) rejectUnverifiedRequest(message codexapp.Inbound, interactions *codexInteractions) {
	if message.ID == nil || interactions == nil || interactions.client == nil {
		return
	}
	if err := interactions.client.Respond(*message.ID, nil, &codexapp.RPCError{Code: -32800, Message: "PocketCtl cannot verify this thread as a persistent user session; retry after persistence"}); err != nil {
		slog.Warn("Codex admission request rejection failed", "method", message.Method, "error", err)
	}
}
