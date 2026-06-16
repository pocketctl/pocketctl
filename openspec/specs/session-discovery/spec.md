## Purpose
daemon 发现用户在终端启动的 Claude Code session，解析 + tail 其 JSONL 历史，监控进程存活，生成标题——让终端 claude 能被 web/app 看到（session-bridge 的核心 capability）。

## ADDED Requirements

### Requirement: Daemon discovers terminal-started Claude Code sessions
Daemon SHALL monitor `~/.claude/sessions/` directory for new or changed JSON files. Each file represents an active Claude Code session with fields: `pid`, `sessionId`, `cwd`, `status`, `startedAt`.

#### Scenario: User starts claude in terminal
- **WHEN** user runs `claude` in a terminal and Claude Code writes a new `<pid>.json` file to `~/.claude/sessions/`
- **THEN** daemon detects the new file within 2 seconds, reads the session metadata (sessionId, cwd, pid), and registers the session with source=`terminal`

#### Scenario: Daemon startup with existing active sessions
- **WHEN** daemon starts and there are already JSON files in `~/.claude/sessions/`
- **THEN** daemon scans all existing files and registers each active session within 5 seconds

### Requirement: Daemon parses Claude Code JSONL history files
Daemon SHALL parse `~/.claude/projects/<encoded-path>/<session-id>.jsonl` files to extract conversation events. The adapter SHALL convert JSONL entries to pocketctl DaemonEvent format:
- `type: "assistant"` with `content: [{type: "text"}]` → `agent_text` event
- `type: "assistant"` with `content: [{type: "tool_use"}]` → `tool_call` event
- `type: "user"` with `content: [{type: "tool_result"}]` → `tool_result` event

#### Scenario: Parse a complete conversation turn
- **WHEN** daemon reads a JSONL file containing a user message, assistant text, tool call, and tool result
- **THEN** each entry is converted to the corresponding DaemonEvent type and sent to the output channel

#### Scenario: Skip non-essential JSONL entries
- **WHEN** daemon encounters entries with `type: "mode"`, `type: "permission-mode"`, `type: "file-history-snapshot"`, `type: "attachment"`, or `type: "assistant"` with `content: [{type: "thinking"}]`
- **THEN** these entries SHALL be silently skipped without generating events

### Requirement: Daemon tails JSONL files for real-time sync
Daemon SHALL track the file offset of each monitored JSONL file and periodically read new lines. New lines SHALL be parsed and sent as events to the relay.

#### Scenario: Agent generates output during active session
- **WHEN** the terminal claude process appends new lines to the JSONL file
- **THEN** daemon reads and parses the new lines within 1 second and sends DaemonEvents to the relay

#### Scenario: Session JSONL file grows large
- **WHEN** a JSONL file exceeds 5MB during a long session
- **THEN** daemon continues to tail only new content without re-reading the entire file

### Requirement: Daemon monitors terminal process status
Daemon SHALL periodically check whether the terminal Claude Code process (identified by PID from sessions file) is still running. Process status SHALL be reported as a session attribute.

#### Scenario: Terminal claude process is still running
- **WHEN** daemon checks the PID and the process exists
- **THEN** session status SHALL be `busy` and web clients SHALL see the session as read-only

#### Scenario: Terminal claude process has exited
- **WHEN** daemon checks the PID and the process no longer exists
- **THEN** session status SHALL change to `idle` (available for cross-device handoff)

#### Scenario: Sessions file is deleted
- **WHEN** the `<pid>.json` file is removed from `~/.claude/sessions/`
- **THEN** daemon detects the removal and marks the session as `idle`

### Requirement: Sessions table includes title and source
The relay's sessions table SHALL include a `title` column (TEXT, nullable) and a `source` column (VARCHAR, default `'daemon'`). Terminal-discovered sessions SHALL have source=`terminal`.

#### Scenario: Terminal session appears in session list
- **WHEN** daemon registers a terminal-discovered session
- **THEN** the session appears in the web session list with source=`terminal` and a title derived from the first user message

### Requirement: Session title auto-generation
Daemon SHALL generate a readable title for each session by extracting the first user message from the JSONL file, truncated to 60 characters.

#### Scenario: Session with user message
- **WHEN** daemon discovers a session with a first user message "实现用户认证模块 - 添加 JWT 登录"
- **THEN** the session title SHALL be "实现用户认证模块 - 添加 JWT 登录" (or truncated to 60 chars if longer)

#### Scenario: Session with no user message yet
- **WHEN** daemon discovers a session that has not yet written a user message to JSONL
- **THEN** the title SHALL be "Terminal Session" as placeholder, updated when the first user message appears
