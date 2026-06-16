## Context

会话详情页当前 `replay { last_seq: 0 }` **全量加载** session 的所有 events（relay `getEventsAfter`: `id > 0 ORDER BY id ASC`，无 limit）。实测最大 session **5524 events**（多个千级），首屏渲染慢 + 带宽大。

本 change 改为**反向分页 + 向上无限滚动**：首次加载最近 N（移动 50 / 桌面 100），向上滚动翻页加载更早 N。首屏从 5524 → 100（约 55x）。

## Goals

- 首屏快速（最近 N，非全量）
- 向上滚动翻页加载更早历史，滚动位置保持
- 省带宽（按需加载）
- 向后兼容（旧客户端全量行为不破）

## Non-Goals

- 不改 daemon / PTY（events 落 db 不变）
- 不改 events 表结构（id 列已有，复用）
- 不引入虚拟滚动（Phase 1 仍全量渲染已加载批次；未来可加虚拟滚动进一步优化超大 session）

## Decisions

### D1: 协议方案 A（扩展 replay，向后兼容）
`replay` 消息加 `direction`（默认 `forward`）+ `limit`。而非新消息类型（`replay_recent` / `replay_before`）。`direction` 默认 `forward` → 旧 web/relay 行为不变。

### D2: 首次语义 3a（backward + 省略 last_seq = 最近 N）
首次 `replay { direction: "backward", limit: N }`（无 `last_seq`）→ relay `ORDER BY id DESC LIMIT N`（最近 N）。翻页 `replay { direction: "backward", last_seq: cursor, limit: N }` → `id < cursor DESC LIMIT N`。relay 用 `last_seq` 有无区分"最近"vs"翻页"，统一在 backward 分支。

### D3: gap 分析 —— subscribe 同消息生效，无需 forward 补齐
担心「backward 查到最新 id=X 后、subscribe 前有事件落库没人收」。但 relay `handleClientMessage`（router.ts:353）在处理 replay 消息时**第一步就 `subscribedSessions.add`**（早于 db 查询）。时序：
1. web 发 replay(session_id)
2. relay subscribe（subscribedSessions.add）
3. relay handleReplay 查 db backward N（最新 id=X）
4. relay 转发 replay_batch（id ≤ X）
5. 之后事件（id > X）落库 → relay 实时转发（subscribe 已在第 2 步生效）

边界清晰（X）：backward = `id ≤ X`，实时 = `id > X`，**无 gap、无重复**。因此**不需要** "backward + forward 补齐" 的双请求方案（3b，过度设计）。

### D4: 滚动位置保持（prepend 后）
prepend N 条到顶部，视口会跳到顶。修复：prepend 前记录 `oldScrollHeight` + `scrollTop`，prepend 后 `scrollTop += (newScrollHeight - oldScrollHeight)`，视口可见内容不变。

### D5: id-based 去重边界（实现时推翻 —— 不必要）
**原设计**：backward 加载 `id ≤ X`，实时事件 `id > X` 才 append，web track `loadedMaxId` 去重。

**实现时发现不必要**，原因有二：
1. **realtime 事件无 db id**：relay 转发的是 payload 原始事件（agent_text 等），不含 events 表的自增 id，无法做 id-based 去重。
2. **subscribe 时序已保证不重叠**（见 D3）：relay 在 replay 消息处理第一步 `subscribedSessions.add`（router.ts:353），backward 查询后的新事件才走 realtime，backward(id≤X) 与 realtime(id>X) 边界天然清晰，不会重复。

因此实现中**未引入 `loadedMaxId`**，依赖 subscribe 时序 + 现有 `isDuplicate`（邻接文本去重）兜底。原 D5 的 4 个 task（5.1-5.3）相应标注"实现省略"。

### D6: 动态 N（移动 50 / 桌面 100）
web 按视口宽度（`< 768px` 移动）决定 N，作为 `limit` 传 relay。断点与 mobile-responsive capability 一致。

### D7: has_more 信号
relay `replay_end` 加 `has_more`（cursor 前是否还有更早事件 = 返回的最旧 id > session min(id)，或返回条数 = limit 且非首条）。web 据 has_more 决定顶部"加载更多" vs "没有更多"，避免无意义翻页请求。

### D8: DB 索引（需确认）
`id < cursor ORDER BY id DESC LIMIT N` 需 `(session_id, id)` 复合索引支持快速。events 表主键 `id`（全局自增）+ `session_id` 列。需确认是否有 `(session_id, id)` 索引；若无，migrate 加（否则大 session 翻页慢）。

## Architecture / Data Flow

```
首次进 session:
  web → replay { direction: backward, limit: N(50/100), req_id: 1 }
  relay handleReplay (backward, 无 last_seq):
    → db.getRecentEvents(sessionId, N):  SELECT ... ORDER BY id DESC LIMIT N
    → replay_batch (id DESC 分片) + replay_end { has_more, last_seq: <最旧id>, req_id: 1 }
  web:
    → reverse batch (id ASC) → render → scroll to bottom
    → loadedMinId = 最旧, loadedMaxId = 最新, hasMore = msg.has_more

向上滚动到顶 + hasMore:
  web → replay { direction: backward, last_seq: loadedMinId, limit: N, req_id: 2 }
  relay handleReplay (backward, last_seq):
    → db.getEventsBefore(sessionId, loadedMinId, N):  SELECT ... WHERE id < $1 ORDER BY id DESC LIMIT N
    → replay_batch + replay_end { has_more, req_id: 2 }
  web:
    → 记录 oldScrollHeight / scrollTop
    → reverse batch → prepend
    → scrollTop += (newScrollHeight - oldScrollHeight)
    → loadedMinId = 新最旧, hasMore 更新

实时事件 (forward, 现有):
  relay → agent_text/tool_call/... (id > loadedMaxId)
  web: evt.id > loadedMaxId ? append + loadedMaxId=evt.id : drop
```

## relay 改造点

- `db.ts`：
  - `getRecentEvents(pool, sessionId, limit)`：`ORDER BY id DESC LIMIT $2`
  - `getEventsBefore(pool, sessionId, cursor, limit)`：`WHERE session_id=$1 AND id < $2 ORDER BY id DESC LIMIT $3`
  - `getEventsAfter`（现有 forward，保留）
  - 确认/添加 `(session_id, id)` 索引
- `router.ts handleReplay`：
  - 解析 `direction`（默认 forward）+ `limit`
  - forward → getEventsAfter（现有）
  - backward + 无 last_seq → getRecentEvents
  - backward + last_seq → getEventsBefore
  - `replay_end` 加 `has_more`（backward 时计算：返回最旧 id > session min id，或 count = limit）

## web 改造点（SessionDetail.vue）

- `pageSize`：computed，视口 `< 768px` ? 50 : 100
- `loadedMinId` / `loadedMaxId` / `hasMore` / `isLoadingBackward` refs
- 进 session / 切换：`replay { direction: backward, limit: pageSize, req_id: ++replayReqId }`
- `onMessagesScroll`：`scrollTop ≈ 0 && hasMore && !isLoadingBackward` → 触发 backward 翻页
- `replay_batch` 监听：req_id 过滤（现有）+ reverse +（首次 render / 翻页 prepend）
- prepend 后 `nextTick` 调整 scrollTop
- 实时事件监听：`evt.id > loadedMaxId` 才 append（id 去重边界）
- `replay_end`：更新 hasMore + isLoadingBackward=false

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| `(session_id, id)` 索引缺失 → 翻页慢 | D8 确认/添加索引 |
| 滚动位置抖动（prepend 异步） | nextTick 调整 scrollTop；记录 oldScrollHeight |
| id 去重边界 race | loadedMaxId 单调更新；实时 id ≤ loadedMaxId 丢弃 |
| 旧客户端无 direction | D1 默认 forward（现有全量行为） |
| 超大 session 已加载批次仍多 | Phase 1 接受（未来加虚拟滚动） |

## Open Questions

- has_more 计算方式：relay 查 session min(id) 还是 count-based（返回 = limit 即 has_more）？倾向 count-based（简单，少一次查询）
- 切换 session 时清空已加载 id 范围（loadedMinId/MaxId 重置）—— 需在 watch(sessionId) 处理
