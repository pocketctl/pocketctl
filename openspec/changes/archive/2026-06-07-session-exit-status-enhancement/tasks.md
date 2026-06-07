## 1. Protocol & State Constants (P0)

- [x] 1.1 在 `internal/protocol/types.go` 中新增状态常量 `StatusExited = "exited"` 和 `StatusDisconnected = "disconnected"`
- [x] 1.2 在 `DaemonEvent` 结构体中新增可选字段 `ExitReason string` 和 `LastActivityAt string`
- [x] 1.3 在 `session/manager.go` 的 `ProcessState` 中新增 `ExitReason string` 字段
- [x] 1.4 新增 exit_reason 枚举常量：`ExitReasonUserInterrupt`, `ExitReasonNormalExit`, `ExitReasonProcessCrash`, `ExitReasonSignalKill`, `ExitReasonUnknown`

## 2. Session Manager 退出逻辑改造 (P0)

- [x] 2.1 重构 `SetSessionIdle()` 为 `SetSessionExited(sid string, exitReason string)`，终端进程退出时调用新方法
- [x] 2.2 修改 `ProcessMonitor.checkAll()` 中 PID 死亡回调，从 `SetSessionIdle` 改为 `SetSessionExited` 并推断退出原因
- [x] 2.3 实现退出原因推断逻辑：检查 session 文件状态判断 `normal_exit` vs `unknown`，daemon 主动 kill 记录为 `signal_kill`
- [x] 2.4 修改 `watcher.go` 的 `removed` event 处理，从 `SetSessionIdle` 改为 `SetSessionExited(sessionID, "unknown")`
- [x] 2.5 确保 `session_status` 事件携带 `exit_reason` 和 `last_activity_at` 字段

## 3. Relay 端 Daemon 断开处理 (P0)

- [x] 3.1 修改 `relay/src/db.ts` sessions 表 schema，新增 `last_activity_at TIMESTAMPTZ` 和 `exit_reason VARCHAR(32)` 列（nullable，启动时自动迁移）
- [x] 3.2 修改 `router.ts` 的 `unregisterDaemon()` 方法，遍历该 daemon 的所有 session，广播 `session_status: "disconnected"` 给订阅客户端（不写入 DB）
- [x] 3.3 修改 `router.ts` 的 daemon 重连逻辑，广播 `daemon_status: "online"` 时附带 daemon 信息（hostname, daemon_id）
- [x] 3.4 修改事件插入逻辑，每次插入 event 时更新对应 session 的 `last_activity_at`
- [x] 3.5 修改 `list_sessions` 响应，包含 `last_activity_at`、`exit_reason`、`daemon_online` 字段，按 `last_activity_at` 降序排列

## 4. Web 前端状态系统 (P0)

- [x] 4.1 在 `useWebSocket.ts` 中新增 `daemonOnlineMap` reactive Map（key: daemon_id, value: boolean）和 `effectiveStatus(session)` 计算函数
- [x] 4.2 处理 `daemon_status` 事件：收到 `offline` 时更新 `daemonOnlineMap` 并标记相关 session 为 disconnected；收到 `online` 时清除
- [x] 4.3 处理 `session_status` 事件中的新状态 `exited`、`disconnected`，更新 session 列表和详情
- [x] 4.4 新增 `useRelativeTime` composable，将 ISO 时间戳转为相对时间字符串（刚刚/X分钟前/X小时前/MM-DD HH:mm）

## 5. Session 列表状态指示器增强 (P0)

- [x] 5.1 重构 `SessionList.vue` 状态指示器，支持 8 种状态的颜色和图标：running(绿+脉冲), idle(黄), waiting_approval(橙), exited(灰), completed(灰+勾), disconnected(蓝+虚线), error(红), killed(红+X)
- [x] 5.2 显示 `exit_reason` 文案：user_interrupt→"用户中断", normal_exit→"正常退出", process_crash→"异常退出", signal_kill→"被终止", unknown→"已退出"
- [x] 5.3 显示 `last_activity_at` 相对时间，列表按此字段降序排列

## 6. Daemon 离线横幅 (P0)

- [x] 6.1 增强 `ConnectionBanner.vue`，监听 `daemon_status` 事件，当任一 daemon 离线时显示持久横幅
- [x] 6.2 横幅显示：daemon hostname + "离线" + 离线持续时间（相对时间）
- [x] 6.3 支持多 daemon 离线时的聚合显示："N 个 Daemons 离线"
- [x] 6.4 daemon 重连后自动移除对应横幅

## 7. Session Detail 退出 Banner + Resume (P1)

- [x] 7.1 在 `SessionDetail.vue` 中新增退出 banner 组件：当 session 状态为 `exited` 时显示 "Session 已退出" + exit_reason + 退出时间
- [x] 7.2 新增 "Resume Session" 按钮：点击后聚焦消息输入框，用户输入消息后发送 `user_message`
- [x] 7.3 Resume 成功时移除退出 banner，状态切换为 `running`，恢复正常流式 UI
- [x] 7.4 Resume 失败时显示错误提示："Session 历史已过期，无法恢复"
- [x] 7.5 daemon 离线时隐藏/禁用 Resume 按钮，tooltip 显示 "需要 Daemon 在线才能恢复"

## 8. Session 只读/归档标识 (P1)

- [x] 8.1 终态 session 显示状态 badge：`exited`+daemon在线→"可恢复"(蓝色), `completed`→"只读"(灰色), `error`→"异常退出"(红色), `killed`→"已终止"(红色)
- [x] 8.2 只读 session 隐藏消息输入框，替换为 "Session 已结束" 文案
- [x] 8.3 "可恢复" session 保留消息输入框用于 resume

## 9. 时间戳信息增强 (P1)

- [x] 9.1 Session 列表中每条 session 显示 `last_activity_at` 相对时间
- [x] 9.2 Session Detail 顶部显示创建时间和最后活跃时间
- [x] 9.3 退出 banner 中显示退出时间的相对时间（"3分钟前退出"）

## 10. Session 生命周期时间线 (P2)

- [x] 10.1 新增 `SessionTimeline.vue` 组件，渲染 session 的生命周期里程碑
- [x] 10.2 从 session events 中提取状态变更事件，构建 timeline 数据
- [x] 10.3 每个里程碑显示状态名称和时间戳，当前状态高亮
- [x] 10.4 状态变更时实时更新 timeline（动画过渡）

## 11. 浏览器通知 (P2)

- [x] 11.1 新增 `useNotifications` composable，封装 Web Notifications API 权限请求和通知发送
- [x] 11.2 首次访问时请求通知权限，提示文案："允许通知以在 Session 结束时收到提醒"
- [x] 11.3 Session 转为终态（exited/error/killed）且用户不在该 session 页面时，发送浏览器通知
- [x] 11.4 通知点击跳转到对应 session 详情页
- [x] 11.5 用户拒绝权限后不再重复请求

## 12. 测试

- [x] 12.1 补充 `session/manager.go` 单元测试：验证 `SetSessionExited` 设置 exited 状态和 exit_reason
- [x] 12.2 补充 `watcher/process.go` 单元测试：验证退出原因推断逻辑
- [x] 12.3 补充 `router.ts` 测试：验证 daemon 断开时广播 disconnected、重连时恢复
- [x] 12.4 补充前端组件测试：验证状态颜色映射、effectiveStatus 计算、相对时间格式化
- [x] 12.5 更新 `test-session-bridge.js` 集成测试：验证 exited 状态和 exit_reason 的端到端传递
