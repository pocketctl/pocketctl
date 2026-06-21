## Purpose

iOS 端 agent 管理页（还原 `agent-manage.html`）：展示 daemon 已安装 agent 的版本与最新版、可升级判断、一键升级、配置 per-daemon-agent 默认工作目录（供新建会话回填）。复用后端 `daemon_status.agents[{type,version,latest}]` 与 `POST /api/daemons/:id/upgrade-agent` + `upgrade_result` 事件。**移除"添加 Agent"按钮**。

## ADDED Requirements

### Requirement: Agent 版本与可升级状态展示
AgentManageView SHALL 从 `daemon_status` 事件的 `agents[{type,version,latest}]` 渲染每个 agent 的当前版本、最新版本，并比较二者显示"可升级"标记。

#### Scenario: 当前版本低于最新版本
- **WHEN** 某 agent 的 version 非空且与 latest 不同
- **THEN** 显示"当前版本 v{version}"与"最新版本 v{latest}"两行
- **AND** 标记"可升级"

#### Scenario: 已是最新
- **WHEN** agent 的 version 等于 latest（或 latest 为空）
- **THEN** 仅显示"当前版本 v{version} ✓ 最新"
- **AND** 升级按钮禁用为"已是最新"

#### Scenario: 版本未知
- **WHEN** version 为空
- **THEN** 显示"版本未知"
- **AND** 不显示可升级标记

### Requirement: Agent 运行状态与活跃会话数
AgentManageView SHALL 显示每个 agent 的运行状态与活跃会话数，基于该 daemon 下按 `agent_type` 过滤的非终态 sessions。

#### Scenario: 运行中
- **WHEN** 该 agent 有 ≥1 个非终态会话
- **THEN** 显示绿色状态点 + "运行中 · N 个活跃会话"

#### Scenario: 空闲
- **WHEN** 该 agent 无活跃会话
- **THEN** 显示灰色状态点 + "空闲 · 0 个活跃会话"

### Requirement: 一键升级 Agent
点击"升级"按钮 SHALL 调用 `POST /api/daemons/:id/upgrade-agent`，进入 loading 态，并在收到 `upgrade_result` 事件后更新版本行。

#### Scenario: 发起升级
- **WHEN** 用户点击可升级 agent 的"升级到 v{latest}"按钮
- **THEN** 调用 upgrade-agent 接口（body `{agent: type}`）
- **AND** 按钮进入"升级中…"loading 态，禁用重复点击

#### Scenario: 升级成功
- **WHEN** 收到 `upgrade_result` 事件且成功
- **THEN** 当前版本更新为 latest
- **AND** 升级按钮变为"已是最新"，移除"可升级"标记

#### Scenario: 升级失败
- **WHEN** 收到 `upgrade_result` 事件且失败
- **THEN** 恢复按钮可点击，显示失败提示

### Requirement: 配置默认工作目录（per-daemon-agent）
AgentManageView 的配置弹窗 SHALL 仅提供工作目录输入，存储到 UserDefaults（per-daemon-per-agent），供 NewSessionSheet 回填；**不提供模型选择**。

#### Scenario: 保存默认工作目录
- **WHEN** 用户在配置弹窗输入工作目录并保存
- **THEN** 存入 UserDefaults key=`agent_cwd:{daemonId}:{agentType}`
- **AND** 关闭弹窗

#### Scenario: 清空工作目录
- **WHEN** 用户清空输入并保存
- **THEN** 删除对应 UserDefaults key

### Requirement: 不提供添加 Agent
AgentManageView SHALL NOT 提供远程安装 agent 的入口（"添加 Agent"按钮已从设计稿移除）。agent 列表仅来自 daemon 实际安装的 agents。

#### Scenario: 仅展示已安装 agent
- **WHEN** 渲染 agent 列表
- **THEN** 只显示 `daemon_status` 上报的 agents
- **AND** 不存在"添加 Agent"按钮

### Requirement: 全部/可升级筛选
AgentManageView SHALL 提供筛选切换：显示全部 agent 或仅显示可升级 agent。

#### Scenario: 切换到可升级
- **WHEN** 用户点击"可升级"
- **THEN** 仅显示 `version != latest` 的 agent

#### Scenario: 切换到全部
- **WHEN** 用户点击"全部"
- **THEN** 显示该 daemon 所有 agent
