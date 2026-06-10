## MODIFIED Requirements

### Requirement: Session lifecycle state machine
The system SHALL define a session lifecycle state machine with 8 states: `running`, `waiting_approval`, `idle`, `exited`, `disconnected`, `completed`, `error`, `killed`. The state machine SHALL define valid transitions between states.

When a session is created or discovered, its initial title SHALL be set to `Terminal Session-{sessionID后8位}` (e.g., "Terminal Session-1def4567"). This replaces the previous behavior of setting title to null or "Terminal Session" without a suffix.

When a daemon session is created via `session_create`, the Daemon SHALL resolve the working directory using `resolveCwd()` and validate it before starting the process. If validation fails, the session SHALL NOT be created and an error event SHALL be returned to the client.

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

#### Scenario: Terminal session default title
- **WHEN** a terminal session is discovered via `session_discovered` event
- **THEN** the session title is set to `Terminal Session-{sessionID后8位}`

#### Scenario: Daemon session default title
- **WHEN** a daemon session is created via `session_created` event with a title from config.Prompt
- **THEN** the session title is set to the provided prompt value
- **AND** if no title is provided, the title is set to `Terminal Session-{sessionID后8位}`

#### Scenario: Session creation with empty CWD
- **WHEN** a `session_create` request arrives with `cwd: ""`
- **THEN** the Daemon resolves cwd to the user's home directory
- **AND** validates the directory exists and is accessible
- **AND** starts the session process in the home directory

#### Scenario: Session creation with invalid CWD
- **WHEN** a `session_create` request arrives with a cwd that does not exist or is not accessible
- **THEN** the Daemon returns an error event with a descriptive message
- **AND** no session is created
- **AND** no process is started
