## ADDED Requirements

### Requirement: CSS design system integration
The Web application SHALL use the `web-shared.css` design system from `ui-design/pocketctl-design-system/css/web-shared.css` as its primary stylesheet, replacing the existing hardcoded dark-only styles in Vue components.

#### Scenario: Design tokens applied globally
- **WHEN** the Web app loads
- **THEN** all colors, spacing, and typography are driven by CSS custom properties defined in `web-shared.css`
- **AND** the `data-theme` attribute on `<html>` controls dark/light mode

#### Scenario: Components use design tokens
- **WHEN** any Vue component renders
- **THEN** it references CSS variables (e.g., `var(--surface)`, `var(--fg)`, `var(--accent)`) rather than hardcoded hex colors

### Requirement: Settings page route
The Web application SHALL provide a `/settings` route accessible from the navigation sidebar.

#### Scenario: Navigate to settings
- **WHEN** user clicks the settings icon/link in the sidebar
- **THEN** the app navigates to `/settings`
- **AND** the settings page is rendered with the two-column layout

## MODIFIED Requirements

### Requirement: Session list view
The web UI SHALL display a list of all agent sessions within the dashboard page as a table with their status, agent type, source, hostname, sub-agent count, and last activity time. The status SHALL be displayed using distinct visual indicators for each of the 8 session states. The web UI SHALL sort sessions by `last_activity_at` descending.

#### Scenario: Active sessions displayed
- **WHEN** user opens the dashboard page
- **THEN** the session table shows all sessions with status indicator, title, source badge, hostname, agent type, sub-agent count, and relative time of last activity
- **AND** sessions are sorted by most recent activity first

#### Scenario: Session list updates in real-time
- **WHEN** a new session is created on the daemon
- **THEN** the session table updates automatically without page refresh

#### Scenario: Session status color coding (unchanged from original)
- **WHEN** session list is displayed
- **THEN** each session shows a status indicator with the following color scheme:
  - Running: green (#22C55E) with pulse animation
  - Idle: yellow (#EAB308)
  - Waiting Approval: orange (#F97316)
  - Exited: gray (#6B7280)
  - Completed: gray (#9CA3AF) with checkmark icon
  - Disconnected: blue (#3B82F6) with dashed border
  - Error: red (#EF4444)
  - Killed: red (#DC2626) with X icon

#### Scenario: Exited session shows exit reason
- **WHEN** a session has status `exited`
- **THEN** the session list item displays the exit reason as a subtitle (e.g., "正常退出", "用户中断")
- **AND** exit reason is displayed in the user's locale

### Requirement: New session creation
The web UI SHALL provide a "New Session" button on the dashboard page that opens a dialog to select the agent type, working directory, and initial prompt.

#### Scenario: Create new session
- **WHEN** user fills in agent type "claude-code", cwd "/path/to/project", prompt "fix the auth bug" and submits
- **THEN** UI sends `session_create` over WebSocket
- **AND** navigates to the new session's detail view
- **AND** streaming output begins appearing

## REMOVED Requirements

### Requirement: Message input for follow-up
**Reason**: The original web-ui spec described a simple text input. The design draft implements a more sophisticated input area with multi-line support and send button. Implementation will follow the design draft.
**Migration**: Implement the message input as designed in the new dashboard/session-detail pages matching the design draft.

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
