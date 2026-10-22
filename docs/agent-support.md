# Agent support details

[Back to README](../README.md)

## Agent support

Control is deliberately capability-based. A discovered session is not
automatically advertised as remotely controllable.

| Agent | Observe | Remote interaction | Integration model |
|---|---|---|---|
| **Claude Code** | Live history and output | Independently started terminal sessions can continue through an idle/exited `--resume` handoff. PocketCtl-created PTYs support Web/iOS approvals; the native terminal remains authoritative for independently started sessions. | Automatic discovery; no shared runtime claim. See [Claude cross-device control](claude-cross-device-control.md). |
| **Codex CLI 0.144.1+** | Threads, turns, items, plans, and interactions | Managed sessions support shared input, steer/interrupt, approvals, questions, standard MCP elicitation, and explicit `/` command/skill invocation with autocomplete. | Optional launcher connects the official TUI and daemon to one app-server. See [Codex managed terminal control](codex-managed-terminal.md). |
| **Codex Desktop** | Incremental rollout history, status, model, token usage, tools, plans, and file changes | Read-only: no remote input, approval, interrupt, kill, resume, or session creation. | Automatically discovered observer; displayed separately from Codex CLI as `codex-desktop`. |
| **OpenCode 1.17.11+** | Sessions, content, status, commands, and interactions | Managed sessions support shared input, permissions, and questions. Existing independent processes stay read-only until safely resumed through the launcher. | Optional launcher connects the official TUI and daemon to one shared server. See [OpenCode managed terminal control](opencode-managed-terminal.md). |
| **DeepSeek Harness 0.2.0-rc.2 (preview)** | Native session history, streaming output, tools and turns | Shared input, queue/steer, cancellation, one-time approvals and questions. | Explicit attachment to the same `dsh web` Host used by the native browser client. |
| **ZCode Desktop** | Incremental history sync from the local SQLite store | Read-only: no remote input, approval, resume, or control. | Explicit opt-in observer for Desktop-owned sessions. |
| **ZCode Runtime** | Live events and turn state of native ZCode sessions | PocketCtl-created sessions support remote creation, shared input, and interrupting active turns; other reverse interaction requests stay unsupported. | Daemon-owned `zcode app-server --stdio` runtime, listed separately from the ZCode Desktop observer. |

PocketCtl is extensible through agent providers. See [Adding an agent](adding-an-agent.md)
for the public adapter contract.
