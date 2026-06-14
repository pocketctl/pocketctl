## ADDED Requirements

### Requirement: daemon_restart 远程重启命令
relay SHALL 支持通过 WS 发送 `daemon_restart` 命令给在线 daemon，daemon 收到后优雅重启。

#### Scenario: relay 转发重启命令
- **WHEN** Web 发送 `{type:'daemon_restart', daemon_id}`
- **THEN** relay 将 daemon 状态设为 reconnecting
- **AND** relay 转发 daemon_restart 给目标 daemon

#### Scenario: daemon 处理重启
- **WHEN** daemon 收到 daemon_restart 命令
- **THEN** daemon 调用 RestartDaemon()（复用 internal/update/updater.go）
- **AND** WS 连接断开
- **AND** daemon 自动重连（复用 ws/client.go reconnect 逻辑）
- **AND** relay 收到重新 register 后恢复 online 状态

#### Scenario: reconnecting 中间态
- **WHEN** daemon 状态为 reconnecting
- **THEN** Web 显示橙色状态 + 「正在重启…」禁用按钮带 spinner
- **AND** relay 在 daemon 重新 register 后自动恢复 online

### Requirement: REST daemon_restart 端点
relay SHALL 提供 `POST /api/daemons/:daemonId/restart` REST 端点。

#### Scenario: REST 重启
- **WHEN** client 发送 `POST /api/daemons/:daemonId/restart`（Bearer 认证）
- **THEN** relay 校验 daemon 属于该 user
- **AND** relay 通过 WS 发送 daemon_restart 给目标 daemon
- **AND** 返回 `{success: true}`
