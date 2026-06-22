## 1. 后端：by-daemon 扩展字段

- [x] 1.1 `getTokensByDaemon` 的 sess 查询 SELECT 加 `model, agent_type, status, created_at`；返回 sessions 数组每项带这些字段

## 2. 前端：展开内容还原（对齐设计稿 expRow）

- [x] 2.1 `session-expand-row` 还原设计稿：会话详情标题（model · agent · 状态 · 创建时间）
- [x] 2.2 se-grid 6 项（输入量 / 输出量 / 输入输出比 / Cache 命中 / 总 Token / 日均消耗）
- [x] 2.3 mini bars 用 trend API `slice(-30)`（已有 `sessionTrend`，取后 30 天按 input）

## 3. 前端：第一列用会话名称

- [x] 3.1 session row 第一列 `s.title || s.session_id.slice(0,8)`

## 4. 前端：分页（参考 DashboardView）

- [x] 4.1 state：`currentPage`、`pageSize`（默认 10）、`pageSizes`（[10,20,50]）
- [x] 4.2 computed：`totalPages = ceil(sessions.length/pageSize)`、`pagedSessions = sessions.slice(...)`
- [x] 4.3 翻页 UI（« ‹ 当前/总 › » + pageSize select，复用 `dashboard.page_*` i18n）
- [x] 4.4 切页 / 切 host 重置 `expanded = null`

## 5. i18n + 验证

- [x] 5.1 补 i18n（se-grid 标签、日均消耗、会话详情前缀等，zh/en）
- [x] 5.2 验证：展开内容完整、第一列名称、翻页正常、切页重置展开
