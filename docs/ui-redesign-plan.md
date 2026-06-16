# UI 重构计划 — 设计稿 1:1 还原

> 目标：1:1 还原 `ui-design/web/` 设计稿的 6 个改动点。本文件是跨会话接力单，新会话读此 + 设计稿 + 现状代码即可继续。

## 设计稿位置
- `ui-design/web/dashboard.html`（仪表盘）
- `ui-design/web/hosts.html`（主机模块 + 主机详情）
- `ui-design/web/session-detail.html`（会话）
- 设计稿的 `<style>` 段含全部 CSS 类名/样式，是 1:1 还原的样式依据

## 进度
- [x] **C1-1a 仪表盘**（commit `466f32d`）：`stats-strip` 三状态点击筛选（在线/离线/活跃会话）+ `token-strip` 占位 + "管理全部"入口
- [x] **C1-1b 主机模块**：`HostsView.vue` 重构为单栏——`token-global-strip`（占位）+ `host-controls`（筛选/搜索）+ `host-cards-grid` 卡片网格 ↔ `.hosts-selecting` 胶囊横向（`selectHost` toggle 状态机 + `hosts-deselect-btn` ✕）+ 全宽 `host-detail-panel`（`host-detail-grid` 双栏：资源\|连接 / Agent\|Token / 会话全宽 + `hd-more-btn` 详情三点）。Agent/Token 占位待 C2/C3/C4。vue-tsc + vite build 通过。
- [x] **C1-1c 会话按 host 筛选**：`SessionDetail` 接 `?host=` query——`visibleSessions` 按 daemon_id 前端过滤 + 顶部 `host-filter-chip`（主机名 + ✕ 清除）+ `list_daemons` 填充 daemons 字典供 daemonName 查询 + 从主机"查看全部"跳来（default 哨兵）自动落该主机首个会话。`HostsView.goSessionWithHost` 预埋跳转。vue-tsc + build 通过。
- [x] **C1-1d sidebar 缩放对齐**：`App.vue` 缩放按钮对齐设计稿——单箭头 `‹` → **双箭头** `«`/`»`（v-if 按 collapsed 切换图标），位置从 footer 内移到 **footer 上方**独立区块，类名 `.sidebar-toggle` → `.sidebar-toggle-btn`（`justify-content: flex-end; padding: 8px 20px`），`.main-content` 加 `margin-left` transition 平滑收起。vue-tsc + build 通过。
- [x] **C2 Token 后端**：`relay/src/db.ts` 加 `cost_usd` 列 migration + `updateSessionCost`/`backfillSessionCost`/`getCostSummary`/`getCostByDaemon`（时段用 LAG 窗口函数算每次 turn 增量）；`router.ts` session_status 时持久化 cost_usd；`server.ts` 启动时回填历史 + `GET /api/cost/summary`（总/今日/本周/本月）+ `GET /api/cost/by-daemon/:daemonId`（主机级 + 每 session 明细）。tsc 通过（除预先存在的 tencentcloud-sdk）。
- [x] **C3 Token 前端**：`HostsView` 顶部 `token-global-strip` 接 `/api/cost/summary`，选中主机时详情 `token-overview` + `session-token-list` 接 `/api/cost/by-daemon/:id`（`watch(selectedDaemon)`）；`DashboardView` `token-strip` 接 summary。`formatCost`（USD 美元格式，`$0.09`/`<$0.01`）。数据语义为 cost_usd（后端只存美元，非 token 数）。vue-tsc + build 通过。
- [x] **C4 主机管理 + Agent 版本**：
  - **注销**（C4a）：`DELETE /api/daemons/:id`（db.deleteDaemon，sessions 保留 daemon_id 置空）+ 前端 confirmUnregister 调用（乐观删除+失败恢复，无撤销因永久操作）。
  - **Agent 版本上报**（C4b）：`discovery.go` 探测 `claude/codex --version` → `RegisterMessage.AgentVersions map` → relay `registerDaemon` 构造 `[{type,version}]` 存 daemons.agents JSONB → list_daemons 返回 → 前端 agentCards（C1-1b 已兼容对象数组）展示版本。需 daemon 更新生效。
  - **升级**（C4c）：agent-card 升级按钮，点击复制手动升级命令（`npm i -g @anthropic-ai/claude-code`），未实现 daemon 侧自动升级（安全风险）。
  - go build + relay tsc + web vue-tsc + build 通过。

## 6 个改动点（设计稿要的）
1. **sidebar 缩放按钮**（取代旧版）
2. **仪表盘三状态统计**：`.stats-strip` 点击筛选（在线→`/hosts?filter=online`，离线→`offline`，活跃→`/session`）
3. **仪表盘 Token 消耗**：`.token-strip`（总/今日/本周/本月）
4. **仪表盘"管理全部"入口**：跳 `/hosts`
5. **主机模块**：卡片网格 ↔ 胶囊横向（`hosts-selecting` 状态机：点选→胶囊+详情，再点→恢复卡片）+ 顶部 token + 详情面板
6. **主机详情**：Actions 三点（复制/导出/编辑别名/重启/踢下线/注销）+ Agent 运行状态（版本/消耗/升级按钮）+ Token（主机总/今日/本月 + 每 session 明细）+ 底部 session 摘要 + "查看全部"（跳 session 并选中当前主机）

## 接口方案

### 新增接口
- `GET /api/cost/summary` — 用户级（总/今日/本周/本月）
- `GET /api/cost/by-daemon/:id` — 主机级 + 每 session 明细
- `PATCH /api/daemons/:id` — 编辑别名（daemons 表已有 alias 列）
- `DELETE /api/daemons/:id` — 注销主机
- agent 版本：daemon `register`/`daemon_status` 上报版本 + `GET /api/agents/latest`（可选，最新版查询）

### 升级接口
- `list_sessions` + `daemon_id` 筛选参数 + 返回 `cost_usd`
- `list_daemons` + `active_sessions`/`total_sessions` + agent 版本

### Token 数据（关键，已验证可获取）
- daemon `result.total_cost_usd`（`internal/adapter/claude.go:267` 已解析）
- relay `events` 表已存 `session_status`（含 cost，**可历史回填**）
- `sessions` 表需加 `cost_usd` 列（migration）

## 可行性（已验证）
- **纯前端**（#1/2/4 + #5 胶囊交互 + #6 复制/导出/查看全部跳转）：✅ 完全能
- **Token 消耗**（#3/5/6）：✅ 接口能实现（数据源真实 + events 已存），需后端新建全链路
- **Agent 版本**（#6）：✅ `claude --version` 能探测（实测 `2.1.175`），需上报 + 升级机制

## 测试流程（每步）
实现 → `vue-tsc --noEmit`（web）/ `go test` / `go build` → 还原度对照设计稿 HTML → 修 bug → commit。
全部完成：`/test-new-features` 全量 + 生成 `docs/test-report-YYYY-MM-DD.html`。

## ✅ 全部完成（2026-06-16）
- C1（1a/1b/1c/1d）、C2、C3、C4 全部实现，15 项测试通过，2 个类型错误即时修复。
- 全量测试报告：`docs/test-report-2026-06-16.html`
- 端点实测通过：`/api/cost/summary`、`/api/cost/by-daemon/:id`、`DELETE /api/daemons/:id`。
- 唯一待办：Agent 版本上报（C4b）需用户重启本地 daemon 后生效。

## 新会话接手步骤
1. 读本文件 + `ui-design/web/*.html`（设计稿，含 `<style>` CSS）+ `web/src/views/*`（现状）
2. 从 **C1-1b** 继续（HostsView 卡片↔胶囊重构）
3. 流程：实现一步 → 测试 → 修 bug → 无 bug → 下一步，循环到 C4 完成 → 全量测试 + HTML 报告
