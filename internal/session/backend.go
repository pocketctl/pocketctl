package session

import (
	"context"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// SessionBackend drives the lifecycle of sessions for a server-kind agent
// (currently opencode). It is an *additive* layer: subprocess agents (Claude
// Code, Codex) keep using the SessionManager's existing PTY / JSONL-tail /
// --resume code paths directly and do NOT go through a SessionBackend. Only
// server-kind agents — one shared server process multiplexing many sessions
// over HTTP + a single SSE stream — implement this interface, and the manager
// dispatches to it (see ProcessState.Backend and the BackendKind branch in
// CreateSession).
//
// The concrete ServerBackend implementation for opencode lands with the
// opencode-agent work (tasks groups 4–5); this file defines the contract.
type SessionBackend interface {
	// Start creates/launches a session and returns its real session id.
	Start(ctx context.Context, config protocol.SessionConfig) (sessionID string, err error)
	// Send delivers a user message / prompt to an existing session.
	Send(ctx context.Context, sessionID, content string) error
	// Interrupt aborts the current turn of a session.
	Interrupt(sessionID string) error
	// Close releases backend resources held for a session.
	Close(sessionID string) error
}
