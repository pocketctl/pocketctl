## ADDED Requirements

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

## MODIFIED Requirements

None — relay-routing 是全新能力补充。
