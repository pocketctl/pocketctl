## ADDED Requirements

### Requirement: Frontend connects directly to relay WebSocket
前端 SHALL 通过 `window.__RELAY_WS__` 变量获取 relay WebSocket 地址，直连 relay 而非通过 nginx 代理。若变量未设置则回退到 `${location.host}/ws`。

#### Scenario: Page loads with relay URL injected
- **WHEN** index.html 注入了 `window.__RELAY_WS__ = 'ws://localhost:8080/ws'`
- **THEN** 前端 WebSocket 连接到 `ws://localhost:8080/ws?type=client`

#### Scenario: Page loads without relay URL
- **WHEN** `window.__RELAY_WS__` 未定义
- **THEN** 回退到 `ws://${location.host}/ws?type=client`（走 nginx 代理）

### Requirement: Session list restores from database on load
SessionList 页面在 WebSocket 连接建立后 SHALL 发送 `{ type: "list_sessions" }`，将返回的 session 列表渲染为可点击的 session 行。

#### Scenario: Page loads with existing sessions
- **WHEN** 数据库中有 3 个 session
- **THEN** 页面显示 3 个 session 行，每行显示 session ID（前 8 位）、状态、agent、创建时间

#### Scenario: New session created while viewing list
- **WHEN** 用户创建新 session
- **THEN** 列表顶部出现新 session 行，无需手动刷新

### Requirement: Frontend handles session_id_changed event
前端 SHALL 处理 `session_id_changed` 事件，将列表中旧的 pending-* ID 替换为真实 UUID。

#### Scenario: Session ID changes
- **WHEN** 前端收到 `{ type: "session_id_changed", session_id: "real-uuid", old_session_id: "pending-123" }`
- **THEN** 列表中 pending-123 的 session_id 更新为 real-uuid

### Requirement: Frontend displays error events as banner
前端 SHALL 处理 `error` 事件，在页面顶部显示红色错误提示条，5 秒后自动消失。

#### Scenario: Session creation error
- **WHEN** relay 返回 `{ type: "error", error: "chdir /bad/path: no such file" }`
- **THEN** 页面显示红色提示条，内容为错误信息，5 秒后消失

### Requirement: NewSessionDialog has sensible defaults
新建 session 弹窗 SHALL 提供合理的默认值和输入提示。

#### Scenario: Opening new session dialog
- **WHEN** 用户点击 "+ New Session"
- **THEN** Working Directory 字段预填 localStorage 中的 `pocketctl_default_cwd`（如有），Prompt 字段为空且为必填
