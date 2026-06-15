## MODIFIED Requirements

### Requirement: Client-to-daemon command messages
The system SHALL define the following command message types sent from client (web/mobile) to daemon: `session_create`, `session_kill`, `user_message`, `approval_response`, `list_commands`.

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

#### Scenario: Request available slash commands
- **WHEN** client sends `{"type":"list_commands","session_id":"abc"}`
- **THEN** daemon resolves the working directory (`cwd`) for session `abc`
- **AND** daemon scans builtin/project/user/plugin command sources for that `cwd`
- **AND** daemon responds with a `command_list` event carrying the resolved command list

### Requirement: Daemon-to-client event messages
The system SHALL define the following event message types sent from daemon to client: `session_created`, `agent_text`, `tool_call`, `tool_result`, `session_status`, `error`, `command_list`. The `session_status` event SHALL support the expanded status values: `running`, `waiting_approval`, `idle`, `exited`, `disconnected`, `completed`, `error`, `killed`. The `session_status` event SHALL include optional fields `exit_reason` and `last_activity_at`. The `command_list` event SHALL carry a `commands` array of `CommandItem` objects (each with `name`, `source`, `kind`, `description`, and optional `arg_hint` / `namespace`) and SHALL echo the requesting `session_id`.

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

#### Scenario: Command list returned for a session
- **WHEN** daemon finishes resolving commands for session `abc` in response to `list_commands`
- **THEN** daemon sends `{"type":"command_list","session_id":"abc","commands":[{"name":"clear","source":"builtin","kind":"command","description":"..."},{"name":"codex:rescue","source":"plugin","kind":"skill","namespace":"codex","description":"..."}]}`
- **AND** each command object conforms to the `CommandItem` model
