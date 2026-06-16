## ADDED Requirements

### Requirement: 新建 session pending 阶段命令拦截
Web 客户端 SHALL 在 session 处于 pending-id 阶段（`session_id_changed` 收到真实 ID 前）拦截命令发送（`sendMessage`），避免向 daemon 发送 `--resume pending-xxx` 必然失败的 user_message。input SHALL 在 loading（创建中）状态禁用，从 UI 层杜绝 pending 窗口发命令。

#### Scenario: pending 阶段发命令被拦截
- **WHEN** 新建 session 的 URL 仍为 pending-xxx（`session_id_changed` 未到达）
- **AND** 用户在输入框发命令（如 /model）
- **THEN** `sendMessage` SHALL 拦截（不发送 user_message，或 input 在 loading 态禁用）
- **AND** 给出"会话正在创建"提示

#### Scenario: real-id 阶段命令正常发送
- **WHEN** `session_id_changed` 到达，URL 替换为真实 ID
- **AND** 用户发命令
- **THEN** `sendMessage` 正常发送 user_message（session_id 为真实 ID）
- **AND** daemon 处理并返回 command_receipt

### Requirement: 会话切换 replay 竞态处理
Web 客户端 SHALL 消费 relay 的 `replay_end` 事件收尾会话加载（isLoading），并 SHALL 用 replay 请求序号（req_id）去重 stale 的 `replay_batch` / `replay_end`。切换会话时 SHALL 进入 isLoading 状态，仅当匹配当前 req_id 的 `replay_end` 到达时退出 isLoading。`replay` / `replay_batch` / `replay_end` 消息 SHALL 携带 optional `req_id` 字段（web 生成递增，relay 透传），向后兼容（旧端不传 req_id 则按 session_id fallback 过滤）。

#### Scenario: 快速切换丢弃 stale replay batch
- **WHEN** 用户从 session A 快速切换到 B（A 的 replay 仍在流式返回）
- **THEN** A 的后续 replay_batch（req_id 旧）被 web 按 req_id 过滤丢弃
- **AND** B 的 replay_batch（req_id 新）正常 processEvent
- **AND** 对话内容不串

#### Scenario: replay_end 收尾 isLoading
- **WHEN** 切换到新 session，web 发 replay（req_id=N）并置 isLoading=true
- **AND** 匹配 req_id=N 的 `replay_end` 到达
- **THEN** isLoading 置 false，加载态结束

#### Scenario: replay_end 必被消费不挂起
- **WHEN** relay 发 `replay_end`（无论 events 数量，包括 0）
- **THEN** web SHALL 监听并处理 `replay_end`
- **AND** isLoading 不挂起

#### Scenario: req_id 向后兼容
- **WHEN** relay/daemon 为旧版，replay_batch/replay_end 无 req_id 字段
- **THEN** web 按 session_id 过滤 replay 事件（fallback）
- **AND** 不阻塞加载
