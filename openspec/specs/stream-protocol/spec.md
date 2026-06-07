## ADDED Requirements

### Requirement: WebSocket transport with NDJSON frames
The system SHALL use WebSocket as the transport layer between all components. Every message SHALL be a single NDJSON line (one JSON object terminated by newline). Each message SHALL contain a `type` field that identifies the message kind.

#### Scenario: Daemon connects to relay
- **WHEN** daemon starts and establishes WebSocket connection to relay
- **THEN** daemon sends a `register` message with `daemon_id`, `hostname`, and list of available agents
- **AND** relay responds with a `register_ack` message confirming registration

#### Scenario: Invalid message format
- **WHEN** a component receives a WebSocket message that is not valid JSON
- **THEN** the receiving component SHALL ignore the message and log a warning

### Requirement: Client-to-daemon command messages
The system SHALL define the following command message types sent from client (web/mobile) to daemon: `session_create`, `session_kill`, `user_message`, `approval_response`.

#### Scenario: Create a new agent session
- **WHEN** client sends `{"type":"session_create","agent":"claude-code","cwd":"/path/to/project","prompt":"initial task"}`
- **THEN** daemon spawns the agent CLI process in the specified working directory
- **AND** daemon responds with a `session_created` event containing a unique `session_id`

#### Scenario: Send user message to running session
- **WHEN** client sends `{"type":"user_message","session_id":"abc","content":"refactor the auth module"}`
- **THEN** daemon spawns a new `claude -p "refactor the auth module" --resume abc` process
- **AND** daemon streams output events tagged with `session_id: "abc"`

#### Scenario: Kill a running session
- **WHEN** client sends `{"type":"session_kill","session_id":"abc"}`
- **THEN** daemon terminates the agent process for that session
- **AND** daemon sends a `session_status` event with `status: "killed"`

### Requirement: Daemon-to-client event messages
The system SHALL define the following event message types sent from daemon to client: `session_created`, `agent_text`, `tool_call`, `tool_result`, `session_status`, `error`. The `session_status` event SHALL support the expanded status values: `running`, `waiting_approval`, `idle`, `exited`, `disconnected`, `completed`, `error`, `killed`. The `session_status` event SHALL include optional fields `exit_reason` and `last_activity_at`.

#### Scenario: Agent produces streaming text
- **WHEN** agent emits text output during execution
- **THEN** daemon sends `{"type":"agent_text","session_id":"abc","text":"partial text","streaming":true}` for each chunk
- **AND** sends a final event with `"streaming":false` when the text block is complete

#### Scenario: Agent invokes a tool
- **WHEN** agent calls a tool (e.g., Read, Edit, Bash)
- **THEN** daemon sends `{"type":"tool_call","session_id":"abc","call_id":"call_xxx","tool":"Read","input":{"file_path":"..."}}`
- **AND** subsequently sends `{"type":"tool_result","session_id":"abc","call_id":"call_xxx","output":"file content..."}`

#### Scenario: Session completes
- **WHEN** agent process exits normally
- **THEN** daemon sends `{"type":"session_status","session_id":"abc","status":"completed","cost_usd":0.05,"turns":3}`

#### Scenario: Terminal session exits with reason
- **WHEN** a terminal session's process exits
- **THEN** daemon sends `{"type":"session_status","session_id":"abc","status":"exited","exit_reason":"normal_exit","last_activity_at":"2026-06-06T10:30:00Z"}`

#### Scenario: Daemon status broadcast with last activity
- **WHEN** relay broadcasts session status update
- **THEN** event includes `last_activity_at` field with ISO 8601 timestamp
- **AND** web client uses this to display relative time

### Requirement: Control messages for connection lifecycle
The system SHALL support `ping`/`pong` messages for connection keepalive, and `register`/`register_ack` for daemon identification.

#### Scenario: Keepalive ping
- **WHEN** relay or daemon sends `{"type":"ping"}` over WebSocket
- **THEN** the recipient SHALL respond with `{"type":"pong"}` within 5 seconds

#### Scenario: Daemon heartbeat timeout
- **WHEN** relay does not receive a ping from a daemon within 30 seconds
- **THEN** relay SHALL mark the daemon as offline and notify connected clients

### Requirement: Session status event field extensions
The `session_status` event SHALL support the following optional fields in the `DaemonEvent` structure:
- `exit_reason` (string): One of `user_interrupt`, `normal_exit`, `process_crash`, `signal_kill`, `unknown`. Present only when status is `exited`, `error`, or `killed`.
- `last_activity_at` (string): ISO 8601 timestamp of the last event received for this session. Present on all `session_status` events and `list_sessions` responses.

#### Scenario: Session_status with exit_reason
- **WHEN** daemon sends `session_status` with `status: "exited"`
- **THEN** the event SHALL include `exit_reason` field
- **AND** `exit_reason` SHALL be one of the valid enum values

#### Scenario: Session_status without exit_reason
- **WHEN** daemon sends `session_status` with `status: "running"` or `status: "idle"`
- **THEN** the event SHALL NOT include `exit_reason` field
- **AND** the event SHALL include `last_activity_at` field

#### Scenario: List sessions includes last_activity_at
- **WHEN** client sends `list_sessions` request
- **THEN** relay responds with session objects including `last_activity_at` for each session
- **AND** `last_activity_at` is the timestamp of the most recent event for that session
