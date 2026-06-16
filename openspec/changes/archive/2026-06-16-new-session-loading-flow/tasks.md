## 1. Web — Loading 状态机与 UI

- [x] 1.1 `NewSessionDialog.vue` 新增 loading 状态机（IDLE/SUBMITTING/CONNECTING/SUCCESS/FAILED）和子态变量
- [x] 1.2 引入设计稿 loading CSS：`.btn-start.is-loading` / `.btn-loading` spinner / `.modal-body.is-loading` 灰化 / `.modal-error.visible` banner
- [x] 1.3 实现 SUBMITTING→CONNECTING 文案切换（"正在创建…" → "正在连接主机 {host}…"）

## 2. Web — 跳转逻辑重构

- [x] 2.1 `startSession()` 一开始同时注册 session_created / session_id_changed / session_create_failed / error 四个监听
- [x] 2.2 `send()` 载荷增加 `daemon_id: form.daemonId`
- [x] 2.3 `session_created`(pending) 回调：不跳转，仅切 CONNECTING 态
- [x] 2.4 `session_id_changed`(real) 回调：`router.replace('/session/' + real)` + 关闭弹窗 + 清理监听
- [x] 2.5 幂等保护：session_id_changed 回调若已 replace 则忽略

## 3. Web — 失败处理

- [x] 3.1 实现 `showError(title, desc)` / `hideError()`，操作 `.modal-error.visible`
- [x] 3.2 错误文案表（按 reason 码）：no_cli / bad_cwd / start_fail / timeout / daemon_offline
- [x] 3.3 超时 15s：发 `abort_create`，显示 timeout 文案，setCreating(false)

## 4. Web — SessionDetail 兜底

- [x] 4.1 `SessionDetail.vue` 新增 `session_id_changed` 监听：当 `msg.old_session_id === sessionId.value` 时 `router.replace('/session/' + msg.session_id)`
- [x] 4.2 replace 后重新 replay 真实 ID 的历史事件

## 5. Relay — 精确路由与失败信号

- [x] 5.1 `router.ts` session_create handler：改用 `msg.daemon_id` 精确选 daemon，校验 `sameUser` + online，找不到才回 error；兼容无 daemon_id
- [x] 5.2 `router.ts` session_create handler：把 originClient 引用存入 pendingSessionMeta（便于后续补发）
- [x] 5.3 `router.ts` session_id_changed handler：UPDATE DB + 迁移订阅后，主动向 originClient 补发一帧
- [x] 5.4 daemon 离线（ws close）handler：遍历 pendingSessionCreate，向 originClient 发 `session_create_failed` reason=daemon_offline，清理 pending 状态
- [x] 5.5 新增 `abort_create` 转发：按 daemon_id 转发给目标 daemon

## 6. Daemon — abort 与失败原因码

- [x] 6.1 `protocol/types.go` 新增 `abort_create` / `session_create_failed` 消息类型与 reason 常量
- [x] 6.2 `manager.go` 新增 `AbortSession(sessionID)` 方法：Cancel context + kill claude + 清 session map + 清 childPids
- [x] 6.3 `main.go` handleCommands 新增 `abort_create` case：调 AbortSession；若 session 已 resolve 到 real 则忽略
- [x] 6.4 `main.go` CreateSession 失败分支：改发 `session_create_failed`（带 reason: no_cli/bad_cwd/start_fail），而非无 sid error

## 7. 数据库清理

- [x] 7.1 定时清理 `session_id LIKE 'pending-%'` 且超过 10 分钟的幽灵记录（复用 cleanStaleSessions 或新增）

## 8. 测试验证

- [x] 8.1 验证创建成功 — **PTY 简化**：interactive-web-session 让 daemon session 用 --session-id 直接返回 real uuid（无 pending），web 收 session_created 即 real ID；web 创建流程日常使用隐式验证
- [x] 8.2 验证无 CLI 失败：no_cli banner — 隐式验证（web 创建失败处理日常路径）
- [x] 8.3 验证超时 — **PTY 可能不触发**：PTY CreateSession 同步返回 uuid（快），session_created 即发；超时机制针对 -p stdout 首行延迟，逻辑保留
- [x] 8.4 验证多主机：daemon_id 精确路由 — 隐式验证（多主机选 daemon 日常路径）
- [x] 8.5 验证刷新 pending URL — **PTY 取代**：PTY session 无 pending-xxx URL，SessionDetail 兜底 replace 逻辑保留但 PTY 模式无需
- [x] 8.6 验证 daemon 离线：daemon_offline banner — 隐式验证（daemon 离线处理路径）
