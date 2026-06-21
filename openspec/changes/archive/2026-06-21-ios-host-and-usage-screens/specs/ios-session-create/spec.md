## Purpose

iOS 新建会话增强（对齐 web `NewSessionDialog`）：动态模型选择、工作目录本地回填（per-daemon-agent）、权限模式选择器、失败 banner + 15s 超时兜底。复用后端 `list_models`→`model_list`、`session_create` 带 `model`/`permission_mode`、`session_create_failed` 事件、`abort_create`。

## ADDED Requirements

### Requirement: 动态模型选择
NewSessionSheet 选定主机后 SHALL 发 `list_models`，收 `model_list` 填充模型 Picker；默认空（跟随主机 `~/.claude` 默认）。

#### Scenario: 拉取主机模型
- **WHEN** 用户选定主机
- **THEN** 发 `{type:'list_models', daemon_id}`
- **AND** 收 `model_list` 后填充模型选项（来自主机真实 `~/.claude/settings.json`）

#### Scenario: 默认跟随主机
- **WHEN** 用户不选模型
- **THEN** `session_create` 不带 model（空=主机默认）

#### Scenario: 选定模型
- **WHEN** 用户选某 model（opus/sonnet/haiku alias）
- **THEN** `session_create` 带 `model=alias`

### Requirement: 工作目录本地回填
NewSessionSheet 的工作目录 SHALL 回填 per-daemon-agent 的 UserDefaults 默认值，提交时保存。

#### Scenario: 回填默认 cwd
- **WHEN** 打开新建会话且已选 agent
- **THEN** 工作目录输入框预填 `AgentDefaultsStore[daemonId][agentType]`

#### Scenario: 提交保存 cwd
- **WHEN** 用户提交会话
- **THEN** 将当前工作目录存入 AgentDefaultsStore（per-daemon-agent）

### Requirement: 权限模式选择器
NewSessionSheet SHALL 提供 4 个权限模式选项（bypassPermissions / default / acceptEdits / plan），默认 acceptEdits。

#### Scenario: 默认 acceptEdits
- **WHEN** 打开新建会话
- **THEN** 权限模式默认选中 acceptEdits

#### Scenario: 选择并传入
- **WHEN** 用户选某权限模式
- **THEN** `session_create` 带 `permission_mode=<mode>`

### Requirement: session_create 完整参数
提交 SHALL 发送 `{type:'session_create', daemon_id, agent, cwd, prompt, model, permission_mode}`。

#### Scenario: 完整消息
- **WHEN** 用户点击"开始会话"
- **THEN** 发送 session_create 含 daemon_id / agent / cwd / prompt / model / permission_mode

### Requirement: 三态 loading
提交后按钮 SHALL 进入 SUBMITTING → CONNECTING（pending id）→ SUCCESS（真实 id）/ FAILED。

#### Scenario: SUBMITTING
- **WHEN** 点击开始会话
- **THEN** 按钮显示 spinner + "正在创建…"，禁用

#### Scenario: CONNECTING
- **WHEN** 收到 `session_created`（pending id）
- **THEN** 文案切为"正在连接主机…"

#### Scenario: SUCCESS
- **WHEN** 收到 `session_id_changed`（真实 id）
- **THEN** 跳转会话详情（真实 id），关闭 sheet

### Requirement: 失败 banner
创建失败 SHALL 显示错误 banner，按 `session_create_failed` 的 reason 显示对应文案。

#### Scenario: 无 claude CLI
- **WHEN** reason=`no_cli`
- **THEN** 显示"主机未安装 Claude Code CLI，请在主机上安装后重试"

#### Scenario: 工作目录无效
- **WHEN** reason=`bad_cwd`
- **THEN** 显示"工作目录不可用：{cwd}，请检查路径与权限"

#### Scenario: 启动失败
- **WHEN** reason=`start_fail`
- **THEN** 显示"Agent 进程启动失败：{err}"

#### Scenario: 主机离线
- **WHEN** reason=`daemon_offline`
- **THEN** 显示"主机离线或无可用 daemon，请确认主机在线后重试"

### Requirement: 15s 超时兜底
15 秒内未收到真实 session_id SHALL 发 `abort_create` 清理已启动进程，并显示超时提示。

#### Scenario: 超时 abort
- **WHEN** 15s 超时
- **THEN** 发 `{type:'abort_create', daemon_id, session_id: pendingId}`
- **AND** 显示"主机连接超时：daemon 未在 15 秒内完成会话初始化"
