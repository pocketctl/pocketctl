## MODIFIED Requirements

### Requirement: session_create 精确路由到指定 daemon
Web 客户端发起 session_create 时 SHALL 携带 `daemon_id`，Relay SHALL 用它精确选择目标 daemon（校验属于同 userId 且 online），而非"第一个同用户在线 daemon"。

#### Scenario: 带 daemon_id 精确路由
- **WHEN** Web 发送 `{type:'session_create', daemon_id:'daemon-xxx', agent, cwd, prompt}`
- **AND** 该 daemon 属于同 userId 且 online
- **THEN** Relay 转发给指定 daemon

#### Scenario: daemon 不属于该用户
- **WHEN** daemon_id 指向其他用户的 daemon
- **THEN** Relay 返回 error "no daemons available"

#### Scenario: 兼容不带 daemon_id
- **WHEN** session_create 不带 daemon_id（旧客户端）
- **THEN** Relay 回退到"第一个同用户在线 daemon"

## ADDED Requirements

### Requirement: abort_create 消息清理 pending 会话
新增 `abort_create` 消息类型，用于前端取消超时的会话创建，Daemon 收到后 kill claude 进程并清理 pending session。

#### Scenario: Daemon 处理 abort_create
- **WHEN** Daemon 收到 `{type:'abort_create', session_id: pendingId}`
- **THEN** 调用 AbortSession(pendingId)
- **AND** kill claude 子进程（Cancel context）
- **AND** 从 session map 删除 pending 记录

#### Scenario: abort 时 session 已 resolve
- **WHEN** Daemon 收到 abort_create 但 session 已 resolve 到真实 ID
- **THEN** 忽略 abort（会话已成功，不杀进程）

### Requirement: session_create_failed 失败信号
新增 `session_create_failed` 消息类型，Daemon 启动失败时带原因码发送，Relay 转发给发起方。

#### Scenario: Daemon 启动失败
- **WHEN** CreateSession 的 findAgentCLI / validateCwd / cmd.Start 失败
- **THEN** Daemon 发送 `{type:'session_create_failed', reason: 'no_cli'|'bad_cwd'|'start_fail', error}`
- **AND** Relay 转发给 pendingSessionCreate 中的发起方 client

#### Scenario: daemon 离线中途失败
- **WHEN** 创建过程中 daemon WebSocket 断开
- **THEN** Relay 向发起方发送 `{type:'session_create_failed', reason:'daemon_offline'}`
- **AND** 清理 pendingSessionCreate / pendingSessionMeta

### Requirement: session_id_changed 主动通知发起方
Relay 处理 session_id_changed 时，SHALL 在迁移 DB 和订阅后，主动向原始发起方 client 补发一帧，确保即使订阅迁移有竞态，发起方也一定收到真实 ID。

#### Scenario: 主动补发发起方
- **WHEN** Relay 收到 session_id_changed (real, old=pending)
- **THEN** UPDATE sessions/events pending→real
- **AND** 迁移 client 订阅
- **AND** 主动向 pendingSessionMeta 记录的 originClient 补发 session_id_changed 帧
