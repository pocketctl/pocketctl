## MODIFIED Requirements

### Requirement: Daemon registration and tracking
The relay SHALL maintain a registry of connected daemons. Each daemon SHALL register with a unique `daemon_id`, hostname, and list of available agent types. The relay SHALL track daemon online/offline status via heartbeat. When a daemon goes offline, the relay SHALL broadcast a `daemon_status` event to all connected clients with the daemon's `daemon_id` and `status: "offline"`.

Before accepting a new registration, the relay SHALL check the user's plan, whitelist status, and current online daemon count. If the user is whitelisted, the relay SHALL skip all limit checks. If the user is on the free plan (and not whitelisted) and already has 1 online daemon, the relay SHALL reject the registration with a `DAEMON_LIMIT_REACHED` error.

#### Scenario: Daemon comes online
- **WHEN** daemon connects and sends `register` message
- **AND** the user's plan allows more daemons
- **THEN** relay stores daemon metadata in PostgreSQL
- **AND** relay marks daemon as `online`
- **AND** relay sends `register_ack` with relay-assigned connection ID

#### Scenario: Daemon registration rejected due to limit
- **WHEN** daemon connects and sends `register` message
- **AND** the user is on free plan (not whitelisted) with 1 online daemon already
- **THEN** relay sends error event with `code: "DAEMON_LIMIT_REACHED"`
- **AND** relay closes the WebSocket connection
- **AND** relay does NOT store the daemon metadata

#### Scenario: Whitelist user bypasses limit
- **WHEN** daemon connects and sends `register` message
- **AND** the user has `whitelist = true`
- **THEN** relay accepts the registration regardless of plan or online daemon count

#### Scenario: Daemon goes offline
- **WHEN** relay detects WebSocket disconnect from a daemon
- **THEN** relay marks the daemon as `offline` in PostgreSQL
- **AND** relay notifies all connected clients with `daemon_status` event including `daemon_id`, `status: "offline"`, and `last_seen_at` timestamp

#### Scenario: Daemon reconnects after offline
- **WHEN** daemon reconnects after being offline
- **THEN** relay marks daemon as `online` in PostgreSQL
- **AND** relay broadcasts `daemon_status` event with `status: "online"` to all clients
- **AND** relay does NOT automatically restore session statuses (daemon reports actual states)
