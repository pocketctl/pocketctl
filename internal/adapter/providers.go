package adapter

// providers.go registers the built-in agents. Adding a new agent = add a file
// like this with an init() that calls Register.

func init() {
	// Claude Code — subprocess backend, full runtime capabilities.
	Register(Provider{
		Type:      AgentClaude,
		CLIName:   "claude",
		Package:   "@anthropic-ai/claude-code",
		UpdateCmd: "claude update",
		Discovery: DiscoveryCLI,
		Backend:   BackendSubprocess,
		Capabilities: AgentCapabilities{
			SupportsPermissionCycle: true,
			SupportsEffort:          true,
			SupportsApprovalHook:    true,
			SlashCommandsFromInit:   true,
		},
		NewAdapter:  func(prompt string) AgentAdapter { return NewClaudeAdapter(prompt) },
		NewParser:   func() JSONLParser { return NewJSONLStreamParser() },
		NewLauncher: func() SessionLauncher { return ClaudeLauncher{} },
		NewStorage:  func() SessionStorage { return ClaudeSessionStorage{} },
	})

	// Codex — subprocess backend; no PreToolUse hook / Shift+Tab cycle / /effort
	// (approval via codex's own --ask-for-approval flag). No built-in update
	// command; npm install -g @openai/codex@latest is used as fallback.
	Register(Provider{
		Type:         AgentCodex,
		CLIName:      "codex",
		Package:      "@openai/codex",
		UpdateCmd:    "",
		Discovery:    DiscoveryCLI,
		Backend:      BackendSubprocess,
		Capabilities: AgentCapabilities{},
		NewAdapter:   func(prompt string) AgentAdapter { return NewCodexAdapter() },
		NewParser:    func() JSONLParser { return NewCodexJSONLParser() },
		NewLauncher:  func() SessionLauncher { return CodexLauncher{} },
		NewStorage:   func() SessionStorage { return CodexSessionStorage{} },
	})

	// opencode — server backend. Metadata-only for now (discovery + upgrade work);
	// the session-driving factories are filled in by the opencode-agent work
	// (see internal/adapter/opencode.go, tasks group 5). Until then NewAdapter et
	// al. are nil and callers fall back to the Claude default.
	Register(Provider{
		Type:      AgentOpencode,
		CLIName:   "opencode",
		Package:   "opencode-ai",
		UpdateCmd: "opencode upgrade",
		Discovery: DiscoveryCLI,
		Backend:   BackendServer,
	})

	// zcode — read-only observer backend. The daemon never launches or drives a
	// ZCode session: it only reads historical/incremental content from the local
	// SQLite store out of band (see internal/zcode). No CLI/npm metadata, no
	// upgrade command, not manageable. The factories are fail-closed sentinels so
	// generic callers cannot fall back to a Claude-backed path; CreateSession
	// additionally rejects this agent up front before any side effect.
	Register(Provider{
		Type:        AgentZcode,
		CLIName:     "",
		Package:     "",
		UpdateCmd:   "",
		Discovery:   DiscoveryStorage,
		Backend:     BackendObserver,
		NewAdapter:  func(prompt string) AgentAdapter { return observerAdapter{} },
		NewParser:   func() JSONLParser { return observerParser{} },
		NewLauncher: func() SessionLauncher { return observerLauncher{} },
		NewStorage:  func() SessionStorage { return observerStorage{} },
	})

	// Codex Desktop — read-only observer for Desktop-owned session rollouts.
	// Unlike ZCode, it has no host-level installation or upgrade discovery:
	// session data is recognized only when a dedicated observer finds it.
	Register(Provider{
		Type:        AgentCodexDesktop,
		Discovery:   DiscoverySessionOnly,
		Backend:     BackendObserver,
		NewAdapter:  func(prompt string) AgentAdapter { return observerAdapter{} },
		NewParser:   func() JSONLParser { return observerParser{} },
		NewLauncher: func() SessionLauncher { return observerLauncher{} },
		NewStorage:  func() SessionStorage { return observerStorage{} },
	})
}
