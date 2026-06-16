## Context

pocketctl 当前架构：Daemon (Go) 运行在 Mac 上管理 Claude CLI 子进程，Relay (TypeScript/Fastify) 作为消息路由器 + PostgreSQL 持久化，Web (Vue 3) 前端通过 WebSocket 与 Relay 通信。

现有问题：
1. nginx 代理 WebSocket 到 Relay 返回 502（已绕过：前端直连 relay:8080）
2. 前端 session 列表是纯内存状态，刷新丢失（已部分修复：list_sessions API）
3. SessionDetail 页面不加载历史（replay API 存在但前端未调用）
4. 移动端无适配
5. Session ID 从 pending-* 变更为真实 UUID 的通知链路不完整（已部分修复）

## Goals / Non-Goals

**Goals:**
- 手机浏览器能稳定连接 relay，查看 Mac 上所有 session
- 点进 session 能看到完整对话历史（replay）
- 能发送新消息继续对话，实时看到 agent 响应
- UI 在手机上可用（响应式布局）

**Non-Goals:**
- 审批/权限请求流程（当前 acceptEdits 自动批准）
- Diff 查看器
- 推送通知
- 多 agent 并行 worktree
- 原生 iOS/Android app（先用 web）
- nginx WebSocket 代理修复（已用直连方案绕过）

## Decisions

### D1: 前端 WebSocket 直连 Relay，不走 nginx 代理

**选择**: 浏览器 WebSocket 连 `ws://<host>:8080/ws` 直连 relay

**替代方案**: 修 nginx WebSocket 代理（`@fastify/websocket` v11 + nginx 兼容性问题，排查成本高）

**理由**: 直连方案零额外配置、延迟更低、减少一层代理。生产环境可通过同一域名反代或 CORS 处理。

**实现**: `index.html` 注入 `window.__RELAY_WS__`，前端读取该变量构建 WebSocket URL。

### D2: Session 历史通过 Relay replay API 加载

**选择**: SessionDetail 挂载时调用 `{ type: "replay", session_id, last_seq: 0 }` 获取全部历史事件

**替代方案**: 新增 REST API `/api/sessions/:id/events`

**理由**: replay API 已实现，走 WebSocket 通道不需要额外端点或 CORS 配置。

### D3: 移动端适配用 CSS media query + viewport meta

**选择**: 纯 CSS 响应式，不引入 UI 框架

**替代方案**: 引入 Tailwind / Vuetify / Ionic

**理由**: 当前 UI 代码量小（~5 个组件），引入框架增加构建体积和复杂度不值得。media query 足够覆盖手机屏幕。

### D4: Session 持久化由 Relay 在收到 daemon 事件时写入

**选择**: Relay 收到 `session_created` 时 INSERT sessions 行，收到 `session_status` 时 UPDATE 状态，收到 `session_id_changed` 时 UPDATE session_id

**替代方案**: Daemon 负责持久化

**理由**: Relay 是唯一与数据库通信的组件，保持单一数据写入入口。

## Risks / Trade-offs

- **[直连 relay 暴露 8080 端口]** → 开发环境可接受，生产环境需加认证/API key 验证
- **[replay 事件量大时性能]** → 大 session 可能有数千事件，前端需分批渲染或虚拟滚动。Phase 1 先全量加载，后续优化
- **[移动端纯 CSS 适配可能不够精细]** → 够用即可，后续可引入 UI 框架
- **[Daemon 需要重新编译]** → session_id_changed 改动涉及 Go 代码，需 `go build` 重新编译
