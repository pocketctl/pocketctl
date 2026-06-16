## ADDED Requirements

### Requirement: Web shows terminal sessions as read-only when process is alive
When a terminal-discovered session has an active process (PID alive), the web session detail page SHALL disable the message input and show a status indicator.

#### Scenario: User opens busy terminal session on web
- **WHEN** user navigates to a terminal session that has an active claude process
- **THEN** the input area SHALL show "终端正在使用此 session" with a disabled input field, and the user can still see real-time events

#### Scenario: Terminal process ends while user is viewing
- **WHEN** the terminal claude process exits while the user has the session detail page open
- **THEN** the input area SHALL become enabled and show "可以发消息了" without requiring a page refresh

### Requirement: App/Web can send messages to idle terminal sessions
When a terminal-discovered session's process has exited, daemon SHALL accept user messages from web clients. The message SHALL be sent by spawning a new `claude -p "<message>" --resume <session-id> --output-format stream-json` process.

#### Scenario: Send follow-up message after terminal session ends
- **WHEN** user sends a message from web to a terminal session whose process has exited
- **THEN** daemon starts a new claude process with `--resume <session-id>`, the response streams back to the web client, and the session status returns to `busy`

#### Scenario: Attempt to send message to busy terminal session
- **WHEN** user tries to send a message from web to a terminal session whose process is still alive
- **THEN** daemon returns an error "session busy in terminal" and the web shows the error to the user

### Requirement: Web-created sessions can be resumed in terminal
Web-created sessions (source=`daemon`) SHALL display a "在终端继续" action that provides the `claude --resume <session-id>` command for the user to run in their terminal.

#### Scenario: User wants to continue web session in terminal
- **WHEN** user clicks "在终端继续" on a web-created session
- **THEN** the UI shows a copyable command: `claude --resume <session-id>`

#### Scenario: User resumes web session in terminal
- **WHEN** user runs `claude --resume <session-id>` in their terminal
- **THEN** Claude Code loads the full conversation history including messages sent from web, and the session continues seamlessly

### Requirement: App/Web sessions from relay persist across daemon restarts
When daemon restarts, it SHALL re-discover terminal sessions by scanning `~/.claude/sessions/` and reconcile with the relay's existing session records.

#### Scenario: Daemon restarts while terminal session is active
- **WHEN** daemon restarts and a terminal claude process is still running
- **THEN** daemon re-discovers the session, resumes tailing the JSONL file from last known offset (or from end if offset unknown), and continues streaming events to relay
