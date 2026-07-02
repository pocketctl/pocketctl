### Requirement: Debounced daemon-offline transition

The relay SHALL NOT mark a daemon offline immediately on WebSocket `close`. Instead it SHALL schedule the offline transition (DB `setDaemonOffline`, `daemonOfflinePush`, and the `daemon_status: offline` broadcast) after a configurable grace window (default 30 seconds). If the same `daemon_id` re-registers before the window elapses, the relay SHALL cancel the pending transition so that no offline push or broadcast is emitted.

#### Scenario: Daemon reconnects within the grace window

- **WHEN** a daemon's WebSocket closes and the same `daemon_id` re-registers within the grace window
- **THEN** the pending offline transition is cancelled
- **AND** no `daemonOfflinePush` is sent, no `setDaemonOffline` is written, and no `daemon_status: offline` is broadcast

#### Scenario: Daemon stays disconnected past the grace window

- **WHEN** a daemon's WebSocket closes and no re-register arrives before the grace window elapses
- **THEN** the relay marks the daemon offline in the DB, sends the offline push, and broadcasts `daemon_status: offline`

#### Scenario: Stale socket close does not cancel a live connection

- **WHEN** an old socket's delayed `close` fires after the daemon has already re-registered on a new socket
- **THEN** the relay ignores the stale close and does not schedule an offline transition for the live connection

### Requirement: Suppress offline notifications during graceful shutdown

The relay SHALL install a handler for SIGTERM and SIGINT that sets a `shuttingDown` flag. While this flag is set, the relay SHALL suppress all `daemonOfflinePush` notifications triggered by connections closing as part of shutdown.

#### Scenario: Relay restart does not push offline to users

- **WHEN** the relay receives SIGTERM and its daemon connections close during shutdown
- **THEN** no `daemonOfflinePush` is sent for those daemons

#### Scenario: Daemons reconnect to the new process without an offline flap

- **WHEN** the relay process restarts and daemons reconnect to the new process
- **THEN** users observe at most a transient reconnect, not an offline-then-online notification flap

### Requirement: Optional relay-restarting hint to daemons

The relay MAY, during graceful shutdown, send connected daemons a `relay_restarting` message before closing their sockets. A daemon receiving `relay_restarting` SHALL treat the upcoming disconnect as expected and reconnect promptly without surfacing an error to the user.

#### Scenario: Daemon receives restart hint

- **WHEN** the relay sends `relay_restarting` and then closes the daemon's socket
- **THEN** the daemon reconnects on its normal backoff without logging the disconnect as an error condition
