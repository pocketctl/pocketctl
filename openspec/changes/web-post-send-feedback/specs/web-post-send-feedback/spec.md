## ADDED Requirements

### Requirement: 提交消息后立即乐观回显用户消息
web 客户端 SHALL 在用户提交消息的同一帧把用户消息气泡加入消息列表（乐观更新），不等 relay 回传 `user_text` 事件。relay 回传的 `user_text` 事件 SHALL 由现有 `isDuplicate` 机制去重，不得产生重复气泡。

#### Scenario: 提交后立即看到自己的消息
- **WHEN** 用户在输入框提交消息
- **THEN** 用户消息气泡 SHALL 在提交瞬间（同一帧）淡入出现于消息列表
- **AND** 不等待 relay 回传

#### Scenario: relay 回传不产生重复
- **WHEN** relay 回传该消息的 `user_text` 事件
- **THEN** `isDuplicate` SHALL 跳过，不新增气泡

### Requirement: PTY session 处理用户消息时发送 running 状态
daemon 对 PTY（web/daemon）session，SHALL 在把用户消息写入 claude 的 PTY stdin 时发送 `session_status=running` 事件（与现有 `user_text` 一同），让前端在整个模型处理期间显示「工作中」反馈。写 stdin 失败时 SHALL 发送 `session_status=error` 回退，不得停留在 running。

#### Scenario: PTY 写 stdin 发 running
- **WHEN** daemon 将用户消息写入 PTY session 的 stdin
- **THEN** SHALL 发送 `session_status=running`
- **AND** 前端 turn-status-bar 进入「工作中」态

#### Scenario: 写 stdin 失败回退
- **WHEN** PTY stdin 写入失败（如 claude 进程已退）
- **THEN** SHALL 发送 `session_status=error`
- **AND** SHALL NOT 停留在 running

### Requirement: 提交后立即显示「正在处理」反馈
web 客户端 SHALL 在 `sendMessage` 瞬间立即显示 turn-status-bar（`awaitingStart` 驱动，脉动圆点 + 「模型正在工作中…」+ 实时计时），不等 daemon 的 running 到达。`awaitingStart` SHALL 在收到 `session_status=running`/busy/waiting 或首个 `agent_text` 事件时清除，由 `isExecuting` 无缝接管。

#### Scenario: 提交瞬间底部反馈出现
- **WHEN** 用户提交消息
- **THEN** turn-status-bar SHALL 立即出现，显示脉动 ● + 「模型正在工作中…」+ 从 0:00 开始的计时
- **AND** 不等 daemon 的 session_status 事件

#### Scenario: running 到达后无缝交接
- **WHEN** 提交后收到首个 `session_status=running`（B 发）或首个 agent_text
- **THEN** `awaitingStart` SHALL 清除
- **AND** bar 继续由 `isExecuting` 驱动显示，视觉无中断

#### Scenario: 会话切换重置
- **WHEN** 用户切换到另一个会话
- **THEN** `awaitingStart` SHALL 重置为 false，不把上一会话的即时反馈带入新会话

### Requirement: 发送失败端到端回退
web 客户端 SHALL 通过两层检测发送失败并回退乐观反馈：L1 监听 WebSocket 错误/断开 + send 失败；L2 依赖 relay 对 `user_message` 的 ack/nack + 超时。任一触发（含 daemon 写 stdin 的 error）SHALL 移除乐观气泡、清除 `awaitingStart`，并向用户提示发送失败。

#### Scenario: WebSocket 断开回退（L1）
- **WHEN** 用户提交消息后 WebSocket 断开或 send 失败
- **THEN** 乐观气泡 SHALL 被移除，`awaitingStart` SHALL 清除
- **AND** SHALL 提示发送失败

#### Scenario: daemon 离线回退（L2 nack）
- **WHEN** relay 收到 `user_message` 但目标 daemon 离线
- **THEN** relay SHALL 回 nack
- **AND** web SHALL 回退乐观气泡 + 提示

#### Scenario: ack 超时回退（L2）
- **WHEN** 用户提交后 N 秒内未收到 ack/nack
- **THEN** web SHALL 回退乐观气泡 + 提示发送失败

#### Scenario: daemon 写 stdin 失败回退（B error）
- **WHEN** daemon 收到消息但写 PTY stdin 失败（claude 已退）
- **THEN** daemon SHALL 发 `session_status=error`
- **AND** web SHALL 据此回退乐观气泡 + 提示
