## Context

**数据链路（已就绪）：** daemon（`internal/discovery/discovery.go`）通过 `cli --version` 探测 agent 当前版本、`npm view <pkg> version` 探测最新版，上报 `{agents, agent_versions, agent_latests}`；relay 组装 `agents:[{type,version,latest}]` 随 `daemon_status` 事件下发，并提供 token/upgrade REST 接口；iOS 接收。

**模型机制（已就绪）：** daemon `ListAvailableModels()`（`internal/session/manager.go`）读主机 `~/.claude/settings.json` 返回真实可用模型；选主机后 iOS 发 `list_models` → 收 `model_list`；创建会话 `session_create` 带可选 `model`（opus/sonnet/haiku alias，空 = 主机默认）。

**iOS 当前缺口：** `Daemon.from()` 只取 `agents as [String]` 丢弃版本；`APIClient` 未接 token/upgrade/restart/kick/delete；`WebSocketEvent` 缺 `modelList`/`upgradeResult`/`sessionCreateFailed`/`sessionMeta(model)`；`NewSessionSheet` 缺模型/权限/cwd 回填。

## Goals / Non-Goals

**Goals:**
- iOS 完整还原四页设计稿，数据真实（非 mock）
- 新建会话体验对齐 web（模型/权限/cwd 回填/失败超时）
- 后端零改动

**Non-Goals:**
- 不新增后端接口 / 表 / 事件（全部复用现有）
- 不做"添加 Agent"（远程安装，已从设计稿移除）
- 不做 agent 配置里的模型选择（动态易失效，移到新建会话实时选）
- 不做付费订阅（升级专业版仅占位）
- 暂不补"按 agent 维度 token"后端接口（agent 卡片 token 显示 daemon 维度）
- 不做配置的跨设备同步（UserDefaults 本地存）

## Decisions

**1. 配置弹窗只存默认工作目录，不存模型**

模型列表来自主机 `~/.claude/settings.json`，用户可在主机上重置可用模型；若本地存"默认模型"，一旦主机改了模型列表，本地默认会指向失效模型。故模型选择移到**新建会话时实时** `list_models`→`model_list` 选；配置弹窗仅留工作目录。

**2. 配置存储 = UserDefaults，per-daemon-per-agent**

key 形如 `agent_cwd:{daemonId}:{agentType}`。不同主机的可用模型/cwd 不同，故作用域绑定 daemon+agent。纯客户端偏好，后端无需感知；换设备不同步（可接受，见 Non-Goals）。

**3. 模型 + 权限模式放新建会话（对齐 web `NewSessionDialog`）**

- 模型：选主机后发 `list_models` 实时拉取；默认空（跟随主机默认）
- 权限模式：4 选 `bypassPermissions` / `default` / `acceptEdits` / `plan`；iOS 默认 `acceptEdits`（人在场操作，比 web 的 `bypassPermissions` 更稳妥）

**4. token-usage 单页双入口**

同一 `TokenUsageView` 接收可选 `daemonId`：全局入口（设置→用量分析）用 `dashboard?daemon=all`；单主机入口（主机卡→Token 消耗）用 `dashboard?daemon=<id>` + `by-daemon/:id` 的 sessions。返回按钮按入口回退到不同页面。

**5. 图表 SwiftUI 原生自绘，不引第三方库**

30 根双色柱状图用 `GeometryReader` + `HStack`；模型分布环形图用 `Canvas`/`Path` 画 conic gradient。与现有代码风格一致，无新依赖。

## Risks / Trade-offs

- **[按 agent 维度 token 缺失]** 后端无 `getTokenByAgent`；agent-manage 卡片底部 token 显示 **daemon 维度**（妥协）。后续可低成本补后端 `GROUP BY s.agent_type`。
- **[趋势环比 % 精度]** `summary` 只给 today/thisWeek/thisMonth 绝对值，无环比。设计稿的"↑5.2% 较昨日"需前端二次请求 `dashboard?days=2` 算 today vs yesterday；或 MVP 省略环比只显示绝对值。
- **[全局 top sessions]** `dashboard` 不返回跨主机 session 明细。前端方案：用 `byDaemon` 拿到各 daemon，再逐一查 `by-daemon/:id` sessions 合并排序（请求数 = 主机数，主机数通常 ≤ 免费版 1）。或后端补 `topSessions`。
- **[chart 渲染性能]** 30 根双色柱 + 环形图中等复杂度，注意避免 `body` 频繁重绘（数据装进 ViewModel，视图只读）。
- **[upgrade_result 事件丢失]** 若用户离开 agent-manage 页再回来，错过的 `upgrade_result` 无法重放；升级态用乐观 UI + 后台轮询兜底，或进入页面时重新拉 `daemon_status` 确认版本。
