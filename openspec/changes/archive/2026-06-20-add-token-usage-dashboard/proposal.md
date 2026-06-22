## Why

Token 使用看板（`ui-design/web/token-usage.html`）需要按日 / 模型 / 主机 / 会话多维度统计。现状有两个结构性问题：

1. **删除会话导致统计缩水**：`getTokenSummary` / `getTokensByDaemon` 实时扫 `events` 聚合，而 `deleteSession` 执行 `DELETE FROM events WHERE session_id = $1` —— 删除一个消耗 100 万 token 的老会话，总消耗立即减少 100 万，不真实。`deleted_sessions` 墓碑只留 `session_id`，无 token 数据。
2. **events 无限增长 + 全表扫**：events 仅在 session 删除时清理，永久累积；多维聚合每次查询都全表扫描，随数据增长越来越慢。

目标：让删除会话不丢失历史消耗（还原真实消耗量），同时支撑看板的多维聚合且查询不随数据膨胀。

## What Changes

- 新建 `token_daily_stats` 预聚合表 `(user_id, daemon_id, date, model, input, output, cache_read, cache_create, requests)` —— 不可变历史快照
- `sessions` 加 `model` 列：`session_created` / `upsertSession` 写入；一次性回填（从 `session_created` 事件 `payload.model`）
- **修改删除流程**（`session-delete`）：删 session 前在**事务内**把该 session 的按日/模型 token 累计进 `token_daily_stats`（`INSERT ... ON CONFLICT DO UPDATE + delta`），再删 events/sessions —— 删除后明细消失、历史汇总保留
- **历史天聚合**：cron 每天凌晨把"昨天"的 events 聚合写入 `token_daily_stats`（昨天起成为不可变历史）
- **看板聚合 API**（按日 / 模型 / 主机 / 会话）：**查询时合并** —— 历史天读 `token_daily_stats` + 当天实时扫 `events`，`UNION ALL`
- events 保留期治理（可选）：老 events 归档进 stats 后清理，明细只保留近 N 天
- 前端：`token-usage.html` 设计稿迁移为 Vue 视图 + 路由 + sidebar 入口

## Capabilities

### New Capabilities
- `token-usage-analytics`：预聚合表 + 多维聚合 API（按日 / 模型 / 主机 / 会话），支撑 Token 看板；删除会话不丢失历史消耗

### Modified Capabilities
- `session-delete`：删除流程增加"补偿累计"步骤 —— 删 events 前先把该会话的 token 按日/模型沉淀到 `token_daily_stats`

## Impact

- `relay/src/db.ts` — `token_daily_stats` 建表/迁移；`sessions` 加 `model` 列 + 回填；`deleteSession` 改事务补偿；多维聚合查询函数
- `relay/src/router.ts` — `session_created` 写 model；cron 调度历史天聚合（含 pg advisory lock 防多实例重复）
- `relay/src/server.ts` — 新增看板聚合 API 端点（参数化维度 + 时间范围）
- `web/src/views/` — 新增 `TokenUsage` 视图（迁移设计稿渲染逻辑）；路由 + sidebar 入口
