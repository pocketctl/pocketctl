# Session Sync

Terminal session content and status synchronization between daemon, relay, and web client. Ensures that exit→continue lifecycle transitions correctly update session state across all components.

## Requirements

### Requirement: Exit-then-continue preserves session identity
When a terminal Claude Code session exits (`/exit`) and the user later resumes it (`claude --continue`), the system SHALL treat this as the same session. The session SHALL retain the same `session_id`, the same JSONL file SHALL be used for content persistence, and the relay/DB SHALL update the existing session row rather than creating a new one.

#### Scenario: Normal exit followed by continue
- **WHEN** a terminal session with session_id `abc` is running and the user types `/exit`
- **AND** the Claude Code process exits and its `sessions/<old-pid>.json` file is deleted
- **AND** the user later runs `claude --continue` creating `sessions/<new-pid>.json` with the same session_id `abc`
- **THEN** the SessionWatcher SHALL recognize the session_id as already known
- **AND** the SessionWatcher SHALL emit a `changed` event (not `discovered`)
- **AND** the handler SHALL update the session status to `busy`
- **AND** the relay SHALL update the DB row via `ON CONFLICT (session_id) DO UPDATE`
- **AND** the JSONL tailer SHALL continue reading from the same `abc.jsonl` file at its current offset

#### Scenario: Process crash followed by continue
- **WHEN** a terminal session's process crashes unexpectedly
- **AND** the ProcessMonitor detects the process death and calls `SetSessionExited` with reason `process_crash`
- **AND** the user later runs `claude --continue`
- **THEN** the session SHALL transition from `exited` to `busy`
- **AND** the exit_reason SHALL be cleared

#### Scenario: Multiple exit-continue cycles
- **WHEN** a user performs `/exit` → `claude --continue` → `/exit` → `claude --continue` (two full cycles)
- **THEN** each continue SHALL correctly restore the session to `busy` state
- **AND** the DB row SHALL be the same row throughout all cycles
- **AND** no duplicate sessions SHALL appear in the session list

### Requirement: SessionWatcher preserves known session on file removal
The SessionWatcher SHALL NOT delete entries from `knownSessions` when a PID file is removed. This ensures that a subsequent `--continue` (which creates a new PID file with the same session_id) is correctly identified as `changed` rather than `discovered`.

#### Scenario: PID file removed but session still known
- **WHEN** `sessions/100.json` with session_id `abc` is deleted (old process exited)
- **AND** `knownSessions` contains entry `"abc" → {pid:100, status:"busy"}`
- **THEN** the watcher SHALL emit a `removed` event to notify handlers
- **AND** the `knownSessions["abc"]` entry SHALL be preserved (not deleted)

#### Scenario: New PID file with known session_id
- **WHEN** `sessions/200.json` is created with session_id `abc`
- **AND** `knownSessions["abc"]` still exists from the previous PID file
- **THEN** the watcher SHALL emit a `changed` event with updated PID and status
- **AND** the `knownSessions["abc"]` entry SHALL be updated to reflect the new PID

### Requirement: Re-discovered terminal session updates state
When `RegisterTerminalSession` is called for a session_id that already exists with `source == "terminal"`, the SessionManager SHALL update the session's PID, status, and clear the exit_reason, rather than treating the call as a no-op.

#### Scenario: Terminal session re-discovered after continue
- **WHEN** `RegisterTerminalSession("abc", pid=200, status="busy")` is called
- **AND** `sm.sessions["abc"]` already exists with `source="terminal"`, `status="exited"`, `pid=100`
- **THEN** the session's PID SHALL be updated to 200
- **AND** the session's status SHALL be updated to `busy`
- **AND** the session's exit_reason SHALL be set to empty string
- **AND** the method SHALL return `false` (no new tailer needed, old tailer still works on same JSONL)

#### Scenario: Daemon-spawned process ignored
- **WHEN** `RegisterTerminalSession` is called with a PID that matches an entry in `childPids`
- **THEN** the method SHALL return `false` without registering the session
- **AND** no changes SHALL be made to `sm.sessions`

### Requirement: Discovered handler emits status for re-discovered sessions
When the `handleWatcherEvents` discovered handler encounters a session that is already registered (`registered == false`), it SHALL still call `SetSessionStatus` to emit a `session_status` event to the relay, ensuring the relay and DB status are updated from `exited` to the current status.

#### Scenario: Status update emitted for re-discovered session
- **WHEN** the discovered handler processes a session where `RegisterTerminalSession` returns `false`
- **AND** the session's status from the PID file is `busy`
- **THEN** the handler SHALL call `sm.SetSessionStatus(sessionID, "busy")`
- **AND** a `session_status` event SHALL be sent to the relay via `outputCh`
- **AND** the relay SHALL update the DB row status from `exited` to `busy`

#### Scenario: Web client sees status recovery
- **WHEN** the relay receives a `session_status` event with `status: "busy"` for a session previously in `exited`
- **AND** the relay forwards this to subscribed web clients
- **THEN** the web client SHALL update the status display from "已退出" to "运行中"
- **AND** the exit banner SHALL disappear
- **AND** the message input SHALL become available
