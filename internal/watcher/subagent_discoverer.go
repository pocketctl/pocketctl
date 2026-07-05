package watcher

import (
	"context"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// SubAgentDiscoverer watches a Claude parent session's subagents/ directory and
// emits subagent_discovered events for each newly seen child agent. It uses
// toolUseId (from meta.json) as the precise relation key to the parent's Task
// tool_use. One discoverer per parent session; started after session_discovered.
type SubAgentDiscoverer struct {
	parentJSONLPath string
	parentSessionID string
	outputCh        chan<- protocol.DaemonEvent
	interval        time.Duration
	known           map[string]bool // discovered agentIDs
	ctx             context.Context  // daemon-lifetime ctx for child tailer goroutines
}

// NewSubAgentDiscoverer creates a discoverer for one parent session.
// interval controls the polling cadence (default 2s in production).
func NewSubAgentDiscoverer(parentJSONLPath, parentSessionID string, outputCh chan<- protocol.DaemonEvent, interval time.Duration) *SubAgentDiscoverer {
	if interval <= 0 {
		interval = 2 * time.Second
	}
	return &SubAgentDiscoverer{
		parentJSONLPath: parentJSONLPath,
		parentSessionID: parentSessionID,
		outputCh:        outputCh,
		interval:        interval,
		known:           make(map[string]bool),
	}
}

// Run polls the subagents directory until ctx is cancelled. Performs an
// immediate scan on start (before the first ticker tick) so children
// already present at session-discovery time are caught promptly.
// Non-blocking send matches SessionWatcher.emit's drop-on-backpressure policy
// (next poll recovers).
func (d *SubAgentDiscoverer) Run(ctx context.Context) {
	d.ctx = ctx
	ticker := time.NewTicker(d.interval)
	defer ticker.Stop()
	// Immediate first scan — do not wait for the first tick
	d.scanOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.scanOnce()
		}
	}
}

func (d *SubAgentDiscoverer) scanOnce() {
	metas, err := DiscoverSubAgents(d.parentJSONLPath)
	if err != nil {
		return
	}
	for _, m := range metas {
		if d.known[m.AgentID] {
			continue
		}
		ev := protocol.DaemonEvent{
			Type:            "subagent_discovered",
			SessionID:       d.parentSessionID,
			AgentID:         m.AgentID,
			CallID:          m.ToolUseID, // toolUseId — precise relation key
			SubAgentType:    m.AgentType,
			SubAgentDesc:    m.Description,
			ParentSessionID: d.parentSessionID,
			IsSubagent:      true,
			RootSessionID:   d.parentSessionID,
		}
		select {
		case d.outputCh <- ev:
			d.known[m.AgentID] = true // only mark known after successful send
			// C1 fix: start a SubAgentTailer on the child's jsonl so
			// subagent_usage events fire and child对话 events forward.
			// The tailer reads from START (replays full history for P0).
			// It exits on ctx.Done() — same daemon-lifetime as the discoverer.
			if d.ctx != nil {
				childPath := SubAgentJSONLPath(d.parentJSONLPath, m.AgentID)
				if t, err := NewSubAgentTailer(childPath, m.AgentID, d.parentSessionID, m.AgentType); err == nil {
					go t.Run(d.ctx, d.outputCh)
				}
			}
		default:
			// drop on backpressure; next scan will re-attempt (not marked known)
		}
	}
}
