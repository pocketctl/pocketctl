## Context

新建会话的真实 session_id 由 claude 子进程的 stdout 产出，Daemon 无法在 `CreateSession` 时同步获得。当前流程：

```
Web send(session_create)
  → Relay 选"第一个同用户在线 daemon"转发
  → Daemon CreateSession() 立即返回 pending-<UnixNano>
  → Daemon 发 session_created(pending)
  → Web 收到 session_created 立即 router.push('/session/pending-xxx')  ← 问题根源
  → (异步) claude 吐出真实 ID → readOutput 发 session_id_changed
  → Relay UPDATE DB pending→real，但 Web 已不监听，URL 永远卡在 pending-xxx
```

约束：
- Daemon 命令处理是**单 goroutine 顺序消费**（`handleCommands` 的 `for{select}`），阻塞会卡死所有命令 + 心跳
- claude 首行延迟不可控（token 刷新、首 token 延迟、OAuth），10-15s 超时是赌博
- 系统**已经在产生** `session_id_changed` 事件，只是 Web 没消费

## Goals / Non-Goals

**Goals:**
- 还原设计稿 loading（SUBMITTING→CONNECTING）和失败 banner 体验
- 创建后跳转 URL 用真实 session_id，不再卡 pending
- 修复 daemon_id 不透传、超时不清理两个前置 bug
- 不阻塞 Daemon 主循环

**Non-Goals:**
- 不改 session_create 为同步阻塞接口（架构冲突）
- 不改会话创建成功后的对话流程（仅创建阶段）
- 不实现 Codex 创建（仍 "即将开通"）

## Decisions

### Decision 1: 异步事件方案，不做同步阻塞

复用已有 `session_id_changed` 事件。前端不在 `session_created`(pending) 跳转，而是切到 CONNECTING 态，等 `session_id_changed`(real) 才 `router.replace`。

**否决方案 A（同步阻塞）**：CreateSession 阻塞等真实 ID 会卡死 daemon 主循环（单 goroutine 顺序处理），且 claude 首行延迟不可控，10-15s 超时会误杀正常慢启动的 Agent。

### Decision 2: session_created 作为"进程已拉起"确认信号

保留 Daemon 在 `CreateSession` 后立即发 `session_created(pending)`。它不再是"跳转信号"，而是"主机已接收、Agent 进程已启动"的确认，用于前端把 loading 文案从"正在创建…"切到"正在连接主机…"。这样有两段 loading 反馈，对齐设计稿。

### Decision 3: send() 带 daemon_id，Relay 精确路由

`session_create` 载荷必须带 `daemon_id`。Relay 用它精确选 daemon（校验 `sameUser(daemon.userId, client.userId)` 且 online），而非"第一个同用户在线 daemon"。修复多主机用户创建到错误机器的 bug。

### Decision 4: 超时发 abort_create 清理

前端 15s 超时后发 `{type:'abort_create', daemon_id}`。Relay 转发给目标 daemon，Daemon 调 `sm.AbortSession(pendingID)` → `ps.Cancel()` + kill claude 子进程 + 清理 session map。修复超时后 claude 继续烧 token 的泄漏。

### Decision 5: 失败用带原因码的 session_create_failed

Daemon 启动失败（无 CLI / cwd 无效 / Start 失败）改发 `session_create_failed`（带 `reason: no_cli|bad_cwd|start_fail`），而非无 sid 的通用 error。前端按码查文案表，避免与会话内 error 混淆。daemon 中途离线由 Relay 发 `session_create_failed`（reason: `daemon_offline`）。

## Risks / Trade-offs

- **[session_id_changed 在 router.replace 前到达的竞态]** → 缓解：`startSession()` 一开始就同时注册 session_created / session_id_changed / error 三个监听；session_id_changed 回调做幂等（已 replace 则忽略）。
- **[claude 永不输出 session_id]**（鉴权失败/配额耗尽）→ 缓解：前端 CONNECTING 态也监听 session_status 为 error 时转 FAILED，不只靠超时。
- **[pending-xxx 进 DB 幽灵记录]**（session_id_changed 丢失）→ 缓解：定时清理 `session_id LIKE 'pending-%'` 超过 N 分钟的记录。
- **[daemon_id 透传的鉴权]** → Relay 必须校验 daemon 属于当前 userId，否则用户可指定他人 daemon。
- **[abort 与 real 竞态]** → Daemon 收 abort 时若 session 已 resolve 到 real，则忽略 abort（会话已成功），由事件到达顺序决定前端结果。

## Migration Plan

无破坏性变更。新消息类型（abort_create / session_create_failed）由前端驱动，旧客户端不发则不触发。daemon_id 字段缺失时 Relay 回退到"第一个同用户在线 daemon"（兼容）。
