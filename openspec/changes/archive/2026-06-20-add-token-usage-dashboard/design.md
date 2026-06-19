# Design — Token Usage Dashboard

## 决策点

### ✅ 已确认

| 决策 | 选择 |
|---|---|
| 总体方案 | **方案 A**：预聚合表 `token_daily_stats` + 删除补偿 |
| 当天数据 | **查询时合并**（合并方式 a）：历史天读 stats + 当天实时扫 events，`UNION ALL`。不做事件驱动增量写。 |

### 推荐默认（spec 落地前可调整）

**预聚合表粒度**：PK = `(user_id, daemon_id, date, model)`，度量列 `input / output / cache_read / cache_create / requests`。正好覆盖设计稿全部维度（柱状/热力=日，环形/最常用=模型，明细=主机，下钻=会话）。

**历史天如何进入 stats**：
- cron 每天 00:05 聚合"昨天"events 写入 stats（昨天起不可变）
- 当天永远 events 实时算
- relay 启动时 backfill 一次（现有 events 历史一次性聚合进 stats）

**删除补偿**（一个事务）—— **仅补偿当天**：历史天已由 cron/backfill 独立聚合进 stats（删 events 不影响 stats 格子），对历史天再 `DO UPDATE` 会重复累计，故只把"当天"（尚未 rollup）的 usage 累计进去。已端到端验证（删会话当天看板总量不变）。
```sql
BEGIN;
INSERT INTO token_daily_stats
  SELECT s.user_id, s.daemon_id, CURRENT_DATE, COALESCE(s.model,'unknown'),
         SUM(usage.input), ... , COUNT(*)
  FROM events e JOIN sessions s ON s.session_id=e.session_id
  WHERE e.session_id=$1 AND e.event_type='agent_text' AND e.payload?'usage'
    AND date_trunc('day', e.created_at) = CURRENT_DATE   -- 仅当天
  GROUP BY s.user_id, s.daemon_id, COALESCE(s.model,'unknown')
  ON CONFLICT (user_id,daemon_id,date,model) DO UPDATE
    SET input=token_daily_stats.input+EXCLUDED.input, ...;
DELETE FROM events   WHERE session_id=$1;
DELETE FROM sessions WHERE session_id=$1;
INSERT INTO deleted_sessions ... ;
COMMIT;
```

**查询时合并形态**（按日序列为例）：
```sql
SELECT date, SUM(input), SUM(output), ...
FROM (
  SELECT date, input, output, ... FROM token_daily_stats WHERE user_id=$1 AND date < CURRENT_DATE
  UNION ALL
  SELECT date_trunc('day', created_at)::date, usage.input, ... FROM events JOIN sessions ...
  WHERE user_id=$1 AND created_at >= CURRENT_DATE AND event_type='agent_text'
) t GROUP BY date;
```

### ✅ 已确认（补充）

| 决策 | 选择 | 说明 |
|---|---|---|
| model 来源 | **m1**：`sessions.model` 列 | `session_created` 写入（per-session 粒度）。现状 `events.agent_text.usage` 不含 model、`session_created.payload.model` 有值，m1 直接落库。 |
| events 保留期 | **保留近 90 天** | 近期明细可下钻；超 90 天的 session 只在 stats 汇总层可见。配 cron 清理 + 看板"已归档"提示。 |

## 数据流

```
events (明细，可删/可归档)              token_daily_stats (汇总，不可变)
  │                                        ▲
  ├──▶ cron 每天: 聚合昨天 ──────────────▶│ 历史天快照
  ├──▶ 启动时: backfill 历史 ────────────▶│
  └──▶ 删除 session 时: 事务内累计 ──────▶│ 补偿(保总量)

看板 API 查询:
  历史天 ◀── token_daily_stats (快)
  当天   ◀── events 实时扫
  UNION ALL → 按日/模型/主机/会话维度
```

## 风险 / 未知

- **历史数据稀疏**：events 当前仅 8 天（2026-06-11~19），9 个月热力图初期大面积空白——数据积累问题，非缺陷；看板需有空状态设计。
- **m1 的 per-session model 假设**：会话中途切模型时，该会话全部 token 归到 `sessions.model`，模型分布略偏（多数会话不切，可接受）。
- **cron 单实例**：relay 若多实例，cron 需 pg advisory lock 防重复跑。
- **回填一致性**：backfill 跑过后，sessions 累计列（tok_*）与 stats 可能短暂不一致；以 stats 为看板权威源。
