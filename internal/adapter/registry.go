package adapter

import (
	"context"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// registry.go is the single registration point for coding agents ("session type
// registration"). Each agent registers one Provider that bundles its parsing,
// launching, storage, capabilities, and the metadata previously duplicated in
// internal/discovery's knownAgents table. Adding a new agent means registering
// one Provider — no scattered switch statements across adapter.go / discovery /
// session.
//
// Layering note: SessionBackend (the live session driver) needs SessionManager
// internals, so it lives in internal/session. A Provider therefore declares a
// BackendKind enum instead of a backend constructor — internal/session maps the
// kind to its concrete backend, avoiding an adapter→session import cycle.

// BackendKind identifies how the daemon drives an agent's sessions.
type BackendKind int

const (
	// BackendSubprocess: one OS process per session, driven via PTY + JSONL file
	// tail / one-shot --resume (Claude Code, Codex).
	BackendSubprocess BackendKind = iota
	// BackendServer: one shared long-running server process, sessions multiplexed
	// over HTTP with a single SSE event stream (opencode).
	BackendServer
)

// Provider is the registration record for a coding agent.
type Provider struct {
	// Identity / discovery metadata (single source of truth; internal/discovery
	// derives its agent list from here).
	Type      string // canonical agent type: "claude-code" | "codex" | "opencode"
	CLIName   string // installed binary name (e.g. "claude")
	Package   string // npm package for version checks ("" = none)
	UpdateCmd string // built-in upgrade command ("" = npm install -g <pkg>@latest)

	// Session driving.
	Backend      BackendKind
	Capabilities AgentCapabilities

	// Factories (nil for not-yet-implemented agents — callers fall back to the
	// Claude default to preserve legacy behavior).
	NewAdapter  func(prompt string) AgentAdapter
	NewParser   func() JSONLParser
	NewLauncher func() SessionLauncher
	NewStorage  func() SessionStorage
}

var (
	registry      = map[string]Provider{}
	registryOrder []string
)

// Register adds (or replaces) a Provider in the registry. Called from init() in
// each agent's file.
func Register(p Provider) {
	if _, exists := registry[p.Type]; !exists {
		registryOrder = append(registryOrder, p.Type)
	}
	registry[p.Type] = p
}

// Get returns the Provider for an agent type. ok is false for unknown types.
func Get(agentType string) (Provider, bool) {
	p, ok := registry[agentType]
	return p, ok
}

// All returns every registered Provider in registration order.
func All() []Provider {
	out := make([]Provider, 0, len(registryOrder))
	for _, t := range registryOrder {
		out = append(out, registry[t])
	}
	return out
}

// BackendKindFor returns how to drive an agent's sessions. Unknown/unregistered
// types default to BackendSubprocess (the legacy path).
func BackendKindFor(agentType string) BackendKind {
	if p, ok := registry[agentType]; ok {
		return p.Backend
	}
	return BackendSubprocess
}

// LiveChannel is a real-time source of DaemonEvents for one session's ongoing
// activity. It generalizes the JSONL tailer so non-file backends (opencode) can
// participate. Implementations:
//   - SingleFileTail: append-only JSONL (Claude Code, Codex)
//   - DirWatch:       opencode storage tree (message/<sid>/, part/<msgId>/)
//   - ServeSSE:       opencode serve /event bus, filtered by session id
//
// Pause/Resume preserve the existing semantic of suspending forwarding while a
// one-shot resume subprocess runs (to avoid double-forwarding the same events).
type LiveChannel interface {
	Start(ctx context.Context) error
	Events() <-chan protocol.DaemonEvent
	Pause()
	Resume()
	Close() error
}
