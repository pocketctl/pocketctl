## Why

`ui-design/screens/` 本次迭代新增 `agent-manage.html`、`token-usage.html` 两页，重设计 `daemon-list.html`、`settings.html` 两页。这些屏幕对应的后端能力（token 多维聚合、agent 版本上报与升级、`model_list`、daemon restart/forceKick/delete）**均已就绪且 web 端已实现**，但 iOS 客户端存在系统性接入缺口：

- `Daemon` model 只存 `agents: [String]`，**丢弃**了 relay 已下发的 `{type, version, latest}`
- `APIClient` 仅接了 auth/device/alias，**未接** token 看板、agent 升级、主机操作接口
- `WebSocketEvent` **未监听** `model_list` / `upgrade_result` / `session_create_failed` / `session_meta(model)`
- `NewSessionSheet` 缺模型选择、权限模式、工作目录回填

目标：在 iOS 完整还原这四页 + 增强新建会话，**后端零改动**。

## What Changes

**数据层解锁（四页共同前置）：**
- `Daemon` model 解析 agent `{type, version, latest}`；`WebSocketEvent` 补 `modelList` / `upgradeResult` / `sessionCreateFailed` / `sessionMeta`；`APIClient` 补 token 看板、agent 升级、daemon restart/forceKick/delete

**新增 `AgentManageView`（agent-manage.html）：**
- Agent 版本展示（当前/最新/可升级判断）、运行状态 + 活跃会话数、一键升级（`POST upgrade-agent` + `upgrade_result` 回调）
- 配置弹窗**仅设默认工作目录**（per-daemon-agent，UserDefaults）；模型不入配置
- 全部/可升级 筛选；**移除"添加 Agent"按钮**

**新增 `TokenUsageView`（token-usage.html）：**
- 2×2 概览、Token 细分、30 天双色柱状图、模型分布环形图、会话消耗明细
- 单页双入口：全局（设置→用量分析，`dashboard?daemon=all`）与单主机（主机卡→Token 消耗，`dashboard?daemon=<id>` + by-daemon sessions）

**增强 `DaemonListView`（daemon-list.html）：**
- 概览状态卡（在线/离线/今日 Token/活跃会话）、Agent 标签带版本号、四项功能入口（会话/新建/Token/Agent）、最近会话区、⋯ 操作菜单（重启/别名/踢下线/注销）

**增强 `SettingsView`（settings.html）：**
- 主机列表（在线/离线 chip）、用量分析入口、升级专业版占位

**增强 `NewSessionSheet`（对齐 web `NewSessionDialog`）：**
- 动态模型选择（实时 `list_models`→`model_list`）、工作目录本地回填（per-daemon-agent）、权限模式选择器（4 选）、失败 banner + 15s 超时 `abort_create` 兜底

## Capabilities

### New Capabilities
- `ios-agent-management` — iOS 端 agent 版本展示、升级、配置默认工作目录
- `ios-token-usage` — iOS 端 token 用量分析看板渲染（复用后端 `token-usage-analytics` API）
- `ios-host-detail` — iOS 主机列表增强（概览/功能入口/最近会话/操作菜单）+ 设置页主机列表
- `ios-session-create` — iOS 新建会话增强（模型/权限/cwd 回填/失败超时）

### Modified Capabilities
- 无（后端 `token-usage-analytics` / `session-create-flow` 等均不改）

## Impact

**iOS（全部改动集中于此）：**
- `ios/Pocketctl/Models/Daemon.swift`、`Models/WebSocketEvent.swift` — 解析 agent 版本、新增事件类型
- `ios/Pocketctl/Services/APIClient.swift` — 补 token/upgrade/restart/forceKick/delete 接口封装
- `ios/Pocketctl/ViewModels/DaemonListViewModel.swift` + 新增 `AgentManageViewModel` / `TokenUsageViewModel` — 数据装配
- `ios/Pocketctl/Views/` — 新增 `AgentManageView` / `TokenUsageView`，增强 `DaemonListView` / `SettingsView` / `NewSessionSheet`
- `ios/Pocketctl/Utils/` — 新增 UserDefaults 工具存 per-daemon-agent 默认 cwd

**后端（relay / internal）：0 改动** — 所有接口与协议字段已存在
