## Purpose
web 创建的 daemon session 通过 PTY 跑 interactive claude（非 `-p`），支持 skill/slash command 执行，对齐终端 claude 的交互能力。interactive-web-session change 的核心 capability。

## ADDED Requirements

### Requirement: PTY-based interactive daemon session
The system SHALL create daemon (web-spawned) sessions by launching a persistent `claude` interactive process under a PTY (pseudo-terminal), instead of the one-shot `claude -p` print mode. The PTY process SHALL remain alive across multiple user messages, preserving claude conversation context in-process. The session-id SHALL be specified up front via `--session-id <uuid>` so the JSONL history file path is known immediately (claude respects `--session-id` and writes `<uuid>.jsonl`).

#### Scenario: Web session creation launches PTY claude
- **WHEN** a client sends `session_create` for a new daemon session with cwd and prompt
- **THEN** the daemon spawns `claude --session-id <uuid> --permission-mode acceptEdits` (interactive, no `-p`) under a PTY in the resolved cwd
- **AND** the process stays running awaiting input
- **AND** session status transitions to `idle` (ready for first message)
- **AND** the session-id returned to web is the real `<uuid>` (no pending phase)

#### Scenario: PTY process persists across messages
- **WHEN** user sends a second message on an existing daemon session
- **THEN** the daemon writes the message to the SAME PTY process's stdin
- **AND** no new claude process is spawned
- **AND** claude retains the prior conversation context in-process

### Requirement: PTY environment sanitization
The system SHALL remove inherited `CLAUDE_CODE_*` environment variables (notably `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_EFFORT`) before launching the PTY claude process. Without sanitization, claude detects a child-session context and runs ephemeral (no JSONL persistence), which breaks the JSONL output channel. `ANTHROPIC_*`, `PATH`, `HOME`, `TERM*` SHALL be preserved.

#### Scenario: Child session marker cleaned before launch
- **WHEN** the daemon is itself running under Claude Code (env contains `CLAUDE_CODE_CHILD_SESSION=1`)
- **THEN** the PTY child process is launched with all `CLAUDE_CODE_*` variables unset
- **AND** the launched claude writes JSONL history normally (not ephemeral)

#### Scenario: Standalone daemon needs no cleanup
- **WHEN** the daemon runs as a normal system service (no `CLAUDE_CODE_*` in env)
- **THEN** the PTY claude launches with the inherited env and persists JSONL normally

### Requirement: Skill execution via PTY stdin (slash commands limited)
The system SHALL enable **skills** (like `/opsx:new`) to execute when sent from web, by writing the command terminated with `\r` (Enter) to the PTY stdin. The interactive claude SHALL resolve and run the skill (load SKILL.md, execute workflow), producing real output captured to JSONL.

**Known limitation (claude-side, not pocketctl-controllable)**: claude's **local commands** (`/help`, `/model`, `/compact`, etc.) return "isn't available in this environment" under go `creack/pty` (python `pty.fork` works; isTTY/winsize/env all verified correct; root cause in PTY implementation detail, claude closed-source). Skills are unaffected (LLM-executed). Local commands should be used in the terminal claude.

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

#### Scenario: Local command returns isn't-available (claude PTY limitation)
- **WHEN** user sends `/help` from web on a daemon session
- **THEN** daemon writes "/help\r" to PTY stdin
- **AND** claude's local command returns "/help isn't available in this environment" (go creack/pty detected non-interactive for local commands)
- **AND** the receipt is captured to JSONL and forwarded to web as a command_receipt (status unavailable)

### Requirement: PTY stdout drain + output via JSONL tailer
The daemon SHALL continuously drain the PTY master stdout (`io.Copy(io.Discard, ptmx)`) to prevent the PTY buffer from filling and blocking claude. Structured session output SHALL be obtained by tailing the PTY claude's JSONL history file (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`), reusing the JSONL tailer from session-bridge. The daemon SHALL NOT parse PTY stdout (TUI/ANSI) as the structured output channel. The tailer SHALL be started after the first turn (claude writes JSONL only after the first turn is processed), retrying `ResolveJSONLPath` until the file appears.

#### Scenario: Response captured via JSONL
- **WHEN** PTY claude produces an assistant response
- **THEN** claude writes the response to its JSONL history file (after the turn is processed)
- **AND** the daemon's JSONL tailer picks up the new record within its poll interval
- **AND** the daemon converts it to protocol events (agent_text / tool_call) and forwards to web

#### Scenario: PTY stdout drained to prevent stall
- **WHEN** claude's TUI continuously writes (banner, spinner)
- **THEN** the daemon drains the PTY master stdout (discarded)
- **AND** the PTY buffer never fills (claude never blocks before writing JSONL)

### Requirement: PTY process lifecycle management
The system SHALL manage the PTY claude process lifecycle: keep the process alive while idle, drain stdout continuously, detect unexpected crashes, report status, and shut down gracefully on session end.

#### Scenario: Idle process kept alive
- **WHEN** a daemon session has no activity for a period
- **THEN** the PTY process remains running (idle) ready for the next message
- **AND** session status is `idle`

#### Scenario: Crash detection and status
- **WHEN** the PTY claude process exits unexpectedly (non-zero / crash)
- **THEN** the daemon detects the exit (cmd.Wait) and sets session status to `error` or `exited`
- **AND** emits a `session_status` event to web

#### Scenario: Graceful shutdown on session end
- **WHEN** the user ends the session (KillSession) or the daemon shuts down
- **THEN** the daemon writes `/exit\r` to PTY, then closes the PTY master
- **AND** the JSONL tailer is stopped via context cancellation
