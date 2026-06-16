## ADDED Requirements

### Requirement: PTY-based interactive daemon session
The system SHALL create daemon (web-spawned) sessions by launching a persistent `claude` interactive process under a PTY (pseudo-terminal), instead of the one-shot `claude -p` print mode. The PTY process SHALL remain alive across multiple user messages, preserving claude conversation context in-process.

#### Scenario: Web session creation launches PTY claude
- **WHEN** a client sends `session_create` for a new daemon session with cwd and prompt
- **THEN** the daemon spawns `claude` (interactive, no `-p`) under a PTY in the resolved cwd
- **AND** the process stays running awaiting input
- **AND** session status transitions to `idle` (ready for first message)

#### Scenario: PTY process persists across messages
- **WHEN** user sends a second message on an existing daemon session
- **THEN** the daemon writes the message to the SAME PTY process's stdin
- **AND** no new claude process is spawned
- **AND** claude retains the prior conversation context in-process

### Requirement: PTY environment sanitization
The system SHALL remove inherited `CLAUDE_CODE_*` environment variables (notably `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`) before launching the PTY claude process. Without sanitization, claude detects a child-session context and runs ephemeral (no JSONL persistence), which breaks the JSONL output channel.

#### Scenario: Child session marker cleaned before launch
- **WHEN** the daemon is itself running under Claude Code (env contains `CLAUDE_CODE_CHILD_SESSION=1`)
- **THEN** the PTY child process is launched with all `CLAUDE_CODE_*` variables unset
- **AND** the launched claude writes JSONL history normally (not ephemeral)

#### Scenario: Standalone daemon needs no cleanup
- **WHEN** the daemon runs as a normal system service (no `CLAUDE_CODE_*` in env)
- **THEN** the PTY claude launches with the inherited env and persists JSONL normally

### Requirement: Slash command and skill execution
The system SHALL enable slash commands (local commands like `/help`, `/model`, `/compact`) and skills (like `/opsx:new`) to execute when sent from web, by writing the command terminated with `\r` (Enter) to the PTY stdin. The interactive claude SHALL execute these via its client-side slash parser, producing real output — in contrast to `-p` mode which returns synthetic "isn't available" / "No response requested".

#### Scenario: Local command executes
- **WHEN** user sends `/help` from web on a daemon session
- **THEN** daemon writes "/help\r" to PTY stdin
- **AND** interactive claude executes the help command and emits the help content
- **AND** the content is captured to JSONL and forwarded to web

#### Scenario: Skill executes
- **WHEN** user sends `/opsx:new add-auth` from web on a daemon session
- **THEN** daemon writes "/opsx:new add-auth\r" to PTY stdin
- **AND** interactive claude resolves and runs the skill (loads SKILL.md, executes workflow)
- **AND** skill output is captured to JSONL and forwarded to web

#### Scenario: Normal message round-trips
- **WHEN** user sends a plain message "analyze the codebase"
- **THEN** daemon writes "analyze the codebase\r" to PTY stdin
- **AND** claude processes and responds
- **AND** the response is captured to JSONL and forwarded to web

### Requirement: Output via JSONL tailer
The system SHALL obtain structured session output by tailing the PTY claude's JSONL history file (at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`), reusing the existing JSONL tailer mechanism from session-bridge. The daemon SHALL NOT parse PTY stdout (TUI/ANSI) as the primary structured output channel.

#### Scenario: Response captured via JSONL
- **WHEN** PTY claude produces an assistant response
- **THEN** claude writes the response to its JSONL history file
- **AND** the daemon's JSONL tailer picks up the new record within its poll interval
- **AND** the daemon converts it to protocol events (agent_text / tool_call) and forwards to web

#### Scenario: Session id correlation
- **WHEN** the PTY claude process starts and writes its init record
- **THEN** the daemon extracts the session-id from the JSONL init record
- **AND** uses it to locate the JSONL file for tailing

### Requirement: PTY process lifecycle management
The system SHALL manage the PTY claude process lifecycle: keep the process alive while idle, detect unexpected crashes, report status, and shut down gracefully on session end.

#### Scenario: Idle process kept alive
- **WHEN** a daemon session has no activity for a period
- **THEN** the PTY process remains running (idle) ready for the next message
- **AND** session status is `idle`

#### Scenario: Crash detection and status
- **WHEN** the PTY claude process exits unexpectedly (non-zero / crash)
- **THEN** the daemon detects the exit and sets session status to `error` or `exited`
- **AND** emits a `session_status` event to web

#### Scenario: Graceful shutdown on session end
- **WHEN** the user ends the session or the daemon shuts down
- **THEN** the daemon sends a graceful exit to PTY (e.g. `/exit\r` then SIGTERM fallback)
- **AND** waits for the process to exit
- **AND** closes the PTY and stops the JSONL tailer
