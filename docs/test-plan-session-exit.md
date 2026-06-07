# Session 退出状态增强 — 测试方案

## 1. 测试范围

本次变更涉及 4 层架构，新增/修改 16 个文件。测试按层级从底向上组织：

| 层 | 变更点 | 测试类型 |
|---|---|---|
| Protocol | 新增 `exited`/`disconnected` 状态 + `exit_reason`/`last_activity_at` 字段 | Go 单元测试 |
| Daemon | `SetSessionExited`、退出原因推断、Resume、`last_activity_at` 生成 | Go 单元测试 + E2E |
| Relay | DB 迁移、daemon 断开广播、`list_sessions` 扩展字段、`exit_reason` 持久化 | 集成测试 (Node.js) |
| Web | 8 种状态颜色、退出 banner、Resume 按钮、Daemon 离线横幅、时间线、通知 | 单元测试 (Vitest) + 手动验证 |

---

## 2. Go 单元测试

### 2.1 Protocol 常量 (`internal/protocol/types.go`)

**文件**: `internal/protocol/types_test.go`（新建）

```
TestStatusConstants
  - 验证 StatusExited == "exited"
  - 验证 StatusDisconnected == "disconnected"
  - 验证 8 个状态常量不重复

TestExitReasonConstants
  - 验证 5 个 exit_reason 枚举值正确
  - 验证枚举值不重复

TestDaemonEvent_NewFields
  - 构造 DaemonEvent 并 JSON 序列化
  - 验证 exit_reason 为空时不输出该字段 (omitempty)
  - 验证 last_activity_at 为空时不输出该字段
  - 验证两个字段有值时正确序列化
```

### 2.2 Session Manager (`internal/session/manager.go`)

**文件**: `internal/session/manager_test.go`（已有，需扩展）

```
TestSetSessionExited                    [已有 ✅]
TestSetSessionExitedWithDifferentReasons [已有 ✅]
TestSetSessionExitedNonexistent         [已有 ✅]
TestSetSessionStatusIncludesLastActivityAt [已有 ✅]

--- 新增 ---

TestSetSessionExited_StatusTransition
  - 注册 terminal session (status=running)
  - 调用 SetSessionExited("sid", "normal_exit")
  - 验证 ps.Status == "exited" (不是 "idle")
  - 验证 ps.ExitReason == "normal_exit"
  - 验证事件包含 last_activity_at (ISO 8601 格式)

TestSetSessionExited_DoesNotAffectDaemonSessions
  - 创建 daemon session (source="daemon")
  - 对该 session 调用 SetSessionExited
  - 验证状态确实改变了（daemon session 也会被标记）
  - 但实际场景中 daemon session 走 readOutput 路径，不走此方法

TestSendMessage_ExitedSession_TriggersResume
  - 注册 terminal session (status=exited, pid=已死进程)
  - 调用 SendMessage(ctx, sid, "hello")
  - 验证不返回 "session busy" 错误
  - 验证触发了 claude --resume 进程

TestSendMessage_ExitedSession_NoError
  - 注册 terminal session (status=exited, pid=已死进程)
  - 验证 SendMessage 不返回 "session not found"

TestKillSession_SetsSignalKill
  - 创建 daemon session
  - 调用 KillSession
  - 验证最终状态为 killed
  - 验证 readOutput 中的退出处理
```

### 2.3 Watcher Process Monitor (`internal/watcher/process.go`)

**文件**: `internal/watcher/process_test.go`（已有，需扩展）

```
TestProcessMonitorDetectsExit      [已有 ✅]
TestProcessMonitorDetectsDeadProcess [已有 ✅]
TestIsProcessAlive                 [已有 ✅]
TestProcessMonitorUnregister       [已有 ✅]

--- 新增 ---

TestProcessMonitor_MultiplePIDs
  - 注册多个 PID（一个存活一个死亡，初始状态都设为 alive）
  - 只收到死亡 PID 的 change 事件
  - 存活 PID 不产生事件

TestProcessMonitor_NoDuplicateEvents
  - 注册一个死亡 PID
  - 等待两个 checkAll 周期
  - 验证只收到一次 change 事件（不会重复通知）
```

### 2.4 退出原因推断 (`internal/session/manager.go`)

**文件**: `internal/session/manager_test.go`（扩展）

```
TestExitReasonInference_SessionFileIdle
  - 模拟场景：session 文件中 status="idle"，PID 已死
  - 期望推断为 normal_exit
  - 注：此逻辑在 main.go 中实现，需考虑是否将推断函数抽取到 session 包

TestExitReasonInference_SessionFileRemoved
  - 模拟场景：session 文件被删除
  - 期望推断为 unknown

TestExitReasonInference_DaemonKill
  - 模拟场景：daemon 主动 KillSession
  - 期望 exit_reason 为 signal_kill
```

### 2.5 E2E 集成测试 (`internal/e2e/e2e_test.go`)

**文件**: `internal/e2e/e2e_test.go`（已有，需扩展）

```
TestTerminalSession_ExitedStatus
  1. 启动 mockRelay + daemon
  2. 通过 watcher 发现一个 terminal session
  3. 模拟 PID 死亡（ProcessMonitor 检测）
  4. 验证 relay 收到 session_status 事件，status=exited
  5. 验证事件包含 exit_reason 字段

TestTerminalSession_ExitedThenResumed
  1. 终端 session 进入 exited 状态
  2. 通过 relay 发送 user_message
  3. daemon 启动 --resume 进程
  4. 验证状态从 exited → running
  5. resume 进程结束后验证状态回到 idle

TestDaemonDisconnect_BroadcastsDisconnected
  1. 启动 mockRelay
  2. daemon 连接并注册
  3. 创建 session
  4. 连接 client 并订阅 session
  5. 断开 daemon WebSocket
  6. 验证 client 收到 daemon_status: offline
  7. 验证 client 收到 session_status: disconnected

TestDaemonReconnect_UpdatesStatus
  1. 在 TestDaemonDisconnect_BroadcastsDisconnected 基础上
  2. daemon 重新连接并注册
  3. 验证 client 收到 daemon_status: online（含 hostname）
  4. daemon 发送实际 session_status
  5. 验证 client 更新为真实状态
```

---

## 3. Relay 集成测试

### 3.1 Router 测试 (`relay/src/router.test.ts`)

**文件**: `relay/src/router.test.ts`（新建）

使用 Vitest + mock WebSocket：

```
describe('Router - daemon disconnect')
  test('unregisterDaemon broadcasts session_status: disconnected to subscribed clients')
    1. 创建 Router + mock pool
    2. 注册 daemon + client
    3. daemon 创建 session_discovered
    4. client 订阅该 session（通过 replay）
    5. 调用 unregisterDaemon(daemonId)
    6. 验证 client ws.send 被调用，参数包含 { status: 'disconnected' }
    7. 验证 DB status 未被更新为 disconnected

  test('unregisterDaemon broadcasts daemon_status: offline with hostname')
    1. 注册 daemon (hostname: "test-host")
    2. 注册 client
    3. 调用 unregisterDaemon
    4. 验证 client 收到 { type: 'daemon_status', status: 'offline', hostname: 'test-host' }

describe('Router - daemon reconnect')
  test('registerDaemon broadcasts daemon_status: online')
    1. 注册 daemon
    2. 连接 client
    3. 验证 client 收到 { type: 'daemon_status', status: 'online', hostname, agents }

describe('Router - session_status with exit_reason')
  test('exit_reason persisted to DB')
    1. daemon 发送 { type: 'session_status', status: 'exited', exit_reason: 'user_interrupt' }
    2. 验证 pool.query 被调用且参数包含 exit_reason

  test('exit_reason=null does not overwrite existing reason')
    1. 先设置 exit_reason = 'normal_exit'
    2. 再发送 session_status (status: 'running', 无 exit_reason)
    3. 验证 DB 中 exit_reason 仍为 'normal_exit' (COALESCE 行为)

describe('Router - list_sessions extended fields')
  test('includes last_activity_at, exit_reason, daemon_online')
    1. 模拟 DB 返回带新字段的 session 行
    2. 调用 handleListSessions
    3. 验证响应包含 daemon_online 字段

describe('Router - event insertion updates last_activity_at')
  test('insertEvent updates session last_activity_at')
    1. 验证 insertEvent 后 pool.query 被调用更新 last_activity_at
```

### 3.2 DB 测试 (`relay/src/db.test.ts`)

**文件**: `relay/src/db.test.ts`（新建）

使用真实 PostgreSQL (Docker)：

```
describe('DB migration')
  test('last_activity_at column exists after initDB')
  test('exit_reason column exists after initDB')

describe('upsertSession')
  test('stores exit_reason when provided')
  test('preserves exit_reason when COALESCE on null update')

describe('listSessions')
  test('returns daemon_online derived from daemons table')
  test('sorted by last_activity_at DESC')

describe('insertEvent')
  test('updates last_activity_at on event insert')
```

---

## 4. Web 前端测试

### 4.1 Composables 单元测试

#### `useWebSocket.ts`

**文件**: `web/src/composables/__tests__/useWebSocket.test.ts`（新建）

```
describe('daemonOnlineMap')
  test('initial state: all daemons unknown')
  test('daemon_status: online → daemons map updated')
  test('daemon_status: offline → daemons map updated with last_seen_at')

describe('effectiveStatus')
  test('returns real status when daemon is online')
  test('returns "disconnected" when daemon is offline')
  test('returns real status when daemon_id is undefined')

describe('isDaemonOnline')
  test('returns true for online daemon')
  test('returns false for offline daemon')
  test('returns false for unknown daemon')
```

#### `useRelativeTime.ts`

**文件**: `web/src/composables/__tests__/useRelativeTime.test.ts`（新建）

```
describe('formatRelativeTime')
  test('< 1min → "刚刚"')
  test('1min → "1分钟前"')
  test('59min → "59分钟前"')
  test('1h → "1小时前"')
  test('23h → "23小时前"')
  test('25h → "MM-DD HH:mm" 格式')
  test('null/undefined → ""')
  test('invalid date → ""')
```

#### `useNotifications.ts`

**文件**: `web/src/composables/__tests__/useNotifications.test.ts`（新建）

```
describe('requestPermission')
  test('calls Notification.requestPermission once')
  test('does not call again if already requested')

describe('notifySessionStateChange')
  test('sends notification for exited status')
  test('sends notification for error status')
  test('sends notification for killed status')
  test('does NOT send for running status')
  test('does NOT send for idle status')
  test('does NOT send if currentRouteSessionId matches (user viewing page)')
  test('notification tag includes session_id')
  test('notification onclick navigates to session page')
```

### 4.2 Vue 组件测试

#### `SessionList.vue`

**文件**: `web/src/views/__tests__/SessionList.test.ts`（新建）

```
describe('status indicator colors')
  test('running → green with pulse')
  test('idle → yellow')
  test('exited → gray')
  test('disconnected → blue dashed border')
  test('error → red')

describe('exit_reason label')
  test('user_interrupt → "用户中断"')
  test('normal_exit → "正常退出"')
  test('unknown → "已退出"')

describe('relative time display')
  test('shows "刚刚" for very recent activity')
  test('shows "5分钟前" for 5 minutes ago')

describe('sorting')
  test('sessions sorted by last_activity_at descending')

describe('disconnected overlay')
  test('shows disconnected when daemon is offline')
  test('shows real status when daemon is online')
```

#### `SessionDetail.vue`

**文件**: `web/src/views/__tests__/SessionDetail.test.ts`（新建）

```
describe('exit banner')
  test('shows "Session 已退出" when status=exited')
  test('shows exit reason in banner')
  test('shows relative time in banner')

describe('Resume button')
  test('visible when status=exited AND daemon online')
  test('hidden when status=exited AND daemon offline')
  test('clicking focuses input')

describe('disconnected banner')
  test('shows when daemon is offline')
  test('disables message input')

describe('terminal state badges')
  test('exited+online → "可恢复" blue badge')
  test('completed → "只读" gray badge')
  test('error → "异常退出" red badge')
  test('killed → "已终止" red badge')

describe('input area visibility')
  test('running → input visible')
  test('completed → "Session 已结束" text')
  test('exited+online → input visible (for resume)')
  test('exited+offline → "Session 已结束" text')

describe('timeline milestones')
  test('shows milestones for status changes')
  test('latest milestone is highlighted')
  test('ignores disconnected status in milestones')
```

#### `ConnectionBanner.vue`

**文件**: `web/src/components/__tests__/ConnectionBanner.test.ts`（新建）

```
describe('relay connection')
  test('shows "Connected" when relay connected')
  test('shows "Reconnecting..." when relay disconnected')

describe('daemon offline banner')
  test('shows offline banner when daemon goes offline')
  test('shows hostname in banner')
  test('shows aggregate "N 个 Daemons 离线" for multiple offline')
  test('expands to show individual daemons')
  test('removes banner when daemon reconnects')
```

#### `SessionTimeline.vue`

**文件**: `web/src/components/__tests__/SessionTimeline.test.ts`（新建）

```
describe('rendering')
  test('renders milestones in order')
  test('last milestone is active (green)')
  test('previous milestones are passed (gray)')
  test('does not render when milestones empty')

describe('status labels')
  test('running → "Running"')
  test('exited → "Exited"')
  test('unknown status → passthrough')
```

---

## 5. 端到端测试 (`test-session-bridge.js`)

**文件**: `test-session-bridge.js`（已有，需扩展）

### 新增测试组

```
--- 11. DB Schema: last_activity_at & exit_reason ---       [已有 ✅ T28-T29]
--- 12. Session Status Constants ---                         [已有 ✅ T30-T33]
--- 13. Daemon Status Broadcast with Hostname ---            [已有 ✅ T34-T35]

--- 新增 ---

--- 14. Session Exited Status E2E ---
  T36: Terminal session exits → status becomes "exited" in list_sessions
    1. 等待当前 terminal session 的 Claude 进程退出
    2. 调用 list_sessions
    3. 验证该 session status == "exited"

  T37: Exit reason in list_sessions
    4. 验证 exit_reason 字段存在
    5. 验证 exit_reason 是有效枚举值

  T38: Exit reason persisted in DB
    6. 直接查询 DB
    7. 验证 exit_reason 列有值

--- 15. Daemon Disconnect E2E ---
  T39: Second client sees disconnected when daemon restarts
    1. 连接两个 client
    2. 停止 daemon
    3. 验证两个 client 都收到 daemon_status: offline
    4. 验证订阅了 session 的 client 收到 session_status: disconnected

  T40: Daemon reconnect clears disconnected
    5. 重启 daemon
    6. 验证 client 收到 daemon_status: online
    7. 调用 list_sessions，验证 session 状态不是 disconnected

--- 16. Resume from Exited ---
  T41: Send message to exited session → status changes to running
    1. 找到 status=exited 的 terminal session
    2. 发送 user_message
    3. 验证收到 session_status: running
    4. 等待 resume 完成
    5. 验证最终状态为 idle 或 completed

  T42: Resume failed (session data expired)
    1. 模拟 session JSONL 文件被删除（如果可能）
    2. 发送 user_message
    3. 验证收到 error 事件

--- 17. last_activity_at Tracking ---
  T43: last_activity_at updates on new events
    1. 记录 session 的 last_activity_at 初始值
    2. 发送消息触发新事件
    3. 等待事件
    4. 查询 list_sessions
    5. 验证 last_activity_at 更新了

  T44: DB last_activity_at column updates
    6. 直接查询 DB
    7. 验证 last_activity_at 比之前更新
```

---

## 6. 手动验证清单

以下场景需要人工在浏览器中验证：

### 6.1 Session 列表状态颜色

| # | 操作 | 预期 |
|---|---|---|
| M1 | 打开 http://localhost:3000 | 看到 session 列表 |
| M2 | 观察 running session | 绿色圆点 + 脉冲动画 |
| M3 | 观察 idle session | 黄色圆点 |
| M4 | 等待 terminal session 退出 | 状态变为灰色 + 显示 "正常退出" |
| M5 | 观察 relative time | 显示 "刚刚" / "X分钟前" |

### 6.2 Daemon 离线横幅

| # | 操作 | 预期 |
|---|---|---|
| M6 | 停止 daemon (`pocketctl daemon stop`) | 顶部出现黄色横幅: "⚠️ Daemon "xxx" 离线" |
| M7 | 刷新页面 | session 列表正常显示，横幅消失（重连后恢复） |
| M8 | 重启 daemon | 横幅自动消失 |

### 6.3 Session Detail 退出 Banner

| # | 操作 | 预期 |
|---|---|---|
| M9 | 点击 exited 的 session | 显示蓝色退出 banner: "Session 已退出" + exit_reason |
| M10 | 观察 Resume 按钮 | 绿色 "Resume Session" 按钮 |
| M11 | 点击 Resume + 输入消息 | 状态切换为 running，banner 消失 |
| M12 | daemon 离线时观察 | Resume 按钮变灰，显示 "Daemon 离线" |

### 6.4 生命周期时间线

| # | 操作 | 预期 |
|---|---|---|
| M13 | 观察 session detail 底部 | 显示 timeline: created → running → idle → exited |
| M14 | 当前状态高亮 | 最后一个里程碑绿色发光 |
| M15 | Resume 后 | timeline 新增 running 里程碑 |

### 6.5 浏览器通知

| # | 操作 | 预期 |
|---|---|---|
| M16 | 首次访问 | 浏览器请求通知权限 |
| M17 | 离开 session 页面，等待退出 | 收到桌面通知: "Session xxx 已退出" |
| M18 | 点击通知 | 跳转到该 session 详情页 |
| M19 | 在 session 页面上等待退出 | 不收到通知（已在页面上） |

---

## 7. 测试执行命令

```bash
# Go 单元测试
go test ./internal/protocol/ -v
go test ./internal/session/ -v
go test ./internal/watcher/ -v

# Go E2E 测试（需要 mockRelay，不需要外部依赖）
go test ./internal/e2e/ -v -timeout 120s

# Relay 单元测试（新增，需要先安装 vitest）
cd relay && npx vitest run

# Web 前端测试（新增，需要先安装 vitest）
cd web && npx vitest run

# 端到端集成测试（需要完整环境：PostgreSQL + Relay + Daemon + Web）
# 前置：docker compose up -d postgres && 启动 relay + daemon + web
node test-session-bridge.js
```

---

## 8. 测试矩阵

| 测试场景 | Go 单元 | Go E2E | Relay 单元 | Web 单元 | 集成测试 | 手动 |
|---|---|---|---|---|---|---|
| 新状态常量 `exited`/`disconnected` | ✅ | | | | | |
| `DaemonEvent` 新字段序列化 | ✅ | | | | | |
| `SetSessionExited` 状态+原因 | ✅ | ✅ | | | ✅ | |
| 退出原因推断 | ✅ | | | | | |
| Resume exited session | | ✅ | | | ✅ | |
| DB 迁移 (新列) | | | ✅ | | ✅ | |
| `exit_reason` 持久化 | | | ✅ | | ✅ | |
| `list_sessions` 新字段 | | | ✅ | | ✅ | |
| `last_activity_at` 自动更新 | | | ✅ | | ✅ | |
| Daemon 断开广播 disconnected | | ✅ | ✅ | | ✅ | |
| Daemon 重连广播 online | | ✅ | ✅ | | ✅ | |
| 8 种状态颜色/图标 | | | | ✅ | | ✅ |
| Exit reason 中文标签 | | | | ✅ | | |
| 相对时间格式化 | | | | ✅ | | ✅ |
| 退出 banner + Resume 按钮 | | | | ✅ | | ✅ |
| Daemon 离线横幅 | | | | ✅ | | ✅ |
| 生命周期时间线 | | | | ✅ | | ✅ |
| 浏览器通知 | | | | ✅ | | ✅ |
| 只读/可恢复 badge | | | | ✅ | | ✅ |
| Disconnected overlay (前端) | | | | ✅ | | ✅ |
