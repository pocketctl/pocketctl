## Why

当用户在 Mac 终端退出 Claude Code session 时，系统将终端 session 状态标记为 `idle`，与「等待用户输入的 idle」无法区分。Daemon 离线时 Web 端也没有明确的状态指示，用户无法判断 session 是暂时的网络中断还是永久的进程退出。这导致 Web 端用户在终端 session 结束后无法理解当前状态，也无法从 Web 端恢复已退出的 session。

## What Changes

- **新增 `exited` 和 `disconnected` 两个 session 状态常量**，替代终端进程退出后不当使用的 `idle` 状态
- **Session 状态语义细化**：终端进程正常退出 → `exited`；daemon 与 relay 断开 → 所属 session 标记为 `disconnected`；原有的 `idle` 仅保留给「等待用户输入」语义
- **Session Manager 退出逻辑改造**：ProcessMonitor 检测到终端进程死亡时，标记为 `exited` 而非 `idle`，并携带退出原因（用户中断、正常完成、异常退出）
- **Relay daemon 断开广播**：daemon WebSocket 断开时，relay 将其所有 session 标记为 `disconnected` 并广播给 Web 客户端；daemon 重连后自动恢复原状态
- **Web 端状态指示器增强**：Session 列表中用不同颜色和图标区分 running / idle / exited / disconnected / error / killed 等状态
- **Daemon 离线横幅**：Web 顶部显示 daemon 在线状态，离线时醒目提示并显示最后在线时间
- **Terminal Session 退出后 UI**：SessionDetail 中显示退出 banner 和 Resume 按钮，支持从 Web 端恢复已退出的终端 session
- **时间戳信息增强**：Session 列表和详情中显示 `last_activity_at` 和相对时间（如「3分钟前」）
- **会话只读标识**：退出的 session 标注为「已归档/只读」，区分「可继续恢复」与「仅可查看历史」
- **退出原因展示**：区分用户中断（Ctrl+C）、正常完成、连接丢失、Daemon 停止等退出原因
- **Session 生命周期时间线**：Session 详情页展示从 created → running → idle → exited 的 mini timeline
- **浏览器通知**：终端 session 退出时推送浏览器通知（需用户授权）

## Capabilities

### New Capabilities
- `session-lifecycle`: Session 生命周期状态机定义，包括完整的状态集（running, waiting_approval, idle, exited, disconnected, completed, error, killed）、状态转换规则、退出原因枚举、以及 daemon 在线/离线对 session 状态的影响

### Modified Capabilities
- `agent-session`: 新增 exited 状态处理，终端进程退出逻辑从 SetSessionIdle 改为 SetSessionExited 并携带退出原因；新增 Resume 功能（对 exited 状态的终端 session 调用 `claude --resume`）
- `stream-protocol`: 状态常量扩展（新增 `exited`, `disconnected`），新增 `exit_reason` 字段到 session_status 事件，新增 `last_activity_at` 字段
- `relay-routing`: daemon 断开时将所有关联 session 标记为 `disconnected` 并广播；daemon 重连时恢复 session 状态；新增 `last_activity_at` 和 `exit_reason` 数据库字段
- `web-ui`: Session 列表状态指示器增强（6种颜色/图标区分）；新增 Daemon 离线横幅组件；SessionDetail 退出 banner 和 Resume 按钮；只读/归档标识；生命周期时间线；相对时间显示；浏览器通知集成

## Impact

- **协议层**: `internal/protocol/types.go` — 新增状态常量和 DaemonEvent 字段（exit_reason, last_activity_at）
- **Daemon 层**: `internal/session/manager.go` — SetSessionIdle 重构为 SetSessionExited，新增 ResumeSession 方法；`internal/watcher/process.go` — ProcessMonitor 携带退出原因
- **Relay 层**: `relay/src/router.ts` — unregisterDaemon 中广播 disconnected 状态；`relay/src/db.ts` — sessions 表新增 last_activity_at、exit_reason 列
- **Web 前端**: `web/src/views/SessionList.vue` — 状态颜色/图标重构；`web/src/views/SessionDetail.vue` — 退出 banner、Resume 按钮、时间线；`web/src/components/ConnectionBanner.vue` — daemon 离线横幅；新增 `web/src/components/SessionTimeline.vue` 组件
- **数据库迁移**: relay/src/db.ts 中 sessions 表 schema 变更（新增列）
- **向下兼容**: 新增的状态值（exited, disconnected）是原有状态集的扩展，旧客户端不识别新状态时可 fallback 显示为 `completed`；新增字段为可选字段，不破坏现有消息格式
