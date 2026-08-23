package session

import (
	"log/slog"
	"sync/atomic"
)

// TurnMetrics routes the turn core's content-free signals into counters and
// structured logs: unknown classification, invalid transition, inferred
// terminal, unassigned content events and journal corruption. It implements
// both turn.Metrics and turn.Stats. Counters carry no content — only
// event-type names and opaque ids.
type TurnMetrics struct {
	unknownClassification atomic.Uint64
	invalidTransition     atomic.Uint64
	inferredTerminal      atomic.Uint64
	unassignedEvents      atomic.Uint64
	journalCorruption     atomic.Uint64
}

func NewTurnMetrics() *TurnMetrics { return &TurnMetrics{} }

func (m *TurnMetrics) UnknownClassification(eventType string) {
	if m == nil {
		return
	}
	m.unknownClassification.Add(1)
	slog.Debug("turn classifier saw an unregistered event type", "event_type", eventType)
}

func (m *TurnMetrics) InvalidTransition(turnID, from, to string) {
	if m == nil {
		return
	}
	m.invalidTransition.Add(1)
	slog.Warn("turn invalid transition rejected", "turn_id", turnID, "from", from, "to", to)
}

func (m *TurnMetrics) InferredTerminal(turnID, state, reason string) {
	if m == nil {
		return
	}
	m.inferredTerminal.Add(1)
	slog.Info("turn terminalized by bounded inference", "turn_id", turnID, "state", state, "reason", reason)
}

func (m *TurnMetrics) UnassignedEvent() {
	if m == nil {
		return
	}
	m.unassignedEvents.Add(1)
}

func (m *TurnMetrics) JournalCorruption(path string, err error) {
	if m == nil {
		return
	}
	m.journalCorruption.Add(1)
	slog.Warn("turn journal write failed", "path", path, "error", err)
}

// Snapshot returns the current counters for telemetry scraping.
func (m *TurnMetrics) Snapshot() map[string]uint64 {
	if m == nil {
		return nil
	}
	return map[string]uint64{
		"unknown_classification": m.unknownClassification.Load(),
		"invalid_transition":     m.invalidTransition.Load(),
		"inferred_terminal":      m.inferredTerminal.Load(),
		"unassigned_events":      m.unassignedEvents.Load(),
		"journal_corruption":     m.journalCorruption.Load(),
	}
}
