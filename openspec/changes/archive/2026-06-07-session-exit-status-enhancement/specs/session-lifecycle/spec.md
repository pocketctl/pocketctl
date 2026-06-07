## ADDED Requirements

### Requirement: Session lifecycle state machine
The system SHALL define a session lifecycle state machine with 8 states: `running`, `waiting_approval`, `idle`, `exited`, `disconnected`, `completed`, `error`, `killed`. The state machine SHALL define valid transitions between states.

#### Scenario: Terminal session full lifecycle
- **WHEN** a terminal session is discovered with a running Claude Code process
- **THEN** state transitions follow: `running` → `idle` → `running` → `idle` → `exited`
- **AND** each transition emits a `session_status` event

#### Scenario: Daemon session full lifecycle
- **WHEN** a daemon-spawned session runs to completion
- **THEN** state transitions follow: `running` → `completed`
- **AND** final state is `completed` with `cost_usd` and `turns` fields

#### Scenario: Invalid state transition rejected
- **WHEN** a session is in `exited` state and an event attempts to set it to `running` without a resume
- **THEN** the transition is rejected and an error is logged

### Requirement: Valid state transitions
The system SHALL enforce the following valid state transitions:

- `running` → `idle`, `waiting_approval`, `error`, `killed`, `exited`, `completed`
- `idle` → `running`, `exited`
- `waiting_approval` → `running`, `idle`, `exited`
- `exited` → `running` (via resume only)
- `disconnected` → any state (overlay, resolved on daemon reconnect)
- `completed` → (terminal state)
- `error` → (terminal state)
- `killed` → (terminal state)

#### Scenario: Resume from exited state
- **WHEN** user sends a message to a session in `exited` state
- **THEN** session transitions to `running` via the resume mechanism
- **AND** daemon spawns `claude --resume <session_id>` process

#### Scenario: Exited session cannot transition to idle
- **WHEN** a session is in `exited` state
- **THEN** the system SHALL NOT transition it to `idle` without a resume

### Requirement: Exit reason tracking
The system SHALL track an exit reason for sessions that reach `exited` or terminal states. Exit reasons SHALL be one of: `user_interrupt`, `normal_exit`, `process_crash`, `signal_kill`, `unknown`.

#### Scenario: Terminal process exits normally
- **WHEN** a terminal session's Claude Code process exits and the session file shows `status: "idle"`
- **THEN** exit reason is set to `normal_exit`

#### Scenario: Terminal process killed by signal
- **WHEN** daemon kills a session with SIGTERM or SIGKILL
- **THEN** exit reason is set to `signal_kill`

#### Scenario: Exit reason unknown
- **WHEN** a terminal session's process exits and no exit code or signal information is available
- **THEN** exit reason is set to `unknown`

#### Scenario: User interrupt detection
- **WHEN** a terminal session's process exits with SIGINT (exit code 130 or signal 2)
- **THEN** exit reason is set to `user_interrupt`

### Requirement: Daemon online status affects session display
When a daemon goes offline, its sessions SHALL be displayed as `disconnected` in the web UI. When the daemon comes back online, the sessions SHALL revert to their actual persisted status.

#### Scenario: Daemon goes offline
- **WHEN** relay detects daemon WebSocket disconnect
- **THEN** relay broadcasts `daemon_status` event with `status: "offline"` to all clients
- **AND** web UI displays all sessions belonging to that daemon as `disconnected`

#### Scenario: Daemon comes back online
- **WHEN** daemon reconnects and re-registers with relay
- **THEN** relay broadcasts `daemon_status` event with `status: "online"` to all clients
- **AND** daemon reports actual session states
- **AND** web UI reverts sessions to their real status

#### Scenario: Daemon offline overlay not persisted
- **WHEN** daemon goes offline and web client refreshes the page
- **THEN** sessions are loaded from DB with their real status
- **AND** web client applies `disconnected` overlay locally after receiving `daemon_status: offline`

### Requirement: Last activity timestamp
Each session SHALL track a `last_activity_at` timestamp that updates whenever a session event is received. The `last_activity_at` SHALL be displayed in the web UI as a relative time string.

#### Scenario: Activity timestamp updated on event
- **WHEN** daemon sends any event for a session (agent_text, tool_call, session_status, etc.)
- **THEN** `last_activity_at` is updated to the current timestamp
- **AND** web UI displays the relative time (e.g., "3分钟前")

#### Scenario: Session list sorted by last activity
- **WHEN** user views the session list
- **THEN** sessions are sorted by `last_activity_at` descending (most recent first)
