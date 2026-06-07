## ADDED Requirements

### Requirement: Daemon registration and tracking
The relay SHALL maintain a registry of connected daemons. Each daemon SHALL register with a unique `daemon_id`, hostname, and list of available agent types. The relay SHALL track daemon online/offline status via heartbeat. When a daemon goes offline, the relay SHALL broadcast a `daemon_status` event to all connected clients with the daemon's `daemon_id` and `status: "offline"`.

#### Scenario: Daemon comes online
- **WHEN** daemon connects and sends `register` message
- **THEN** relay stores daemon metadata in PostgreSQL
- **AND** relay marks daemon as `online`
- **AND** relay sends `register_ack` with relay-assigned connection ID

#### Scenario: Daemon goes offline
- **WHEN** relay detects WebSocket disconnect from a daemon
- **THEN** relay marks the daemon as `offline` in PostgreSQL
- **AND** relay notifies all connected clients with `daemon_status` event including `daemon_id`, `status: "offline"`, and `last_seen_at` timestamp

#### Scenario: Daemon reconnects after offline
- **WHEN** daemon reconnects after being offline
- **THEN** relay marks daemon as `online` in PostgreSQL
- **AND** relay broadcasts `daemon_status` event with `status: "online"` to all clients
- **AND** relay does NOT automatically restore session statuses (daemon reports actual states)

### Requirement: Session routing between client and daemon
The relay SHALL route messages between clients and daemons based on `session_id`. The relay SHALL maintain a mapping of `session_id → daemon_id` to know which daemon handles each session.

#### Scenario: Client sends message to session
- **WHEN** client sends `user_message` with `session_id: "abc"`
- **THEN** relay looks up which daemon owns session "abc"
- **AND** relay forwards the message to that daemon's WebSocket connection

#### Scenario: Daemon sends event to client
- **WHEN** daemon sends `agent_text` event with `session_id: "abc"`
- **THEN** relay looks up which client(s) are subscribed to session "abc"
- **AND** relay forwards the event to those client WebSocket connections

### Requirement: API key authentication
The relay SHALL authenticate all WebSocket connections using an API key passed as a query parameter or header. Connections without a valid API key SHALL be rejected.

#### Scenario: Valid API key
- **WHEN** daemon or client connects with valid API key
- **THEN** relay accepts the WebSocket connection

#### Scenario: Invalid API key
- **WHEN** connection attempt has missing or invalid API key
- **THEN** relay closes the WebSocket connection immediately with code 4001

### Requirement: Message persistence for offline replay
The relay SHALL persist all session events to PostgreSQL. When a client reconnects, the relay SHALL replay missed events from the last seen sequence number.

#### Scenario: Client reconnects after disconnect
- **WHEN** client reconnects and sends `replay` with `session_id` and `last_seq: 42`
- **THEN** relay queries PostgreSQL for events with seq > 42 for that session
- **AND** relay sends all missed events to the client in order

### Requirement: Relay health endpoint
The relay SHALL expose an HTTP `GET /health` endpoint that returns 200 when the server is running and PostgreSQL is accessible.

#### Scenario: Health check
- **WHEN** HTTP request to `GET /health`
- **THEN** relay returns 200 with `{"status":"ok"}`

### Requirement: Session status update on daemon disconnect
The relay SHALL broadcast `session_status` events for all sessions belonging to a disconnected daemon. These events SHALL include `status: "disconnected"` as a transient overlay indicator. The relay SHALL NOT persist `disconnected` status to the database.

#### Scenario: Daemon disconnect triggers session status broadcast
- **WHEN** relay detects daemon WebSocket disconnect
- **THEN** relay queries all sessions belonging to that daemon
- **AND** relay broadcasts `session_status` event with `status: "disconnected"` for each session to subscribed clients
- **AND** relay does NOT update the `status` column in the sessions table

#### Scenario: Daemon reconnect resolves disconnected overlay
- **WHEN** daemon reconnects and re-registers
- **THEN** relay broadcasts `daemon_status` with `status: "online"`
- **AND** web clients clear the local `disconnected` overlay for that daemon's sessions
- **AND** daemon subsequently sends actual `session_status` events for each session

### Requirement: Session database schema extensions
The relay SHALL extend the sessions table with `last_activity_at` and `exit_reason` columns. Both columns SHALL be nullable to maintain backward compatibility.

#### Scenario: Database migration on startup
- **WHEN** relay starts and the `last_activity_at` column does not exist in the sessions table
- **THEN** relay executes `ALTER TABLE sessions ADD COLUMN last_activity_at TIMESTAMPTZ`
- **AND** relay executes `ALTER TABLE sessions ADD COLUMN exit_reason VARCHAR(32)`

#### Scenario: Session status update persists exit_reason
- **WHEN** relay receives `session_status` event with `exit_reason` field
- **THEN** relay updates the `exit_reason` column for that session in the database

#### Scenario: Event insertion updates last_activity_at
- **WHEN** relay inserts any event for a session into the events table
- **THEN** relay updates `last_activity_at` for that session to the current timestamp

### Requirement: List sessions response includes extended fields
The relay SHALL include `last_activity_at`, `exit_reason`, and `daemon_online` fields in the `list_sessions` response.

#### Scenario: List sessions with extended fields
- **WHEN** client sends `list_sessions` request
- **THEN** relay returns session objects with `last_activity_at`, `exit_reason`, and `daemon_online` (boolean derived from daemon status) fields
- **AND** sessions are sorted by `last_activity_at` descending
