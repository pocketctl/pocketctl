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
		Backend:   BackendServer,
	})
}
