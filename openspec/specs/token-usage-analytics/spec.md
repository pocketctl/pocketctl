## ADDED Requirements

### Requirement: token_daily_stats 预聚合表
Relay SHALL 维护一张 `token_daily_stats` 预聚合表，按 `(user_id, daemon_id, date, model)` 粒度存放每日 token 消耗的不可变历史快照，度量列含 `input / output / cache_read / cache_create`（BIGINT）与 `requests`（INT）。

#### Scenario: 表结构与主键
- **WHEN** Relay 初始化数据库
- **THEN** `token_daily_stats` 表存在
- **AND** 主键为 `(user_id, daemon_id, date, model)`
- **AND** 含 `input / output / cache_read / cache_create`（BIGINT DEFAULT 0）与 `requests`（INT DEFAULT 0）

### Requirement: sessions 记录 model
Relay SHALL 在 `sessions` 表持久化 `model`：`session_created` 事件到达时写入；对历史 `sessions` 在启动时一次性回填。

#### Scenario: 新会话写入 model
- **WHEN** Relay 收到 `session_created` 事件且 `payload.model` 非空
- **THEN** 对应 `sessions.model` 被写入（经 upsertSession）

#### Scenario: 历史 model 回填
- **WHEN** Relay 启动
- **THEN** `sessions.model` 为空的行从其 `session_created` 事件 `payload.model` 回填
- **AND** 该回填幂等

### Requirement: 历史天聚合（cron + backfill）
Relay SHALL 每天凌晨把"前一天"的 `events` 聚合写入 `token_daily_stats`；并在启动时 backfill 已过的历史天。

#### Scenario: 每日 cron 聚合前一天
- **WHEN** 每天凌晨定时任务触发
- **THEN** Relay 把前一天的 `agent_text` usage 按 `(user_id, daemon_id, date, model)` 聚合
- **AND** UPSERT 进 `token_daily_stats`

#### Scenario: 启动 backfill 历史
- **WHEN** Relay 启动
- **THEN** 已过日期（< 今天）的历史 events 一次性聚合进 `token_daily_stats`
- **AND** 该操作幂等（重复运行不重复累计）

#### Scenario: 多实例不重复跑
- **WHEN** Relay 多实例部署
- **THEN** cron 聚合通过 pg advisory lock 串行化，同一历史天不重复累计

### Requirement: 查询时合并历史与当天
看板聚合查询 SHALL 合并历史天（`token_daily_stats`）与当天（`events` 实时扫描），以 `UNION ALL` 拼接后按维度聚合。

#### Scenario: 按日序列合并
- **WHEN** 客户端请求近 N 天的每日 token 序列
- **THEN** 返回 `token_daily_stats`（date < 今天）与 `events`（created_at >= 今天）的 `UNION ALL`，按 date 聚合

#### Scenario: 当天数据实时
- **WHEN** 当天产生新的 agent_text usage 事件
- **THEN** 看板当天的数值在下次查询时反映新增量（无需等待 cron）

### Requirement: 看板多维聚合 API
Relay SHALL 提供 Token 看板聚合 API，支持按日 / 模型 / 主机 / 会话维度，并可按 host 过滤。

#### Scenario: 按主机聚合
- **WHEN** 客户端请求"全部主机"维度的消耗
- **THEN** API 返回每主机的 `input / output / cache / requests / total`

#### Scenario: host 过滤
- **WHEN** 客户端选定单个主机
- **THEN** 所有聚合（日序列/模型/明细）按该 `daemon_id` 过滤

#### Scenario: 模型分布
- **WHEN** 客户端请求模型分布
- **THEN** API 返回各模型的 token 总量与占比（model 取自 `sessions.model`）

#### Scenario: Session 明细与按日趋势
- **WHEN** 客户端请求某主机的 session 明细
- **THEN** API 返回 per-session 累计 token（input/output/cache/total/model/status）
- **AND** 展开的单会话按日趋势从 events 聚合（累计列 + 按日分布）

### Requirement: events 保留期治理
Relay SHALL 清理超过 90 天的 `events` 明细，同时保留 `token_daily_stats` 汇总不受影响。

#### Scenario: 清理老 events
- **WHEN** 定期清理任务运行
- **THEN** `created_at < NOW() - INTERVAL '90 days'` 的 `events` 行被删除
- **AND** `token_daily_stats` 中的聚合不受影响

#### Scenario: 超期明细不可下钻
- **WHEN** 客户端请求 90 天前的 session 明细
- **THEN** API 返回"已归档"标识（明细不可查，但汇总仍在看板）

### Requirement: Session 明细展开内容与分页
单主机视图的 session 明细 SHALL 还原设计稿展开内容（会话详情 + 6 项指标 + 30 天趋势），第一列用会话名称，并支持前端分页。by-daemon 返回 `model / agent_type / status / created_at` 供展开标题使用。

#### Scenario: 展开显示完整内容
- **WHEN** 用户展开一个 session
- **THEN** 显示会话详情标题（model · agent · 状态 · 创建时间）
- **AND** se-grid 6 项（输入量 / 输出量 / 输入输出比 / Cache 命中 / 总 Token / 日均消耗）
- **AND** 30 天每日趋势 mini bars（trend API `slice(-30)`）

#### Scenario: 第一列用会话名称
- **WHEN** 渲染 session 明细行
- **THEN** 第一列显示会话 title（无 title 时回退 session_id 前 8 位）

#### Scenario: 分页
- **WHEN** session 数超过 pageSize
- **THEN** 显示翻页控件（首页 / 上页 / 当前 / 总 / 下页 / 末页 + 每页条数选择）
- **AND** 切页或切 host 时重置展开状态

#### Scenario: by-daemon 返回扩展字段
- **WHEN** 客户端请求 by-daemon sessions
- **THEN** 每个 session 含 `model / agent_type / status / created_at`（供展开标题）
