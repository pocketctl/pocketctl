# Design — token-session-detail-enhance

## 决策点

### ✅ 已确认（来自 explore）
- 展开内容对齐设计稿 expRow：会话详情标题 + se-grid 6 项 + mini bars
- 第一列用 title
- 前端分页（参考 DashboardView，非后端分页）
- by-daemon sessions 加 `model / agent_type / status / created_at`

### 展开内容数据来源
| se-grid 项 | 来源 |
|---|---|
| 输入量 | `s.tok_input`（by-daemon）|
| 输出量 | `s.tok_output` |
| 输入/输出比 | `tok_input/total %` / `tok_output/total %` |
| Cache 命中 | `s.tok_cache_read` |
| 总 Token | `s.total_tokens` |
| 日均消耗 | `total_tokens / 30` |
| mini bars（30 天）| trend API（`/session/:id/trend`）`slice(-30)`，按 input |

会话详情标题：`s.model · s.agent_type · 状态(s.status i18n) · 创建于 s.created_at`

### 日均消耗口径
设计稿用 `s.total/30`（固定 30）。跨多天会话用真实天数更准，但设计稿是 `/30`。**跟设计稿 `/30`**（简单一致，符合设计意图）。

### 分页（前端，参考 DashboardView）
- state：`currentPage`、`pageSize`（默认 10）、`pageSizes`（[10,20,50]）
- computed：`totalPages = ceil(sessions.length/pageSize)`、`pagedSessions = sessions.slice((currentPage-1)*pageSize, currentPage*pageSize)`
- 翻页 UI：« ‹ 当前/总 › » + pageSize select（复用 `dashboard.page_*` i18n）
- 显示条件：`totalPages > 1 || pageSize < sessions.length`
- **切页 / 切 host 重置 `expanded = null`**（避免跨页展开混乱）

### by-daemon 扩展
`getTokensByDaemon` 的 sess 查询 SELECT 加 `model, agent_type, status, created_at`；返回 sessions 数组每项带这些字段。

## 风险
- 日均 `/30` 对短会话偏低、长会话偏高——可接受（设计意图，非精确统计）。
- 分页后展开行需在 `pagedSessions` 的 v-for 内（展开行跟所属 session 同页）。
