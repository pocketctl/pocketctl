package adapter

import (
	"errors"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// observer.go defines the read-only observer backend for agents the daemon can
// surface as historical content but never drive. The canonical case is ZCode:
// its sessions live in a local SQLite store and the daemon only reads them, so
// there is no subprocess to spawn, no PTY to write, and no CLI to resume.
//
// An observer agent is fail-closed against every "drive a session" entry point:
// CreateSession is rejected in internal/session before any side effect, and the
// factory helpers below return ErrObserverReadOnly so generic callers can never
// accidentally fall back to a Claude-backed launcher/storage for it.

// AgentZcode is the canonical agent type for ZCode sessions. They are surfaced
// as read-only observer content only.
const AgentZcode = "zcode"

// ErrObserverReadOnly is returned when a caller attempts to drive (create, send
// to, resume, interrupt) a session for a BackendObserver agent. Observer agents
// expose historical content only and have no controllable runtime.
var ErrObserverReadOnly = errors.New("agent is a read-only observer and cannot be driven")

// DiscoveryKind classifies how an agent is discovered/version-probed.
type DiscoveryKind int

const (
	// DiscoveryCLI: version detection via the agent's installed CLI/npm package
	// (claude-code, codex, opencode). The legacy default.
	DiscoveryCLI DiscoveryKind = iota
	// DiscoveryStorage: version detection via a read-only storage probe, with no
	// npm/CLI query (zcode). The daemon never launches this agent's binary.
	DiscoveryStorage
	// DiscoverySessionOnly: this identity is only assigned by session observers;
	// it must never appear in host install/upgrade discovery (codex-desktop).
	DiscoverySessionOnly
)

// IsObserverAgent reports whether an agent is a read-only observer. Callers
// use this single classification to reject all session-driving paths.
func IsObserverAgent(agentType string) bool {
	return BackendKindFor(agentType) == BackendObserver
}

// ---- fail-closed sentinels ----
//
// Generic callers reach the adapter via NewStorage/NewLauncher/NewAdapter/
// NewJSONLParser, which (for unimplemented agents) fall back to the Claude
// default to preserve legacy behavior. That fallback would be actively harmful
// for an observer agent: it would hand back a real Claude launcher/storage and
// let a caller spawn or drive something. These sentinels surface
// ErrObserverReadOnly instead, so the only safe path is CreateSession's early
// rejection (see internal/session/lifecycle.go).

// observerStorage satisfies SessionStorage while always erroring, so callers
// that resolve a JSONL path can never treat a zcode session like a Claude one.
type observerStorage struct{}

func (observerStorage) ResolveJSONLPath(sessionID, cwd string) (string, error) {
	return "", ErrObserverReadOnly
}
func (observerStorage) ExtractTitle(lines []string) string { return "" }
func (observerStorage) ExtractModel(lines []string) string { return "" }

// observerLauncher satisfies SessionLauncher while always erroring.
type observerLauncher struct{}

func (observerLauncher) BuildInteractiveArgs(config protocol.SessionConfig) []string { return nil }
func (observerLauncher) BuildResumeArgs(prompt, sessionID string, config protocol.SessionConfig) []string {
	return nil
}

// observerAdapter satisfies AgentAdapter while surfacing the read-only error on
// the first parse, so a streaming-stdout path can never interpret observer
// content as a driven session.
type observerAdapter struct{}

func (observerAdapter) ParseStreamLine(line string) ([]protocol.DaemonEvent, error) {
	return nil, ErrObserverReadOnly
}
func (observerAdapter) SessionID() string       { return "" }
func (observerAdapter) SlashCommands() []string { return nil }

// observerParser satisfies JSONLParser while surfacing the read-only error.
type observerParser struct{}

func (observerParser) Parse(line string) ([]protocol.DaemonEvent, error) {
	return nil, ErrObserverReadOnly
}
func (observerParser) SetPendingCmd(content string) {}

// NewStorageTyped returns the SessionStorage for an agent type, or
// ErrObserverReadOnly for observer agents. It is the typed-error companion to
// NewStorage (which cannot return an error and therefore falls back to Claude).
func NewStorageTyped(agentType string) (SessionStorage, error) {
	if IsObserverAgent(agentType) {
		return observerStorage{}, ErrObserverReadOnly
	}
	return NewStorage(agentType), nil
}

// NewLauncherTyped returns the SessionLauncher for an agent type, or
// ErrObserverReadOnly for observer agents.
func NewLauncherTyped(agentType string) (SessionLauncher, error) {
	if IsObserverAgent(agentType) {
		return observerLauncher{}, ErrObserverReadOnly
	}
	return NewLauncher(agentType), nil
}

// NewAdapterTyped returns the streaming-stdout adapter for an agent type, or
// ErrObserverReadOnly for observer agents.
func NewAdapterTyped(agentType, prompt string) (AgentAdapter, error) {
	if IsObserverAgent(agentType) {
		return observerAdapter{}, ErrObserverReadOnly
	}
	return NewAdapter(agentType, prompt), nil
}

// NewParserTyped returns the JSONL-history parser for an agent type, or
// ErrObserverReadOnly for observer agents.
func NewParserTyped(agentType string) (JSONLParser, error) {
	if IsObserverAgent(agentType) {
		return observerParser{}, ErrObserverReadOnly
	}
	return NewJSONLParser(agentType), nil
}
