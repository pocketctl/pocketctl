## ADDED Requirements

### Requirement: Daemon registration and tracking
The relay SHALL maintain a registry of connected daemons. Each daemon SHALL register with a unique `daemon_id`, hostname, and list of available agent types. The relay SHALL track daemon online/offline status via heartbeat.

#### Scenario: Daemon comes online
- **WHEN** daemon connects and sends `register` message
- **THEN** relay stores daemon metadata in PostgreSQL
- **AND** relay marks daemon as `online`
- **AND** relay sends `register_ack` with relay-assigned connection ID

#### Scenario: Daemon goes offline
- **WHEN** relay detects WebSocket disconnect from a daemon
- **THEN** relay marks the daemon as `offline` in PostgreSQL
- **AND** relay notifies all connected clients with `daemon_status` event

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
