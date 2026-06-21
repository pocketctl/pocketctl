## Purpose

iOS 主机列表页增强（还原 `daemon-list.html`）+ 设置页主机列表（还原 `settings.html`）。主机卡新增概览状态卡、Agent 标签带版本、四项功能入口、最近会话、⋯ 操作菜单。复用后端 daemon restart/forceKick/delete 接口。

## ADDED Requirements

### Requirement: 概览状态卡
DaemonListView SHALL 在顶部显示概览卡：在线数 / 离线数 / 今日 Token / 活跃会话数。

#### Scenario: 概览数值
- **WHEN** 页面加载
- **THEN** 在线/离线数从 daemons 计算
- **AND** 今日 Token 来自 `summary.today`
- **AND** 活跃会话数从非终态 sessions 计算

### Requirement: Agent 标签带版本
主机卡 SHALL 显示该 daemon 的 agent 标签（来自 `daemon.agents[]`），并标注版本号与可升级提示。

#### Scenario: 标签带版本
- **WHEN** 渲染在线主机卡
- **THEN** 每个 agent 显示为 chip + 版本号（如 Claude Code v2.4.0）
- **AND** 存在可升级 agent 时显示橙色提示

### Requirement: 四项功能入口
主机卡 SHALL 提供功能列表行：会话列表 / 新建会话 / Token 消耗 / Agent 管理，各带 value 与 chevron。

#### Scenario: 功能行 value
- **WHEN** 渲染功能行
- **THEN** 会话列表显示"N 活跃 · M 历史"
- **AND** Token 消耗显示"X 总 · Y 今日"
- **AND** Agent 管理显示"N 个 · M 可升级"

#### Scenario: 离线主机禁用
- **WHEN** 主机离线
- **THEN** 新建会话 / Agent 管理行灰化禁用（显示"主机离线"）
- **AND** Token 消耗仍可点击

### Requirement: 最近会话区
DaemonListView SHALL 显示最近会话区（取最近 N 条 sessions）。

#### Scenario: 最近会话
- **WHEN** 有会话
- **THEN** 显示最近 3 条会话（状态点 + title + 主机 + 相对时间）
- **AND** 点击跳转会话详情

### Requirement: ⋯ 操作菜单
主机卡 ⋯ 按钮 SHALL 弹出底部操作菜单：重启 daemon / 编辑别名 / 强制踢下线 / 注销主机。

#### Scenario: 重启 daemon
- **WHEN** 用户选"重启 daemon"
- **THEN** 调 `POST /api/daemons/:id/restart`，显示重启中提示

#### Scenario: 编辑别名
- **WHEN** 用户选"编辑别名"
- **THEN** 展开内联别名输入行（复用现有 rename 逻辑）

#### Scenario: 强制踢下线
- **WHEN** 用户选"强制踢下线"
- **THEN** 二次确认后调 `POST /api/daemons/:id/forceKick`
- **AND** 遇 429（3 次/小时限流）显示限流提示

#### Scenario: 注销主机
- **WHEN** 用户选"注销主机"
- **THEN** 二次确认后调 `DELETE /api/daemons/:id`
- **AND** 从列表移除该主机

### Requirement: 设置页主机列表
SettingsView "我的主机"区 SHALL 列出每台主机（在线/离线 chip + hostname），点击跳转 DaemonListView。

#### Scenario: 主机列表渲染
- **WHEN** 设置页加载
- **THEN** 列出所有 daemon（hostname/alias + 在线/离线 chip）

### Requirement: 设置页用量分析入口
SettingsView "其他"区 SHALL 新增"用量分析"行，点击进入全局 TokenUsageView。

#### Scenario: 进入用量分析
- **WHEN** 用户点击"用量分析"
- **THEN** push TokenUsageView（全局入口，无 daemonId）
