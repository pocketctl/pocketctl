## MODIFIED Requirements

### Requirement: Daemon registration and tracking
The relay SHALL maintain a registry of connected daemons. Each daemon SHALL register with a unique `daemon_id`, hostname, and list of available agent types. The relay SHALL track daemon online/offline status via heartbeat. When a daemon goes offline, the relay SHALL broadcast a `daemon_status` event to all connected clients with the daemon's `daemon_id`, `status: "offline"`, and `alias` field (string or null).

The relay SHALL include the `alias` field in all `daemon_status` broadcasts and session list responses that reference daemon metadata.

#### Scenario: Daemon comes online
- **WHEN** daemon connects and sends `register` message
- **THEN** relay stores daemon metadata in PostgreSQL
- **AND** relay marks daemon as `online`
- **AND** relay sends `register_ack` with relay-assigned connection ID

#### Scenario: Daemon goes offline
- **WHEN** relay detects WebSocket disconnect from a daemon
- **THEN** relay marks the daemon as `offline` in PostgreSQL
- **AND** relay notifies all connected clients with `daemon_status` event including `daemon_id`, `status: "offline"`, `last_seen_at` timestamp, and `alias`

#### Scenario: Daemon reconnects after offline
- **WHEN** daemon reconnects after being offline
- **THEN** relay marks daemon as `online` in PostgreSQL
- **AND** relay broadcasts `daemon_status` event with `status: "online"` and current `alias` to all clients
- **AND** relay does NOT automatically restore session statuses (daemon reports actual states)

#### Scenario: Daemon status broadcast includes alias
- **WHEN** relay broadcasts any `daemon_status` event
- **THEN** payload SHALL include `alias` field (string if set, null if not set)
