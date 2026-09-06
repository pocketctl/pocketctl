package adapter

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// This file defines the agent-agnostic adapter contract and a type-keyed
// factory. Each coding agent (Claude Code, Codex, …) implements these
// interfaces so the daemon can drive sessions uniformly.
//
// The Claude implementation lives in claude.go / claude_jsonl.go and is wrapped
// by the factories below without changing its existing behavior. New agents add
// their own files and register in the factory switch statements.

// AgentAdapter parses a single line from an agent's streaming stdout
// (claude -p --output-format stream-json / codex exec --json). One instance per
// spawned subprocess; it may carry state (e.g. the session id parsed from the
// init event).
type AgentAdapter interface {
	// ParseStreamLine converts one stdout line to zero or more daemon events.
	ParseStreamLine(line string) ([]protocol.DaemonEvent, error)
	// SessionID returns the real session id once the agent has reported it
	// (from its init/meta event), "" before that.
	SessionID() string
	// SlashCommands returns the slash commands the agent reported as available
	// in its init event. Empty for agents that don't surface commands.
	SlashCommands() []string
}

// JSONLParser converts a single line from an agent's persisted JSONL history
// file to daemon events. It is stateful (e.g. tracks a pending slash command so
// a synthetic reply can be turned into a command_receipt). Held by the JSONL
// tailer; one instance per tailed file.
type JSONLParser interface {
	// Parse converts one JSONL line to zero or more daemon events.
	Parse(line string) ([]protocol.DaemonEvent, error)
	// SetPendingCmd records a just-sent slash command so the parser can attach
	// it to the next command_receipt. Agents without a slash-command concept
	// implement this as a no-op.
	SetPendingCmd(content string)
}

// SessionLauncher builds the CLI arguments for spawning/resuming an agent.
type SessionLauncher interface {
	// BuildInteractiveArgs builds args for an interactive (PTY) session — no
	// prompt, no output-format flag; structured output is obtained via the
	// JSONL tailer. The session-id flag (if any) is prepended by the caller.
	BuildInteractiveArgs(config protocol.SessionConfig) []string
	// BuildResumeArgs builds args for a non-interactive one-shot resume
	// (claude -p --resume / codex exec resume) whose stdout is parsed inline.
	BuildResumeArgs(prompt, sessionID string, config protocol.SessionConfig) []string
}

// AgentCapabilities declares which runtime features an agent supports. The
// daemon consults these to decide whether a command (set_permission_config,
// set_effort, approval hook install, …) is applicable, returning a friendly
// error instead of writing agent-specific PTY bytes when it isn't.
type AgentCapabilities struct {
	SupportsPermissionCycle bool // Shift+Tab mode cycling (Claude)
	SupportsEffort          bool // /effort runtime switch (Claude)
	SupportsApprovalHook    bool // PreToolUse hook injection (Claude)
	SlashCommandsFromInit   bool // init event carries available commands (Claude)
}

// SessionStorage resolves an agent's on-disk JSONL layout and extracts
// title/model from history lines. Decouples the watcher from agent-specific
// directory conventions (e.g. ~/.claude/projects vs ~/.codex/sessions).
type SessionStorage interface {
	// ResolveJSONLPath returns the JSONL file path for a session. cwd helps
	// locate the project directory for agents that encode it in the path.
	ResolveJSONLPath(sessionID, cwd string) (string, error)
	// ExtractTitle returns a short title derived from the first user message
	// in the given raw JSONL lines.
	ExtractTitle(lines []string) string
	// ExtractModel returns the model name from the history lines (last real
	// assistant message / session meta), "" if unknown.
	ExtractModel(lines []string) string
}

// Agent types known to the daemon.
const (
	AgentClaude       = "claude-code"
	AgentCodex        = "codex"
	AgentCodexDesktop = "codex-desktop"
	AgentOpencode     = "opencode"
)

// ExtractFirstUserMessageFor 按 agentType 选首条 user 消息提取函数。
// claude 走 JSONLEntry 格式;codex 走 codexLine 格式(event_msg user_message)。
// GenerateTitle 触发需 user+assistant 都提取到,旧版只用 claude 提取导致 codex
// session 永远不触发 AI title。
func ExtractFirstUserMessageFor(lines []string, maxLen int, agentType string) string {
	if agentType == AgentCodex {
		return CodexExtractFirstUserMessage(lines, maxLen)
	}
	return ExtractFirstUserMessage(lines, maxLen)
}

// ExtractFirstAssistantMessageFor 按 agentType 选首条 assistant 消息提取函数。
func ExtractFirstAssistantMessageFor(lines []string, maxLen int, agentType string) string {
	if agentType == AgentCodex {
		return CodexExtractFirstAssistantMessage(lines, maxLen)
	}
	return ExtractFirstAssistantMessage(lines, maxLen)
}

// The factories below dispatch through the registry (see registry.go /
// providers.go). When an agent type is unregistered, or registered without the
// relevant factory (e.g. opencode before its session-driving code lands), they
// fall back to the Claude implementation to preserve legacy behavior.

// NewAdapter returns the streaming-stdout adapter for an agent type.
func NewAdapter(agentType, prompt string) AgentAdapter {
	if p, ok := Get(agentType); ok && p.NewAdapter != nil {
		return p.NewAdapter(prompt)
	}
	return NewClaudeAdapter(prompt)
}

// NewJSONLParser returns the JSONL-history parser for an agent type.
func NewJSONLParser(agentType string) JSONLParser {
	if p, ok := Get(agentType); ok && p.NewParser != nil {
		return p.NewParser()
	}
	return NewJSONLStreamParser()
}

// NewLauncher returns the session launcher for an agent type.
func NewLauncher(agentType string) SessionLauncher {
	if p, ok := Get(agentType); ok && p.NewLauncher != nil {
		return p.NewLauncher()
	}
	return ClaudeLauncher{}
}

// NewStorage returns the session-storage resolver for an agent type.
func NewStorage(agentType string) SessionStorage {
	if p, ok := Get(agentType); ok && p.NewStorage != nil {
		return p.NewStorage()
	}
	return ClaudeSessionStorage{}
}

// Capabilities returns the runtime capabilities for an agent type. Unknown types
// default to the Claude capability set (legacy behavior).
func Capabilities(agentType string) AgentCapabilities {
	if p, ok := Get(agentType); ok {
		return p.Capabilities
	}
	return AgentCapabilities{
		SupportsPermissionCycle: true,
		SupportsEffort:          true,
		SupportsApprovalHook:    true,
		SlashCommandsFromInit:   true,
	}
}

// ---- Claude wrappers (thin delegates to existing code) ----

// ClaudeLauncher adapts the free functions BuildInteractiveArgs / BuildClaudeArgs
// to the SessionLauncher interface.
type ClaudeLauncher struct{}

func (ClaudeLauncher) BuildInteractiveArgs(config protocol.SessionConfig) []string {
	return BuildInteractiveArgs(config)
}

func (ClaudeLauncher) BuildResumeArgs(prompt, sessionID string, config protocol.SessionConfig) []string {
	return BuildClaudeArgs(prompt, sessionID, config)
}

// ClaudeSessionStorage adapts the watcher's Claude-specific path resolver and
// the claude_jsonl extractors to the SessionStorage interface.
type ClaudeSessionStorage struct{}

func (ClaudeSessionStorage) ResolveJSONLPath(sessionID, cwd string) (string, error) {
	return resolveClaudeJSONLPath(sessionID, cwd)
}

func (ClaudeSessionStorage) ExtractTitle(lines []string) string {
	return ExtractFirstUserMessage(lines, 60)
}

func (ClaudeSessionStorage) ExtractModel(lines []string) string {
	return ExtractLastAssistantModel(lines)
}

// ResolveJSONLPathFor dispatches JSONL-path resolution to the right agent
// storage. This is the agent-aware replacement for watcher.ResolveJSONLPath.
func ResolveJSONLPathFor(agentType, sessionID, cwd string) (string, error) {
	return NewStorage(agentType).ResolveJSONLPath(sessionID, cwd)
}

type PTYResolveHints struct {
	StartedAt         time.Time
	InitialPrompt     string
	ExcludeSessionIDs map[string]struct{}
}

// ResolveJSONLPathForPTY resolves the JSONL file for a newly spawned PTY
// session and returns the real agent session id. Claude can pin the daemon's id
// up front, while Codex interactive mode generates its own id in session_meta.
func ResolveJSONLPathForPTY(agentType, sessionID, cwd string, hints PTYResolveHints) (string, string, error) {
	if agentType == AgentCodex {
		return CodexSessionStorage{}.ResolveJSONLPathForPTY(sessionID, cwd, hints)
	}
	path, err := ResolveJSONLPathFor(agentType, sessionID, cwd)
	return path, sessionID, err
}

// resolveClaudeJSONLPath mirrors watcher.ResolveJSONLPath: Claude Code stores
// sessions at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl, with a
// fallback search across all project dirs when cwd is unknown/stale.
func resolveClaudeJSONLPath(sessionID, cwd string) (string, error) {
	home, err := config.HomeDir()
	if err != nil {
		return "", err
	}

	encoded := "-" + strings.ReplaceAll(strings.TrimPrefix(cwd, "/"), "/", "-")
	dir := filepath.Join(home, ".claude", "projects", encoded)
	filePath := filepath.Join(dir, sessionID+".jsonl")

	if _, err := os.Stat(filePath); err == nil {
		return filePath, nil
	}
	// Fallback: search every project dir for the session id.
	projectsDir := filepath.Join(home, ".claude", "projects")
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return "", fmt.Errorf("read projects dir: %w", err)
	}
	target := sessionID + ".jsonl"
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(projectsDir, entry.Name(), target)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("jsonl file not found for session %s", sessionID)
}
