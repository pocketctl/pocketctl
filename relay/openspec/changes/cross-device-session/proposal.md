## Why

用户希望在手机/平板上继续 Mac 上正在进行的 coding agent session。当前 pocketctl 已有 session 列表和消息发送能力，但 WebSocket 连接不稳定、前端无法回放对话历史、缺少移动端适配，导致跨设备体验不可用。

## What Changes

- 修复 WebSocket 连接稳定性（前端直连 relay 绕过 nginx WebSocket 代理问题）
- SessionDetail 页面加载时通过 relay replay API 恢复完整对话历史
- 对话历史渲染：agent 文本流、工具调用（文件读/写/命令执行）结构化展示
- 移动端响应式布局（手机浏览器友好）
- Session 创建流程优化：默认工作目录、错误提示
- Session ID 变更通知（pending → 真实 UUID）贯穿 daemon → relay → 前端全链路

## Capabilities

### New Capabilities
- `session-history-replay`: 前端通过 relay replay API 加载并渲染 session 的完整对话历史
- `mobile-responsive`: 移动端响应式布局，手机浏览器上可正常使用所有功能

### Modified Capabilities
- `relay-routing`: 新增 `list_sessions` 命令、`session_id_changed` 事件处理、session 持久化到数据库、error 事件路由到 pending client
- `web-ui`: 直连 relay WebSocket URL、session 列表从数据库恢复、错误提示展示、session 创建优化

## Impact

- **Relay (TypeScript)**: router.ts 新增 list_sessions、session_id_changed 处理；db.ts 新增 listSessions、upsertSession 函数
- **Web (Vue 3)**: useWebSocket 连接逻辑修改；SessionList 增加 session 恢复和错误提示；SessionDetail 增加 replay 渲染；全局响应式样式
- **Daemon (Go)**: session/manager.go 发送 session_id_changed 事件；protocol/types.go 新增 OldSessionID 字段
- **数据库**: sessions 表由 relay 在 session_created 和 session_status 时自动维护
