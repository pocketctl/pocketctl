## Why

Token 看板（`/tokens`）单主机视图的 Session 明细有三处不足：
1. **展开内容单薄**：`session-expand-row` 当前只显示 mini chart，未还原设计稿（会话详情标题 + se-grid 6 项指标 + 30 天趋势）。
2. **第一列用 session_id 片段**（如 `72ce6cfa`）而非会话名称，辨识度低。
3. **无翻页**：65 条会话全堆一页，浏览困难。

## What Changes

- **by-daemon sessions 扩展字段**：`getTokensByDaemon` 的 sess 查询加 `model / agent_type / status / created_at`（展开"会话详情"标题需要）。
- **还原展开内容**（对齐 `ui-design/web/token-usage.html` 的 expRow）：会话详情标题（model · agent · 状态 · 创建时间）+ se-grid 6 项（输入量 / 输出量 / 输入输出比 / Cache 命中 / 总 Token / 日均消耗）+ 30 天 mini bars（复用 trend API，`slice(-30)`）。
- **第一列用会话名称**：session row 第一列 `s.title || s.session_id.slice(0,8)`。
- **前端分页**：参考 `DashboardView`（`currentPage / pageSize / pageSizes / totalPages` + 翻页 UI，复用 `dashboard.page_*` i18n）；切页重置展开状态。
- 补充 i18n（se-grid 标签、日均消耗等）。

## Capabilities

### Modified Capabilities
- `token-usage-analytics`：session 明细增强——展开还原设计稿内容、第一列用会话名称、前端分页；by-daemon 返回扩展字段。

## Impact

- `relay/src/db.ts` — `getTokensByDaemon` 的 sess 查询加 `model, agent_type, status, created_at`
- `web/src/views/TokenUsage.vue` — session row 第一列 title、展开还原设计稿、前端分页
- `web/src/i18n/zh.json` / `en.json` — se-grid 标签等 i18n
