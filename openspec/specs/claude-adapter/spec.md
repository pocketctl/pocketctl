## ADDED Requirements

### Requirement: Claude Code stream-json output parsing
The Claude adapter SHALL parse NDJSON output from `claude -p --output-format stream-json --verbose`. The adapter SHALL extract `type`, `subtype`, and `message.content` fields from each line and emit unified protocol events.

#### Scenario: Text output parsed
- **WHEN** Claude Code emits `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}`
- **THEN** adapter emits `{"type":"agent_text","session_id":"...","text":"Hello","streaming":false}`

#### Scenario: Tool call parsed
- **WHEN** Claude Code emits `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"a.ts"}}]}}`
- **THEN** adapter emits `{"type":"tool_call","session_id":"...","call_id":"call_1","tool":"Read","input":{"file_path":"a.ts"}}`

#### Scenario: Init event handled
- **WHEN** Claude Code emits `{"type":"system","subtype":"init","session_id":"abc",...}`
- **THEN** adapter extracts `session_id` for correlation and discards the event (not forwarded to client)

#### Scenario: Result event parsed
- **WHEN** Claude Code emits `{"type":"result","subtype":"success","num_turns":2,"total_cost_usd":0.05,...}`
- **THEN** adapter emits `{"type":"session_status","session_id":"...","status":"completed","cost_usd":0.05,"turns":2}`

### Requirement: Multi-turn via --resume
The Claude adapter SHALL support multi-turn conversations by spawning a new `claude -p "message" --resume <session-id>` process for each follow-up message.

#### Scenario: First message creates session
- **WHEN** user sends first message "analyze the codebase"
- **THEN** adapter spawns `claude -p "analyze the codebase" --output-format stream-json --verbose --session-id <uuid>`
- **AND** captures the `session_id` from the result event

#### Scenario: Follow-up message resumes session
- **WHEN** user sends follow-up "now add tests" on session with id "abc-123"
- **THEN** adapter spawns `claude -p "now add tests" --resume abc-123 --output-format stream-json --verbose`
- **AND** Claude Code loads previous conversation and continues

### Requirement: Configurable tool permissions
The Claude adapter SHALL accept an `allowed_tools` configuration that maps to `--allowedTools` CLI flag, and a `permission_mode` that maps to `--permission-mode` CLI flag.

#### Scenario: Custom allowed tools
- **WHEN** session is created with `allowed_tools: ["Read","Edit","Bash(git *)"]`
- **THEN** adapter passes `--allowedTools "Read,Edit,Bash(git *)"` to the claude process

#### Scenario: Default permission mode
- **WHEN** session is created without explicit permission_mode
- **THEN** adapter uses `--permission-mode acceptEdits` by default

### Requirement: Claude process lifecycle management
The Claude adapter SHALL manage the lifecycle of spawned claude processes: start, track stdout/stderr, detect exit, and clean up resources.

#### Scenario: Process killed on session_kill
- **WHEN** client sends `session_kill` for a running session
- **THEN** adapter sends SIGTERM to the claude process
- **AND** waits up to 5 seconds for graceful exit
- **AND** sends SIGKILL if process has not exited
