## 1. 数据层解锁（四页共同前置）

- [x] 1.1 `Daemon` model：`agents: [String]` → `agents: [AgentInfo]`，`AgentInfo{type, version, latest}`
- [x] 1.2 `Daemon.from(event:)` 解析 `daemon_status` 的 `agents: [{type,version,latest}]`
- [x] 1.3 `WebSocketEvent`：新增 `modelList` / `upgradeResult` / `sessionCreateFailed` / `sessionMeta` case 及访问器
- [x] 1.4 `WebSocketService`：`list_models {daemon_id}` 请求；`model_list` 事件按 daemon 分发
- [x] 1.5 `APIClient`：新增 `getTokenDashboard(daemon, days)` / `getTokenSummary()` / `getTokensByDaemon(id)` / `getSessionTokenTrend(id)` / `upgradeAgent(daemonId, agent)` / `restartDaemon` / `forceKickDaemon` / `deleteDaemon`
- [x] 1.6 新增 `AgentDefaultsStore`（UserDefaults wrapper）：get/set per-daemon-agent 默认 cwd

## 2. AgentManageView（agent-manage.html）

- [x] 2.1 `AgentManageViewModel`：持有 daemon、解析 agents、活跃会话数（按 agent_type 过滤 sessions）、按 agent 聚合 token（暂取 daemon 维度）
- [x] 2.2 Agent 卡片：icon+名称、运行状态+活跃会话数、版本行（当前/最新/可升级标记）、token mini（总/今日/Cache）
- [x] 2.3 升级按钮：调 `upgradeAgent`，乐观 loading，监听 `upgrade_result` 事件更新版本行
- [x] 2.4 配置弹窗（bottom sheet）：仅"工作目录"输入，存 `AgentDefaultsStore`；**无模型选择**
- [x] 2.5 筛选切换：全部 / 可升级
- [x] 2.6 **移除"添加 Agent"按钮**（设计稿该按钮删除）
- [x] 2.7 入口：daemon-list 主机卡 "Agent 管理" 行 → push

## 3. TokenUsageView（token-usage.html）

- [x] 3.1 `TokenUsageViewModel`：接收可选 `daemonId`，调 dashboard（+by-daemon for 单主机 sessions）
- [x] 3.2 2×2 概览卡：总消耗/今日/近7天/近30天（summary）；今日环比%（二次请求 days=2 算 today vs yesterday）
- [x] 3.3 Token 细分行：输入量/输出量/Cache命中/请求次数/最常用模型（对 byModel 求和聚合）
- [x] 3.4 30 天双色柱状图（dailySeries：input/output）
- [x] 3.5 模型分布环形图（byModel：conic gradient + 占比图例）
- [x] 3.6 会话消耗明细：单主机用 by-daemon sessions；全局用各 daemon sessions 合并 top N
- [x] 3.7 双入口返回按钮：全局→Settings，单主机→DaemonList/主机卡

## 4. DaemonListView 增强（daemon-list.html）

- [x] 4.1 概览状态卡：在线/离线数、今日 Token（summary.today）、活跃会话数
- [x] 4.2 Agent 标签带版本号（取自 daemon.agents[].version）+ 可升级提示
- [x] 4.3 功能列表行：会话列表 / 新建会话 / Token 消耗 / Agent 管理（各带 value + chevron）
- [x] 4.4 最近会话区（取最近 N 条 sessions）
- [x] 4.5 ⋯ 操作菜单（bottom sheet）：重启 daemon / 编辑别名 / 强制踢下线 / 注销主机
- [x] 4.6 离线主机功能行灰化（新建会话/Agent 管理禁用，仅 Token 消耗可查）

## 5. SettingsView 增强（settings.html）

- [x] 5.1 "我的主机"区：列出每台主机（在线/离线 chip），点击跳 daemon-list
- [x] 5.2 "其他"区新增"用量分析"行 → push TokenUsageView（全局入口）
- [x] 5.3 升级专业版行（占位：点击弹"敬请期待"/候补，后端无支付）

## 6. NewSessionSheet 增强（对齐 web NewSessionDialog）

- [x] 6.1 主机预选（从主机卡进入时带入 daemonId）
- [x] 6.2 模型选择 Picker：选主机后发 `list_models`，收 `model_list` 填充；默认空=跟随主机
- [x] 6.3 工作目录：回填 `AgentDefaultsStore` 的 per-daemon-agent cwd；提交时保存
- [x] 6.4 权限模式选择器：4 选（bypassPermissions/default/acceptEdits/plan），默认 acceptEdits
- [x] 6.5 `session_create` 消息补 `model` + `permission_mode` 参数
- [x] 6.6 失败 banner：监听 `session_create_failed`，按 reason（no_cli/bad_cwd/start_fail/daemon_offline）显示文案
- [x] 6.7 15s 超时兜底：发 `abort_create` + 显示超时提示
- [x] 6.8 三态 loading：SUBMITTING→CONNECTING（pending id）→SUCCESS（真实 id）/FAILED

## 7. 联调与验证

- [x] 7.1 后端未改，relay/internal 不需构建
- [x] 7.2 iOS 真机/模拟器：daemon 在线 → agent-manage 显示真实版本与可升级
- [x] 7.3 验证升级：点升级 → 收 upgrade_result → 版本行更新
- [x] 7.4 验证 token-usage：双入口数据正确，图表渲染正常
- [x] 7.5 验证新建会话：模型列表来自主机真实 model_list；cwd 回填；权限模式传入；失败/超时提示
- [x] 7.6 验证 ⋯ 菜单：restart/forceKick/delete 调用与限流（forceKick 3次/小时）提示
