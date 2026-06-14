## Why

会话列表（Dashboard 最近会话 + SessionDetail 会话列表）缺少操作入口。用户无法复制会话 ID、置顶常用会话、重命名、导出记录或删除。设计稿 `dashboard.html` / `session-detail.html` 已定义一套统一的悬浮操作菜单（`PocketctlSession` 组件，`ss-` 前缀 CSS），需还原并补齐后端支持。

## What Changes

- **复制会话 ID**：纯前端 `navigator.clipboard`，无后端
- **固定到顶部**：新增 `session_pin` WS 消息 + `sessions.pinned`/`pinned_at` 字段 + 排序逻辑，实时广播 `session_pinned`
- **重命名会话**：新增 `PUT /api/sessions/:id/title` REST 接口，改名后广播 `session_title_update` 同步多端
- **导出记录**：新增 `GET /api/sessions/:id/export?format=md|json|txt` REST 接口，从 events 表拼装
- **删除会话**：复用 WS `session_delete`，前端补 `session_deleted` 监听 + 延迟发送实现 5s 撤销
- **Web 浮窗组件**：hover 显示 ⋯ → 弹 5 项菜单，含删除二次确认、导出格式选择、重命名 inline 编辑、置顶 DOM 重排、复制 toast 反馈

## Capabilities

### New Capabilities

- `session-actions`: 会话级操作（复制ID/置顶/重命名/导出/删除）的浮窗 UI 交互 + 后端接口

### Modified Capabilities

- `session-lifecycle`: 新增 session_pin 消息；session_delete 补 ownership 校验；daemon 被动标题同步改为只覆盖默认标题（保护用户改名）

## Impact

- **DB (`relay/src/db.ts`)**: sessions 表加 `pinned`/`pinned_at` 列 + 索引；新增 `setSessionPin`/`updateSessionTitle`/`getSessionAllEvents`/`isSessionOwnedByUser`；`listSessions`/`listSessionsByUser` SELECT 加 pinned、ORDER BY 加置顶权重、修 daemon_alias bug
- **Relay router (`relay/src/router.ts`)**: handleClientMessage 加 `session_pin` 分支 + 广播；session_delete 补 ownership；daemon 标题同步 SQL 加默认标题保护
- **Relay server (`relay/src/server.ts`)**: 新增 `PUT /api/sessions/:id/title`、`GET /api/sessions/:id/export` REST
- **Web (`web/src/views/SessionList.vue`)**: 补 `session_deleted`/`session_pinned` 监听；sortedSessions 加 pinned 权重；浮窗组件接入
- **Web (`web/src/views/DashboardView.vue`)**: 补 `session_pinned` 监听；sortedSessions 加 pinned；浮窗组件接入
- **Web (`web/src/components/SessionActions.vue`)**: 新增浮窗菜单组件（复用设计稿 ss- CSS）
