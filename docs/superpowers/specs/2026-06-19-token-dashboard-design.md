# Token 消耗看板 — 设计文档

**日期**：2026-06-19
**版本**：v1
**状态**：待评审

---

## 1. 概述

在 PocketCTL 已有 Token 数据采集能力（`sessions.tok_input/output/cache_read/create` + `events` 表的 `agent_text` 每轮 usage）基础上，新增一个独立的 Token 消耗看板页面 `/dashboard/tokens`，为多主机、多模型、多 Agent 的用户提供直观的 Token 消耗监控。

**目标用户画像**：
- 90% 用户：单主机，一个 pocketctl daemon 管一台 Mac
- 10% 用户：2–3 台主机，通过一个 relay 集中管理

**V1 范围**：纯 Token 数量统计（输入/输出/缓存），不含费用换算、不含告警。

---

## 2. 现有数据能力

### 2.1 已有

| 数据 | 存储 | 粒度 |
|------|------|------|
| 每 session 累计 token（总量/输入/输出/缓存读/缓存写） | `sessions.tok_input`, `tok_output`, `tok_cache_read`, `tok_cache_create`, `total_tokens` | session 级 |
| 每 session 成本（USD） | `sessions.cost_usd` | session 级 |
| 每 turn token 明细 | `events` 表 `agent_text` payload 含 `ContextUsage{input_tokens, output_tokens, cache_read_tokens, cache_create_tokens}` | turn 级 |
| 主机标识 | `sessions.daemon_id` | session 级 |
| Agent 类型 | `sessions.agent`（claude-code/codex/opencode） | session 级 |
| 来源 | `sessions.source`（daemon/terminal） | session 级 |
| session 创建时间 | `sessions.created_at` | session 级 |

### 2.2 需补充

| 数据 | 补法 | 优先级 |
|------|------|--------|
| session 的模型名 | relay 在 `session_created` / `session_meta` 时写入 `sessions.model` 字段 | P0（看板核心维度） |
| 按时间 + 主机 + 模型 + Agent 聚合查询 | relay 新增 `GET /api/token-stats` 聚合 API | P0 |
| 每 session 的 token 明细（含模型） | relay 新增 `GET /api/token-sessions` API | P0 |

### 2.3 DB 补充 DDL

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model VARCHAR(64);
```

relay 在 `session_created`（router.ts:254）和 `session_meta`（daemon→client 路由，router.ts:359）时，从事件 payload 提取 model 写入 sessions 表。

---

## 3. 页面布局

### 3.1 默认视图（单主机模式）

页面 `/dashboard/tokens`，垂直流式布局，优先级从高到低：

```
┌──────────────────────────────────────────────────┐
│ Token 使用分析              [ 主机: Mac mini ▾ ] │  ← 右上角主机切换
│ 近 30 天                                        │
├──────────┬──────────┬──────────┬────────────────┤
│ 总消耗     │ 今日消耗   │ 本周消耗   │ 本月消耗         │  ← 概览条（4格，趋势箭头）
│ 12.5M     │ 380K ↑5% │ 2.1M ↓3% │ 12.5M          │
├──────────┴──────────┴──────────┴────────────────┤
│                                                  │
│ 每日消耗（柱状图，30天，输入+输出堆叠）                  │  ← 趋势图
│                                                  │
├─────────────────────┬────────────────────────────┤
│ 模型分布（环形图）     │  消耗热力图（12周）            │  ← 并排
│ glm-5.2    50%      │  ░░▒▓                      │
│ glm-5-turbo 30%     │                            │
│ glm-4.7     20%     │                            │
├─────────────────────┴────────────────────────────┤
│ 细分指标（2行×3列）                                │  ← 指标卡
│ 输入量 · 输出量 · Cache命中量 ·                      │
│ 请求次数 · 活跃会话 · 最常用模型                        │
├──────────────────────────────────────────────────┤
│ Session 明细（可展开行）                            │  ← 明细表
│ ┌──────────┬────────┬────────┬────────┬────────┐ │
│ │ 会话       │ 模型    │ 总量    │ 输入    │ 输出    │ │
│ ├──────────┼────────┼────────┼────────┼────────┤ │
│ │ ▶ a7753… │ glm-5.2│ 2.1M   │ 1.3M   │ 0.8M   │ │  ← 点击展开该 session 的 token 趋势
│ └──────────┴────────┴────────┴────────┴────────┘ │
└──────────────────────────────────────────────────┘
```

### 3.2 全部主机模式

右上角主机下拉选「全部主机」时：

- 概览条：所有主机合计
- 柱状图：每条线一台主机（多线折线图）
- 模型环形图：所有主机按模型聚合
- Session 明细表 → 替换为**主机明细表**（参考初版 `usage-table`）
  - 列：主机名 / 输入量 / 输出量 / Cache 命中 / 总消耗
  - 行不可展开（主机下 session 过多，需单独进 session 列表看）

### 3.3 侧边栏

在现有 sidebar 导航中新增「用量分析」入口（与仪表盘、会话、主机、设置并列），参考初版 HTML 的 sidebar 结构。

---

## 4. 组件清单

| 组件 | 数据来源 | 说明 |
|------|---------|------|
| 概览条（4格） | `GET /api/token-stats?period=today|week|month` | 总/今日/本周/本月 + 趋势箭头（↑↓%） |
| 每日柱状图 | `GET /api/token-stats?granularity=daily&days=30` | 输入（蓝）+ 输出（绿）堆叠，30 天 |
| 模型环形图 | `GET /api/token-stats?group_by=model` | 按模型聚合，中心显示总量，参考智谱风格 |
| 消耗热力图 | `GET /api/token-stats?granularity=daily&days=84` | 12 周 × 7 天，按活跃度 4 级着色 |
| 细分指标卡 | 同上聚合数据 | 输入量/输出量/Cache命中/请求次数/活跃会话/最常用模型 |
| 主机切换下拉 | relay 的 `list_daemons` | 单选：各主机 + 全部主机 |
| Session 明细表 | `GET /api/token-sessions?host=&model=&period=` | 可展开行，展开后显示该 session 日均 token + 模型 |
| 主机明细表 | `GET /api/token-stats?group_by=host` | 仅「全部主机」模式显示 |

---

## 5. 新增 API

### 5.1 `GET /api/token-stats`

聚合 Token 统计。支持参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `host` | string | daemon_id，默认当前选中主机 |
| `model` | string | 模型名，默认全部 |
| `agent` | string | agent 类型，默认全部 |
| `period` | string | `today` / `week` / `month` / 默认累计 |
| `granularity` | string | `daily` 返回每天数据，用于折线/柱状图 |
| `days` | int | 天数，默认 30 |
| `group_by` | string | `model` / `host` / `agent`，默认不分组 |

**响应示例**：

```json
{
  "total": { "input": 8100000, "output": 3100000, "cache_read": 900000, "cache_create": 300000, "total": 12400000 },
  "daily": [
    { "date": "2026-06-01", "input": 120000, "output": 45000, "cache_read": 30000, "cache_create": 10000 },
    ...
  ],
  "by_model": [
    { "model": "glm-5.2", "total": 6200000, "input": 4000000, "output": 1600000, "cache_read": 450000, "cache_create": 150000 },
    { "model": "glm-5-turbo", "total": 3800000, ... },
    { "model": "glm-4.7", "total": 2400000, ... }
  ],
  "by_host": [
    { "daemon_id": "xxx", "hostname": "Mac mini", "total": 5200000, "input": 3400000, "output": 1300000, "cache_read": 350000, "cache_create": 150000 },
    ...
  ]
}
```

### 5.2 `GET /api/token-sessions`

每 session 的 Token 明细。

| 参数 | 类型 | 说明 |
|------|------|------|
| `host` | string | daemon_id |
| `model` | string | 模型名 |
| `period` | string | 时间范围 |
| `limit` | int | 返回条数，默认 20 |

**响应示例**：

```json
{
  "sessions": [
    {
      "session_id": "a7753c75-...",
      "model": "glm-5.2",
      "agent": "claude-code",
      "source": "daemon",
      "total": 2100000,
      "input": 1300000,
      "output": 800000,
      "cache_read": 200000,
      "cache_create": 100000,
      "created_at": "2026-06-18T12:00:00Z",
      "status": "running"
    },
    ...
  ]
}
```

---

## 6. 依赖与实施顺序

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | DB migration: sessions 加 model 字段 | — |
| 2 | relay: session_created / session_meta 写入 model | 1 |
| 3 | relay: `GET /api/token-stats` 和 `GET /api/token-sessions` API | 1 |
| 4 | web: Token 看板页面 + 路由 + sidebar 入口 | 3 |
| 5 | web: 接入 API + 真实数据替换假数据 | 4 |

---

## 7. 设计参考

- 智谱 AI GLM 使用统计页面（环形图、热力图、卡片布局、深色主题）
- Anthropic Console（模型分组、Token 分解、缓存命中率）
- 初版 HTML：`/Users/muwb/Desktop/pocketctl-design-full/web/token-usage.html`

---

## 8. 边界

- V1 不做费用换算（模型价格表、Plan vs API 区分等 V2 处理）
- V1 不做实时推送（页面刷新 / 定时轮询，后续可 WS 推送）
- V1 不做告警（阈值告警 V2）
- 90% 单主机用户默认当前活跃主机视图，手动切「全部主机」进入多主机对比
