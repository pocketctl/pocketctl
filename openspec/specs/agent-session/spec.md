## ADDED Requirements

### Requirement: Daemon discovers available agent CLIs
The daemon SHALL scan the system PATH on startup and detect installed agent CLIs. The daemon SHALL report available agents to the relay during registration.

#### Scenario: Claude Code detected
- **WHEN** daemon starts and `claude` binary is found on PATH
- **THEN** daemon registers agent type `claude-code` with its version

#### Scenario: No agents found
- **WHEN** daemon starts and no supported agent CLI is on PATH
- **THEN** daemon logs a warning but continues running
- **AND** daemon reports an empty agent list to the relay

### Requirement: Daemon manages concurrent agent sessions
The daemon SHALL support running multiple agent processes simultaneously, each in its own goroutine. Each session SHALL have a unique `session_id` (UUID). The daemon SHALL track session state using the expanded state set: `running`, `waiting_approval`, `idle`, `exited`, `completed`, `error`, `killed`.

#### Scenario: Two sessions running concurrently
- **WHEN** user creates two sessions with different prompts
- **THEN** daemon spawns two independent `claude` processes
- **AND** streams from both sessions are tagged with their respective `session_id`
- **AND** output does not interleave between sessions

#### Scenario: Session process exits with error
- **WHEN** an agent process exits with non-zero code
- **THEN** daemon sends `{"type":"session_status","session_id":"...","status":"error","error":"process exited with code 1"}`
- **AND** daemon cleans up process resources

#### Scenario: Terminal session process exits normally
- **WHEN** a terminal session's Claude Code process exits (PID no longer alive) and the session was in `idle` or `running` state
- **THEN** daemon sets session status to `exited` (not `idle`)
- **AND** daemon sends `{"type":"session_status","session_id":"...","status":"exited","exit_reason":"normal_exit"}`
- **AND** daemon cleans up the JSONL tailer for that session

#### Scenario: Terminal session process killed by daemon
- **WHEN** daemon kills a terminal session process via SIGTERM/SIGKILL
- **THEN** daemon sets session status to `killed`
- **AND** daemon sends `{"type":"session_status","session_id":"...","status":"killed","exit_reason":"signal_kill"}`

### Requirement: Daemon handles session working directory
Each session SHALL run in a configurable working directory (`cwd`). If not specified, the daemon's working directory SHALL be used.

#### Scenario: Session with explicit cwd
- **WHEN** client sends `session_create` with `cwd: "/Users/dev/myproject"`
- **THEN** the agent process is spawned with its working directory set to `/Users/dev/myproject`

### Requirement: Daemon reconnects to relay on disconnect
The daemon SHALL automatically reconnect to the relay server when the WebSocket connection drops. The daemon SHALL use exponential backoff (starting at 1s, max 30s).

#### Scenario: Network interruption
- **WHEN** WebSocket connection to relay is lost
- **THEN** daemon retries connection after 1s, then 2s, 4s, 8s... up to 30s
- **AND** local agent sessions continue running unaffected
- **AND** on reconnect, daemon re-registers and resumes streaming

### Requirement: Daemon exposes CLI interface
The daemon SHALL provide a CLI with subcommands: `start`, `stop`, `status`, `logs`.

#### Scenario: Start daemon
- **WHEN** user runs `pocketctl daemon start --relay wss://relay.example.com --api-key <key>`
- **THEN** daemon starts in background, connects to relay, and begins accepting sessions

#### Scenario: Check daemon status
- **WHEN** user runs `pocketctl daemon status`
- **THEN** daemon prints status including relay connection state, active sessions, and available agents

### Requirement: Terminal session exit detection with reason
The daemon SHALL detect when a terminal session's Claude Code process exits and determine the exit reason. The daemon SHALL emit a `session_status` event with `status: "exited"` and the appropriate `exit_reason`.

#### Scenario: Process monitor detects PID death
- **WHEN** ProcessMonitor detects that a tracked PID is no longer alive
- **THEN** session manager sets the session status to `exited`
- **AND** session manager includes `exit_reason` in the status event

#### Scenario: Session file removed before process exit
- **WHEN** the session file (`~/.claude/sessions/<pid>.json`) is deleted
- **THEN** daemon sets session status to `exited` with `exit_reason: "unknown"`
- **AND** daemon stops the JSONL tailer

### Requirement: Resume exited terminal session
The daemon SHALL support resuming an `exited` terminal session when the web client sends a `user_message`. The daemon SHALL spawn a new `claude --resume <session_id>` process to continue the conversation.

#### Scenario: Resume from web client
- **WHEN** web client sends `user_message` to a session with status `exited` AND daemon is online
- **THEN** daemon spawns `claude -p "<message>" --resume <session_id> --output-format stream-json --verbose`
- **AND** session status transitions to `running`
- **AND** output is streamed via the existing JSONL tailer mechanism

#### Scenario: Resume fails due to missing session data
- **WHEN** web client sends `user_message` to an `exited` session AND the JSONL file has been deleted
- **THEN** daemon returns an error: `{"type":"error","session_id":"...","error":"Session history no longer available, cannot resume"}`
- **AND** session status remains `exited`

#### Scenario: Resume while daemon is offline
- **WHEN** web client sends `user_message` to a session whose daemon is offline
- **THEN** relay returns an error to the client: `{"type":"error","error":"Daemon is offline, cannot resume session"}`
