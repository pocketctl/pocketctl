## 1. 数据库 schema 迁移

- [x] 1.1 新建 `token_daily_stats` 表：主键 `(user_id, daemon_id, date, model)`，列 `input/output/cache_read/cache_create BIGINT DEFAULT 0`、`requests INT DEFAULT 0`；索引 `(user_id, date)`
- [x] 1.2 `sessions` 加 `model VARCHAR(64)` 列
- [x] 1.3 启动时回填 `sessions.model`：从 `session_created` 事件 `payload.model` 填充空行（幂等）
- [x] 1.4 启动时 backfill `token_daily_stats`：把已过日期（< 今天）的历史 `agent_text` usage 按 `(user,daemon,date,model)` 聚合 UPSERT 进表（幂等）

## 2. model 落库写入路径

- [x] 2.1 `upsertSession` 增加 `model` 参数，`ON CONFLICT` 用 `COALESCE($10, sessions.model)` 保留
- [x] 2.2 `session_created` handler 调 upsertSession 时传 `msg.model`
- [x] 2.3 `session_discovered` handler 若 `msg.model` 有值也传入

## 3. 历史天聚合（cron）

- [x] 3.1 实现 `aggregateDayIntoStats(date)`：聚合指定天的 events → `token_daily_stats` UPSERT，带 pg advisory lock 防多实例重复
- [x] 3.2 注册 cron（每小时跑昨天，幂等）调用 `aggregateDayIntoStats(昨天)`
- [x] 3.3 relay 启动时调用 backfill（覆盖 1.4）+ 当天不聚合

## 4. 删除补偿（修改 session-delete）

- [x] 4.1 `deleteSession` 改为单事务：先把该 session **当天**的 `agent_text` usage 累计进 `token_daily_stats`（历史天已由 cron 独立保留），再删 events/sessions，再插墓碑
- [x] 4.2 删除补偿验证：由 8.1 端到端事务验证覆盖（before=after=4197727）；独立单元测试待后续补

## 5. 看板聚合 API

- [x] 5.1 按日序列查询：`UNION ALL`（stats `date <= today` 含当天补偿 + events `date = today`），按日聚合 input/output/cache/requests
- [x] 5.2 按模型聚合：stats + 当天 events，model 取 `sessions.model`，返回各模型 token 总量与占比
- [x] 5.3 按主机聚合：按 `daemon_id` 分组的 input/output/cache/requests/total（含 hostname/alias）
- [x] 5.4 session 明细：per-session 累计（复用 `by-daemon`）+ 单会话按日趋势 `getSessionTokenTrend`
- [x] 5.5 所有聚合支持 host 过滤（`getTokenDailySeries`/`getTokenByModel` 的 `daemonId` 参数）
- [x] 5.6 `server.ts` 端点：`GET /api/tokens/dashboard?daemon=&days=` + `GET /api/tokens/session/:id/trend`

## 6. events 保留期治理

- [x] 6.1 定期清理 cron：删除 `created_at < NOW() - 90 days` 的 events（并入组3 rollup setInterval）
- [x] 6.2 session trend 端点对无数据（events 已清）返回 `archived: true`

## 7. 前端看板视图

- [x] 7.1 新建 `web/src/views/TokenUsage.vue`，迁移 `ui-design/web/token-usage.html` 的渲染逻辑（柱状/环形/热力/明细）
- [x] 7.2 接看板聚合 API 替换 mock 数据（`/api/tokens/dashboard` + `/api/tokens/session/:id/trend`）
- [x] 7.3 host 选择器用 dashboard 的 `byDaemon` 列表 + 切换重查（带 daemon 参数）
- [x] 7.4 路由注册 `/tokens` + sidebar "用量分析" 入口
- [x] 7.5 空状态：列表为空时"暂无 Token 消耗记录"；超 90 天会话展开显示"已归档"

## 8. 端到端验证

- [x] 8.1 删除会话 → 看板当天总量不变（事务端到端验证：删 72ce6cfa，before=after=4197727）
- [x] 8.2 当天新消耗实时反映（dashboard 当天从 events 实时查询，合并方式 a）
- [x] 8.3 cron 聚合幂等（aggregateDayIntoStats ON CONFLICT DO NOTHING + advisory lock）
- [x] 8.4 events 超 90 天清理（cleanStaleEvents cron 实现；数据积累后自然生效）
