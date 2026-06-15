## MODIFIED Requirements

### Requirement: Daemon-to-client event messages
The system SHALL define the following event message types sent from daemon to client: `session_created`, `agent_text`, `tool_call`, `tool_result`, `session_status`, `error`, `command_list`, `command_receipt`. The `session_status` event SHALL support the expanded status values: `running`, `waiting_approval`, `idle`, `exited`, `disconnected`, `completed`, `error`, `killed`. The `session_status` event SHALL include optional fields `exit_reason` and `last_activity_at`. The `command_list` event SHALL carry a `commands` array of `CommandItem` objects (each with `name`, `source`, `kind`, `description`, and optional `arg_hint` / `namespace`) and SHALL echo the requesting `session_id`. The `command_receipt` event SHALL carry a `command` name (e.g. "/compact"), a `receipt_status` (`success` / `failed` / `unavailable`), an optional `message`, and SHALL echo the `session_id`.

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

#### Scenario: Command execution receipt returned for a slash command
- **WHEN** daemon detects a local command's execution outcome (synthetic assistant text and/or `/compact` system status) for session `abc`
- **THEN** daemon sends `{"type":"command_receipt","session_id":"abc","command":"/compact","receipt_status":"failed","message":"Not enough messages to compact."}`
- **AND** `receipt_status` SHALL be one of `success`, `failed`, `unavailable`
