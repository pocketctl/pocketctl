## Context

pocketctl 采用三层架构：Web UI (Vue 3) ← WebSocket → Relay (Node.js/Fastify) ← WebSocket → Daemon (Go)。Daemon 监控两类 session：**daemon session**（daemon 自己 spawn 的）和 **terminal session**（用户在终端手动启动的，通过 fsnotify 监听 `~/.claude/sessions/` 发现）。

当前 session 状态集为：`running`, `waiting_approval`, `idle`, `completed`, `error`, `killed`。

**核心问题**：
1. Terminal session 的 Claude 进程退出后，`ProcessMonitor` 检测到 PID 死亡，调用 `SetSessionIdle()` 将状态设为 `idle`。这和「正在等待用户输入的 idle」无法区分。
2. Daemon 与 relay 断开后，relay 的 `unregisterDaemon()` 仅将 daemon 标记为 offline，但没有将其关联的 session 状态做任何变更，Web 端 session 看起来还是 `running` 或 `idle`。
3. 没有退出原因记录，Web 端无法告知用户为什么 session 结束了。

**关键约束**：
- 终端 session 的生命周期由 Claude Code CLI 控制，daemon 只能通过文件系统观察和 PID 监控间接感知
- Daemon 重连后需要恢复 session 的真实状态（可能 session 在 daemon 离线期间已经 exited）
- Relay 的 PostgreSQL 中存储了 session 状态，需要与 daemon 的内存状态协调

## Goals / Non-Goals

**Goals:**
- 引入 `exited` 状态，精确表达「终端进程已退出」语义，与 `idle`（等待输入）彻底区分
- 引入 `disconnected` 状态，表达「daemon 与 relay 连接断开，session 状态未知」
- 在 Web 端完整呈现 session 生命周期的每个阶段
- 支持从 Web 端恢复已退出的 terminal session（利用已有的 `claude --resume` 机制）
- 记录退出原因和最后活跃时间，增强可观测性

**Non-Goals:**
- 不修改 daemon session（daemon 自己 spawn 的）的退出逻辑，仅增强 terminal session
- 不引入新的 WebSocket 消息类型，仅扩展现有 `session_status` 事件的字段
- 不做 Web 端的 session 搜索、过滤、分页功能
- 不做移动端适配
- 不修改 Claude Code CLI 本身的行为

## Decisions

### D1: 状态扩展策略 — 新增而非替换

**选择**: 在现有 6 个状态基础上新增 `exited` 和 `disconnected`，共 8 个状态。

**替代方案**: 复用 `completed` 并增加 `exit_reason` 字段来区分。
**否决原因**: `completed` 是 daemon session 的正常结束语义，terminal session 的退出有本质区别——terminal session 退出后可能被 resume，而 `completed` 暗示终态。新状态让语义更清晰。

### D2: `exited` vs `idle` 的转换规则

**选择**:
- Terminal session 的 Claude 进程退出 → `exited`（不再用 `idle`）
- Terminal session 的 Claude 进程存活且等待输入 → `idle`
- Daemon session 进程退出 → `completed`（不变）
- Daemon session 进程等待输入 → `idle`（不变）

**原因**: `idle` 语义回归为「进程活着，等待输入」。`exited` 明确表示「进程死了，但 session 记录还在」。

### D3: `disconnected` 状态的生命周期

**选择**: `disconnected` 是一个 overlay 状态，不持久化到 DB 的 `status` 字段。

**机制**:
1. Relay 检测到 daemon 断开 → 广播 `session_status: disconnected` 给 Web 客户端（实时）
2. DB 中 session 的 `status` 字段**不变**（保持 `running`/`idle` 等真实状态）
3. Web 客户端在本地维护一个 `effectiveStatus` 计算：如果 daemon 离线 → 显示 `disconnected`；否则显示 DB 中的真实状态
4. Daemon 重连后 relay 广播 `daemon_status: online`，Web 客户端清除 overlay
5. Daemon 重连后上报其 session 的真实状态，relay 更新 DB

**替代方案**: 直接将 DB 状态改为 `disconnected`，daemon 重连后再改回来。
**否决原因**: 引入竞态——daemon 离线期间 session 可能已经 exited，重连后若简单恢复为 `running` 会导致状态不一致。overlay 方式避免了写 DB 的副作用。

### D4: 退出原因的传递机制

**选择**: 在 `session_status` 事件的 `DaemonEvent` 中新增可选字段 `exit_reason`。

**退出原因枚举**:
| exit_reason | 含义 |
|---|---|
| `user_interrupt` | 用户在终端按 Ctrl+C |
| `normal_exit` | Claude Code 自然结束（/exit 命令或任务完成） |
| `process_crash` | 进程异常退出（non-zero exit code） |
| `signal_kill` | 被 SIGKILL/SIGTERM 终止 |
| `unknown` | 无法确定原因 |

**来源**: `ProcessMonitor` 检测到 PID 死亡后，通过检查 `/proc/<pid>/status` 或 exit signal 来推断原因。由于 macOS 不暴露 exit code（PID 消失后无法查询），实际可用的区分有限：
- 如果 session 文件 (`~/.claude/sessions/<pid>.json`) 中 `status` 为 `idle` → `normal_exit`
- 如果 session 文件被删除 → `unknown`
- 如果 daemon 主动 kill → `signal_kill`

### D5: Resume 机制

**选择**: 对 `exited` 状态的 terminal session，Web 端发送 `user_message` 时，daemon 调用 `claude --resume <session_id>` spawn 新进程。

**已有基础**: `session/manager.go` 的 `SendMessage()` 方法已经有 `sendToIdleTerminal()` 逻辑，当进程死亡时会 fallthrough 到 spawn `claude --resume`。需要扩展为：
- 对 `exited` 状态明确支持 resume
- Resume 成功后状态变为 `running`
- 如果 JSONL 文件已被清理，返回错误提示

### D6: 数据库 Schema 变更

**选择**: 在 sessions 表新增两个可选列：
```sql
ALTER TABLE sessions ADD COLUMN last_activity_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN exit_reason VARCHAR(32);
```

**不新增表的 reason**: 现有的 sessions 表直接扩展即可，退出原因和最后活跃时间是一对一关系。

### D7: Web 端状态颜色系统

```
running           → 绿色 (#22C55E) + 脉冲动画
idle              → 黄色 (#EAB308)
waiting_approval  → 橙色 (#F97316)
exited            → 灰色 (#6B7280)
completed         → 灰色 (#9CA3AF) + 勾号图标
disconnected      → 蓝色 (#3B82F6) + 虚线边框
error             → 红色 (#EF4444)
killed            → 红色 (#DC2626) + X 图标
```

### D8: 浏览器通知机制

**选择**: 使用 Web Notifications API，在 session 状态变为 `exited` 时触发。

**策略**:
- 首次使用时请求通知权限
- 仅在用户不在当前 session 详情页时发送通知
- 通知点击后跳转到对应 session 详情页
- 用户可在设置中关闭通知

## Risks / Trade-offs

- **[风险] exit_reason 在 macOS 上精度有限** → macOS 不保留已退出进程的 exit code，只能通过间接证据推断。缓解：对无法确定的情况使用 `unknown`，不猜测。
- **[风险] disconnected overlay 增加前端复杂度** → Web 端需要维护两套状态（DB 状态 + daemon 在线状态）并计算 effectiveStatus。缓解：封装为 composable，暴露单一的 `effectiveStatus` 响应式变量。
- **[风险] Resume 可能因 JSONL 文件被清理而失败** → Claude Code 可能清理旧的 session 文件。缓解：Resume 失败时返回明确错误，Web 端提示「Session 历史已过期，无法恢复」。
- **[权衡] 不持久化 disconnected 到 DB** → 如果 Web 客户端在 daemon 离线期间刷新页面，从 DB 加载的 session 会显示真实状态而非 disconnected。这是可接受的，因为 daemon 离线后 Web 端也会收到 daemon_status 事件，本地状态会很快更新。
- **[风险] 状态扩展的向下兼容性** → 旧版 Web 客户端不认识 `exited`/`disconnected` 状态。缓解：前端对未知状态 fallback 到 `completed` 的显示逻辑。

## Open Questions

1. **Session 自动归档时间**: exited 状态的 session 多久后从列表中隐藏或归档？建议 24 小时，但需要用户确认。
2. **Daemon 重连后的状态同步**: Daemon 重连后是否需要主动上报所有 session 的当前状态，还是等 relay 询问？建议 daemon 在 register 消息中携带 session 列表和状态。
3. **浏览器通知的粒度**: 是否只通知 exited 状态变化，还是包括 error、killed 等所有终态？建议所有终态都通知，但可配置。
