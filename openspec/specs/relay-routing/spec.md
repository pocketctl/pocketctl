## ADDED Requirements

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

### Requirement: Session routing between client and daemon
The relay SHALL route messages between clients and daemons based on `session_id`. The relay SHALL maintain a mapping of `session_id → daemon_id` to know which daemon handles each session.

The relay SHALL handle a new `generate_title_request` event from daemons. When received, the relay SHALL call the title generation service with the provided user and assistant messages, conditionally update the session title in the database (only if the current title matches the default pattern `Terminal Session-%`), and broadcast the updated title to subscribed clients.

#### Scenario: Client sends message to session
- **WHEN** client sends `user_message` with `session_id: "abc"`
- **THEN** relay looks up which daemon owns session "abc"
- **AND** relay forwards the message to that daemon's WebSocket connection

#### Scenario: Daemon sends event to client
- **WHEN** daemon sends `agent_text` event with `session_id: "abc"`
- **THEN** relay looks up which client(s) are subscribed to session "abc"
- **AND** relay forwards the event to those client WebSocket connections

#### Scenario: Daemon sends generate_title_request
- **WHEN** daemon sends `generate_title_request` with `session_id`, `user_message`, and `assistant_message`
- **THEN** relay calls the title generation service with both messages
- **AND** relay updates the session title in the database only if the current title matches `Terminal Session-%`
- **AND** relay broadcasts `session_title_update` to all subscribed clients

#### Scenario: generate_title_request for session with custom title
- **WHEN** daemon sends `generate_title_request` for a session whose title is already "React暗色模式组件"
- **THEN** relay SHALL skip the title generation and database update
- **AND** no `session_title_update` event is broadcast

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

The relay SHALL provide a conditional title update function that only updates the title when the current value matches the default pattern `Terminal Session-%`.

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

#### Scenario: Conditional title update — default title exists
- **WHEN** relay updates a session title where the current title is "Terminal Session-1def4567"
- **THEN** the SQL update uses a WHERE clause: `title LIKE 'Terminal Session-%'`
- **AND** the title is updated to the generated value

#### Scenario: Conditional title update — custom title exists
- **WHEN** relay attempts to update a session title where the current title is "React暗色模式组件"
- **THEN** the SQL WHERE clause `title LIKE 'Terminal Session-%'` does not match
- **AND** no update occurs

### Requirement: List sessions response includes extended fields
The relay SHALL include `last_activity_at`, `exit_reason`, and `daemon_online` fields in the `list_sessions` response.

#### Scenario: List sessions with extended fields
- **WHEN** client sends `list_sessions` request
- **THEN** relay returns session objects with `last_activity_at`, `exit_reason`, and `daemon_online` (boolean derived from daemon status) fields
- **AND** sessions are sorted by `last_activity_at` descending

### Requirement: Relay responds to list_sessions command
Relay SHALL 处理 `{ type: "list_sessions" }` 客户端消息，从 PostgreSQL sessions 表查询所有 session 并返回 `{ type: "session_list", sessions: [...] }`。

#### Scenario: Client requests session list
- **WHEN** 客户端发送 `{ type: "list_sessions" }`
- **THEN** relay 返回 `{ type: "session_list", sessions: [{ session_id, status, agent_type, cwd, created_at }] }`，按 created_at DESC 排序

#### Scenario: No sessions in database
- **WHEN** 数据库中无 session 记录
- **THEN** relay 返回 `{ type: "session_list", sessions: [] }`

### Requirement: Relay persists session on session_created event
Relay SHALL 在收到 daemon 的 `session_created` 事件时，将 session 写入 PostgreSQL sessions 表，包含 agent_type 和 cwd 元数据。

#### Scenario: Session created with metadata
- **WHEN** daemon 发送 `{ type: "session_created", session_id: "abc-123" }`，且之前客户端发送了 `session_create` 包含 agent="claude-code" cwd="/project"
- **THEN** relay 在 sessions 表插入/更新一行，agent_type="claude-code", cwd="/project", status="running"

### Requirement: Relay handles session_id_changed event
Relay SHALL 在收到 daemon 的 `session_id_changed` 事件时，更新数据库中的 session_id，并通知所有订阅的客户端。

#### Scenario: Session ID changes from pending to real UUID
- **WHEN** daemon 发送 `{ type: "session_id_changed", session_id: "real-uuid", old_session_id: "pending-123" }`
- **THEN** relay 将 sessions 表中 pending-123 更新为 real-uuid，更新 sessionToDaemon 映射，转发事件给订阅的客户端

### Requirement: Relay routes error events to pending client
Relay SHALL 在收到 daemon 的 `error` 事件（无 session_id）时，将错误转发给正在等待 session_create 响应的客户端。

#### Scenario: Session creation fails
- **WHEN** daemon 发送 `{ type: "error", error: "chdir /bad/path: no such file" }` 且该 daemon 有 pendingSessionCreate 记录
- **THEN** relay 将此错误消息转发给发起 session_create 的客户端

### Requirement: Relay updates session status on session_status event
Relay SHALL 在收到 `session_status` 事件时，更新 sessions 表中对应 session 的 status 字段。

#### Scenario: Session completes
- **WHEN** daemon 发送 `{ type: "session_status", session_id: "abc-123", status: "completed" }`
- **THEN** relay 更新 sessions 表中 abc-123 的 status 为 "completed"
