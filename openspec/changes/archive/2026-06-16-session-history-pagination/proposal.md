## Why

会话详情页当前**全量加载**历史（`replay { last_seq: 0 }` 加载该 session 的所有 events）。实测最大 session **5524 events**（多个 session 千级以上），首屏渲染慢 + 网络带宽大。优化为**反向分页**（首次加载最近 N 条 + 向上滚动翻页加载更早 N 条），显著提升首屏响应（首屏 5524 → 100，约 55x）并节省带宽。

## What Changes

- **`replay` 协议扩展**：消息加 `direction`（`forward` / `backward`，默认 `forward` 向后兼容）+ `limit` 字段
  - `forward`（现有）：`id > last_seq ORDER BY id ASC`（实时补齐 / 增量）
  - `backward`（新）：`id < last_seq ORDER BY id DESC LIMIT N`（历史翻页）；`last_seq` 省略 = 最近 N（`ORDER BY id DESC LIMIT N`）
- **relay**：新增 `getRecentEvents(sessionId, limit)` + `getEventsBefore(sessionId, cursor, limit)`；`replay_end` 加 `has_more` 字段（cursor 前是否还有事件）；`handleReplay` 按 `direction` 分流
- **web SessionDetail**：
  - 进 session 首次 `backward` 加载最近 N（**移动端 50 / 桌面 100**，按视口宽度判断 N 传给 relay）
  - 滚动到顶 + `has_more` → `backward` + `last_seq=最旧已加载id` 翻页 → `prepend` + **保持滚动位置**（`scrollTop += ΔscrollHeight`）
  - **id-based 去重边界**：实时事件 `id > 已加载最新id` 才 append（防 backward 与实时边界重复）

## Capabilities

### Modified Capabilities
- `session-history-replay`: replay 分页语义（`backward` 方向、`limit`、`has_more`、向上翻页 prepend + 滚动位置保持、id 去重边界）+ `replay` 消息加 `direction` / `limit` 字段（向后兼容，默认 `forward`）。replay 协议归属此 capability（client↔relay 消息，非 stream-protocol 的 client↔daemon 层）

## Impact

- **relay**：`db.ts`（新增 2 个查询函数 + 确认 `(session_id, id)` 索引支持 `id < cursor DESC LIMIT N`）+ `router.ts`（`handleReplay` 按 `direction` 分流，`replay_end` 带 `has_more`）
- **web**：`SessionDetail.vue`（首次 backward 加载、向上滚动翻页、prepend + 滚动位置保持、id 去重、N 动态判断）
- **daemon / PTY**：**不涉及**（events 落 db 的逻辑不变，PTY daemon session 与 terminal session 都正常写 events）
- **无 breaking change**：`direction` 默认 `forward`，旧 web/relay 行为不变
- **向后兼容**：旧 web 发 `replay { last_seq: 0 }`（无 direction）→ relay 当 forward（现有全量行为）
