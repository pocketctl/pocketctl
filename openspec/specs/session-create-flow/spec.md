## Purpose
web 新建会话的完整前端 loading 状态机与失败处理，还原设计稿 dashboard.html / session-detail.html 的交互（三态 loading、五种失败 banner、超时清理、SessionDetail 兜底）。

## ADDED Requirements

### Requirement: 新建会话弹窗 loading 状态机
点击"开始会话"后，弹窗按钮 SHALL 进入三态 loading：IDLE → SUBMITTING → CONNECTING → SUCCESS/FAILED，复用设计稿 dashboard.html 的 `.is-loading` / `.btn-loading` spinner 样式。

#### Scenario: SUBMITTING 态
- **WHEN** 用户点击"开始会话"且已选主机
- **THEN** 按钮加 `.is-loading` 类，隐藏默认文案，显示白色 spinner + "正在创建…"
- **AND** 按钮禁用，`.modal-body.is-loading` 灰化表单（opacity 0.5, pointer-events none）
- **AND** 发送 `{type:'session_create', daemon_id, agent, cwd, prompt}`

#### Scenario: CONNECTING 态
- **WHEN** 收到 `session_created`（pending ID）
- **THEN** loading 文案切为 "正在连接主机 {host}…"
- **AND** 不跳转，保持弹窗 loading 态

#### Scenario: SUCCESS 态
- **WHEN** 收到 `session_id_changed`（真实 ID）
- **THEN** `router.replace('/session/' + 真实ID)`，关闭弹窗
- **AND** URL 使用真实 session_id，不卡 pending

### Requirement: 新建会话失败 banner
创建失败时 SHALL 显示 `.modal-error.visible` 红色 banner（err-icon + err-title + err-desc + err-close），覆盖五种失败场景。

#### Scenario: 无 claude CLI
- **WHEN** Daemon 返回 `session_create_failed` reason=`no_cli`
- **THEN** 显示 banner，标题"无法在「{host}」上创建会话"，描述"主机未安装 Claude Code CLI，请在主机上安装后重试"

#### Scenario: 工作目录无效
- **WHEN** Daemon 返回 `session_create_failed` reason=`bad_cwd`
- **THEN** 描述"工作目录不可用：{cwd}，请检查路径与权限"

#### Scenario: 进程启动失败
- **WHEN** Daemon 返回 `session_create_failed` reason=`start_fail`
- **THEN** 描述"Agent 进程启动失败：{err}"

#### Scenario: 主机连接超时
- **WHEN** 15 秒内未收到 session_id_changed
- **THEN** 前端发送 `abort_create`，显示描述"主机连接超时：daemon 未在 15 秒内完成会话初始化。请确认主机在线、daemon 与 claude CLI 运行正常后重试"

#### Scenario: 主机离线
- **WHEN** Relay 返回 `session_create_failed` reason=`daemon_offline`
- **THEN** 描述"主机离线或无可用的 daemon，请确认主机在线后重试"

### Requirement: 超时清理已启动进程
前端超时后 SHALL 发送 `abort_create`，Daemon 收到后 kill claude 子进程并清理 pending session，避免 token 烧费。

#### Scenario: 超时触发 abort
- **WHEN** 前端 15s 超时
- **THEN** 发送 `{type:'abort_create', daemon_id, session_id: pendingId}`
- **AND** Daemon 调用 AbortSession(pendingId) 杀死 claude 进程
- **AND** 清理 session map 中的 pending 记录

### Requirement: SessionDetail 兜底 session_id_changed
会话详情页 SHALL 监听 `session_id_changed`，当 URL 仍是 pending ID 时 `router.replace` 到真实 ID。

#### Scenario: 刷新 pending URL
- **WHEN** 用户在 `/session/pending-xxx` 刷新页面
- **AND** 收到 `session_id_changed` old=pending-xxx, new=real-uuid
- **THEN** `router.replace('/session/real-uuid')`
- **AND** 重新 replay 真实 ID 的历史事件
