## Purpose

iOS 端 token 用量分析看板（还原 `token-usage.html`）：2×2 概览、Token 细分、30 天双色柱状图、模型分布环形图、会话消耗明细。复用后端 `GET /api/tokens/dashboard` 与 `by-daemon` 接口。单页支持**全局**（设置入口）与**单主机**（主机卡入口）双入口。

## ADDED Requirements

### Requirement: 双入口与数据源
TokenUsageView SHALL 接收可选 `daemonId`，决定数据范围：全局用 `dashboard?daemon=all`，单主机用 `dashboard?daemon=<id>`。

#### Scenario: 全局入口
- **WHEN** 从"设置→用量分析"进入（无 daemonId）
- **THEN** 请求 `dashboard?daemon=all`
- **AND** 返回按钮回退到 Settings

#### Scenario: 单主机入口
- **WHEN** 从主机卡"Token 消耗"进入（带 daemonId）
- **THEN** 请求 `dashboard?daemon=<id>`
- **AND** 会话明细用 `by-daemon/:id` sessions
- **AND** 返回按钮回退到 DaemonList

### Requirement: 2×2 概览
TokenUsageView SHALL 渲染总消耗/今日/近7天/近30天四卡（来自 summary.total/today/thisWeek/thisMonth）。

#### Scenario: 概览数值
- **WHEN** dashboard 返回 summary
- **THEN** 四卡分别显示 total / today / thisWeek / thisMonth（人类可读格式，如 12.5M）

### Requirement: Token 细分
TokenUsageView SHALL 显示输入量/输出量/Cache命中/请求次数/最常用模型，通过对 byModel 全模型求和聚合得到细分。

#### Scenario: 细分聚合
- **WHEN** dashboard 返回 byModel
- **THEN** 输入量=Σ model.input，输出量=Σ model.output，Cache命中=Σ model.cache_read，请求次数=Σ model.requests
- **AND** 最常用模型=byModel[0].model，占比=byModel[0].pct

### Requirement: 30 天双色柱状图
TokenUsageView SHALL 用 dailySeries 渲染 30 天每日 input/output 双色柱。

#### Scenario: 柱状渲染
- **WHEN** dailySeries 返回 ≤30 天数据
- **THEN** 每天一根柱，内含 input（accent）与 output（success）两段
- **AND** 柱高按最大日值归一化

### Requirement: 模型分布环形图
TokenUsageView SHALL 用 byModel 渲染模型占比环形图（conic gradient）+ 图例。

#### Scenario: 环形渲染
- **WHEN** byModel 返回模型分布
- **THEN** 环形按各模型 pct 切分（conic gradient）
- **AND** 中心显示 total
- **AND** 图例列出 model + pct

### Requirement: 会话消耗明细
TokenUsageView SHALL 显示会话消耗明细列表（title / model · status / token 总量）。

#### Scenario: 单主机明细
- **WHEN** 单主机入口
- **THEN** 列表来自 `by-daemon/:id` 的 sessions，按 total_tokens 降序

#### Scenario: 全局明细
- **WHEN** 全局入口
- **THEN** 列表来自各 daemon 的 by-daemon sessions 合并后按 total_tokens 取 top N

### Requirement: 今日消耗环比
TokenUsageView SHALL 显示"今日消耗"环比百分比（较昨日），数值来自对 dashboard 的二次查询。

#### Scenario: 环比计算
- **WHEN** 概览"今日消耗"卡渲染
- **THEN** 二次请求 `dashboard?days=2`，用 yesterday vs today 计算百分比
- **AND** 上升显示绿色 ↑，下降显示红色 ↓
- **AND** 昨日无数据时显示 "—"
