## Context

会话列表（Dashboard + SessionDetail）的数据流是「WS 单通道 list + 增量事件 patch」。5 个操作需在此通道扩展。设计稿用统一的 `PocketctlSession` 浮窗组件（hover ⋯ → 菜单），CSS 前缀 `ss-`，含 toast 撤销、确认弹窗、inline 重命名、导出格式选择。

现有能力：sessions 表有 title 无 pinned；WS `session_delete` 链路完整但缺 ownership 校验；SessionList.vue 未监听 session_deleted；daemon 被动标题同步会无条件覆盖用户改名。

## Goals / Non-Goals

**Goals:**
- 还原设计稿 5 项操作的浮窗 UI 和交互
- 复制ID 纯前端；置顶/重命名/导出/删除有后端持久化 + 多端同步
- 修复 4 处现有逻辑 bug（ownership、daemon 覆盖标题、SessionList 未监听删除、daemon_alias）

**Non-Goals:**
- 不做软删除/回收站（删除撤销用"延迟发送"方案）
- 不做导出分页（v2，当前全量导出）
- 不实现移动端独立交互（复用 hover 检测 + 触摸 fallback）

## Decisions

### Decision 1: 接口类型选择

| 功能 | 类型 | 理由 |
|------|------|------|
| 复制ID | 纯前端 | 0 后端 |
| 置顶 | WS | 需实时多端同步，复用同 user 广播 |
| 删除 | WS | 复用已有 session_delete 链路 |
| 重命名 | REST | 低频，401/403 校验反馈清晰 |
| 导出 | REST | 大文件流式响应 |

### Decision 2: 删除撤销用"延迟发送"

点删除 → 确认 → 行淡出 + 5s toast 倒计时 → 倒计时结束才真正 `send session_delete`。撤销 = 取消发送（会话完好）。不依赖墓碑/软删恢复。刷新页面在 5s 窗口内会话仍在。

### Decision 3: 置顶排序

DB `ORDER BY pinned DESC, pinned_at DESC NULLS LAST, COALESCE(last_activity_at, updated_at) DESC`。置顶项内部按置顶时间倒序（先置顶者排前）。前端 sortedSessions 二次排序加 `pinned` 权重。`upsertSession` 的 ON CONFLICT 不含 pinned，daemon 状态更新不清置顶。

### Decision 4: daemon 标题覆盖保护

router.ts daemon 被动 `session_title_update` 的 `UPDATE sessions SET title` 改为 `WHERE ... AND title LIKE 'Terminal Session-%'`。daemon 只能覆盖默认标题，用户自定义标题被保护。

### Decision 5: ownership 校验

新增 `isSessionOwnedByUser(pool, userId, sessionId)`，重命名/导出/删除共用。session_delete 补校验防多租户越权。

## Risks / Trade-offs

- **[删除撤销 + 刷新]** 5s 窗口内刷新会话仍在（未发删除），符合预期
- **[导出大文件]** 长会话 events 可能数万条 → REST 流式响应（reply.raw）+ 浏览器原生 `<a download>`，避免 OOM
- **[clipboard 非安全上下文]** http 非 localhost `navigator.clipboard` undefined → fallback `document.execCommand('copy')`
- **[pending 会话]** pin/export/delete 接口拒绝 `session_id LIKE 'pending-%'`
- **[多端置顶顺序]** 靠 `pinned_at DESC` 时间戳定序，可接受

## Migration Plan

DB migration 幂等（`ADD COLUMN IF NOT EXISTS`），安全。无破坏性。新 WS 消息/REST 接口由前端驱动，旧客户端不触发。
