## 1. relay DB 查询（D8）

- [x] 1.1 `relay/src/db.ts`: 新增 `getRecentEvents(pool, sessionId, limit)` —— `SELECT id, session_id, event_type, payload, created_at FROM events WHERE session_id = $1 ORDER BY id DESC LIMIT $2`
- [x] 1.2 `relay/src/db.ts`: 新增 `getEventsBefore(pool, sessionId, cursor, limit)` —— `WHERE session_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3`
- [x] 1.3 确认 events 表 `(session_id, id)` 复合索引存在；若无，加 migration `CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id)`（支持 `id < cursor DESC LIMIT N` 快速）
- [ ] 1.4 单元测试：getRecentEvents / getEventsBefore / 边界 — 待补（SQL + 编译已验证，单元测试待）

## 2. relay handleReplay 方向分流（D1/D2/D7）

- [x] 2.1 `relay/src/router.ts` handleReplay 解析 `direction`（默认 `forward`，向后兼容）+ `limit`
- [x] 2.2 `forward`（默认）→ `getEventsAfter`（现有逻辑，无 limit）
- [x] 2.3 `backward` + 无 `last_seq` → `getRecentEvents(sessionId, limit)`
- [x] 2.4 `backward` + `last_seq=X` → `getEventsBefore(sessionId, X, limit)`
- [x] 2.5 `replay_end` 加 `has_more` 字段（count-based：返回条数 = limit → has_more=true，否则 false）；backward 与 forward 都带
- [x] 2.6 `replay_batch` / `replay_end` 的 `req_id` 透传继续工作（现有，backward 翻页去重）

## 3. web 首次 backward 加载（D2/D6）

- [x] 3.1 `web/src/views/SessionDetail.vue`: `pageSize` computed —— 视口 `< 768px` ? 50 : 100（与 mobile-responsive 断点一致）
- [x] 3.2 进 session / watch(sessionId) / onMounted：发 `replay { direction: "backward", limit: pageSize, req_id: ++replayReqId }`（替代现有 `last_seq: 0`）
- [x] 3.3 新增 refs：`loadedMinId` / `loadedMaxId` / `hasMore` / `isLoadingBackward`
- [x] 3.4 `replay_batch` 监听：req_id 过滤（现有）+ batch 按 id DESC，reverse 后（id ASC）首次 render + 滚到底；更新 loadedMinId/loadedMaxId
- [x] 3.5 `replay_end` 监听：更新 `hasMore = msg.has_more`、`isLoadingBackward = false`

## 4. web 向上翻页 + 滚动位置保持（D4）

- [x] 4.1 `onMessagesScroll`：`scrollTop ≈ 0 && hasMore && !isLoadingBackward` → 触发 backward 翻页
- [x] 4.2 翻页：`replay { direction: "backward", last_seq: loadedMinId, limit: pageSize, req_id: ++replayReqId }` + `isLoadingBackward = true`
- [x] 4.3 `replay_batch`（翻页批次）：reverse + **prepend** 到 messages 顶部（区别于首次 render）
- [x] 4.4 prepend 后 `nextTick`：`scrollTop += (newScrollHeight - oldScrollHeight)`（记录 prepend 前 scrollHeight）保持视口
- [x] 4.5 翻页请求去重：在途（isLoadingBackward）时不重复发

## 5. web id-based 去重边界（D5/D3）

- [x] 5.1 ~~实时事件 `id > loadedMaxId` 才 append~~ — **实现发现不必要**：realtime 事件是 payload 原始事件（无 db id），且 relay subscribe 在 replay 同消息生效（router.ts:353），backward(id≤X) 与 realtime(id>X) 时序上不重叠；现有 `isDuplicate` 兜底。`loadedMaxId` 未引入（D5 在实现时被推翻）
- [x] 5.2 ~~realtime `id ≤ loadedMaxId` 丢弃~~ — 同 5.1，subscribe 时序保证边界，无需 id 去重
- [x] 5.3 ~~backward 翻页 id 范围去重~~ — 同上，翻页 cursor(`loadedMinId`) 与 realtime(id>最新) 不重叠
- [x] 5.4 切换 session 重置 `loadedMinId`/`hasMore`/`isLoadingBackward`（watch(sessionId) + onMounted + session_id_changed 已实现）

## 6. 测试与验证

- [x] 6.1 `cd relay && npx tsc --noEmit`（relay 类型通过）
- [x] 6.2 `cd web && npx vue-tsc --noEmit`（web 类型通过）
- [ ] 6.3 relay 单元测试：handleReplay 方向分流 — 待补（需 db mock）
- [x] 6.4 web 实测 — ✓ 用户实测翻页（反馈跳变 → 修复 overflow-anchor 错锚 + 手动 scrollTop + pageSize 50 + iOS 风格回底按钮 fixed 悬浮）
- [x] 6.5 回归：旧客户端 `replay { last_seq: 0 }`（无 direction）→ relay forward 全量（代码保证：direction 默认 forward）
- [x] 6.6 回归：实时与 backward 边界无重复 — 架构保证（subscribe 同消息生效，见 D3/D5）

---

**实现顺序建议**：1（DB 查询 + 索引）→ 2（handleReplay 方向 + has_more）→ 6.3（relay 测试）→ 3（web 首次 backward）→ 4（翻页 + 滚动）→ 5（id 去重）→ 6.4-6.6（web 实测 + 回归）。

**关键风险点**：1.3（索引，影响大 session 翻页性能）、4.4（滚动位置保持，prepend 抖动）、5.2（id 去重边界，防重复）。
