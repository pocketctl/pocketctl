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
The Claude adapter SHALL support multi-turn conversations with two distinct mechanisms based on session source:

- **Terminal sessions** (discovered via watcher, the user's interactive claude): the adapter SHALL send follow-ups by spawning `claude -p "message" --resume <session-id>` when the terminal process has exited and the session is taken over by web/app (existing behavior, unchanged).
- **Daemon sessions** (web-created): the adapter SHALL maintain a persistent PTY interactive claude process and send follow-up messages by writing to the PTY stdin (terminated with `\r`), keeping the SAME process alive across all messages. The adapter SHALL NOT spawn a new `claude -p` process per follow-up for daemon sessions.

#### Scenario: Terminal session follow-up via --resume (unchanged)
- **WHEN** user sends follow-up "now add tests" on an exited terminal session with id "abc-123"
- **THEN** adapter spawns `claude -p "now add tests" --resume abc-123 --output-format stream-json --verbose`
- **AND** Claude Code loads previous conversation and continues

#### Scenario: Daemon session first message via PTY stdin
- **WHEN** user sends the first message "analyze the codebase" on a newly created daemon session
- **THEN** adapter writes "analyze the codebase\r" to the already-running PTY claude process's stdin
- **AND** the persistent process handles the message (no new spawn)
- **AND** the response is captured via JSONL tailer

#### Scenario: Daemon session follow-up via PTY stdin
- **WHEN** user sends a follow-up "now add tests" on a daemon session
- **THEN** adapter writes "now add tests\r" to the SAME PTY process's stdin
- **AND** no new claude process is spawned
- **AND** claude retains in-process context from prior messages

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

### Requirement: PTY stdin submission byte
The adapter SHALL submit user input to a daemon session's PTY claude by writing the message text followed by `\r` (carriage return, mapping to Enter) to the PTY stdin. The adapter SHALL NOT use `\n` as the submit byte, because the claude TUI runs in raw mode where `\n` inserts a newline within the input buffer rather than submitting.

#### Scenario: Message submitted with carriage return
- **WHEN** the adapter sends a user message "hello" to a daemon PTY session
- **THEN** it writes the bytes "hello\r" to PTY stdin
- **AND** the claude TUI receives and submits the input for processing

#### Scenario: Newline rejected as submit byte
- **WHEN** the adapter mistakenly writes "hello\n" to PTY stdin
- **THEN** claude TUI inserts a newline in the input box but does NOT submit
- **AND** no message is processed (regression guard)

### Requirement: PTY launch environment sanitization
The adapter SHALL unset all environment variables whose names begin with `CLAUDE_CODE` (plus `CLAUDECODE` and `CLAUDE_EFFORT`) in the child process environment before exec'ing the PTY claude. This prevents claude from detecting a child-session context (set when the daemon itself runs under Claude Code) and entering ephemeral mode that skips JSONL persistence.

#### Scenario: Inherited child markers removed
- **WHEN** the daemon process environment contains `CLAUDE_CODE_CHILD_SESSION=1`
- **THEN** the PTY child env has `CLAUDE_CODE_CHILD_SESSION` (and all `CLAUDE_CODE_*`) unset
- **AND** the launched claude persists JSONL history

#### Scenario: Persisted JSONL confirms non-ephemeral
- **WHEN** a daemon PTY session processes a message after env sanitization
- **THEN** a JSONL history file is created/updated for the session
- **AND** the tailer forwards structured events to web
