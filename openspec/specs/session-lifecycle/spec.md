## ADDED Requirements

### Requirement: Session lifecycle state machine
The system SHALL define a session lifecycle state machine with 8 states: `running`, `waiting_approval`, `idle`, `exited`, `disconnected`, `completed`, `error`, `killed`. The state machine SHALL define valid transitions between states.

When a session is created or discovered, its initial title SHALL be set to `Terminal Session-{sessionID后8位}` (e.g., "Terminal Session-1def4567"). This replaces the previous behavior of setting title to null or "Terminal Session" without a suffix.

When a daemon session is created via `session_create`, the Daemon SHALL resolve the working directory using `resolveCwd()` and validate it before starting the process. If validation fails, the session SHALL NOT be created and an error event SHALL be returned to the client.

#### Scenario: Terminal session full lifecycle
- **WHEN** a terminal session is discovered with a running Claude Code process
- **THEN** state transitions follow: `running` → `idle` → `running` → `idle` → `exited`
- **AND** each transition emits a `session_status` event

#### Scenario: Daemon session full lifecycle
- **WHEN** a daemon-spawned session runs to completion
- **THEN** state transitions follow: `running` → `completed`
- **AND** final state is `completed` with `cost_usd` and `turns` fields

#### Scenario: Invalid state transition rejected
- **WHEN** a session is in `exited` state and an event attempts to set it to `running` without a resume
- **THEN** the transition is rejected and an error is logged

#### Scenario: Terminal session default title
- **WHEN** a terminal session is discovered via `session_discovered` event
- **THEN** the session title is set to `Terminal Session-{sessionID后8位}`

#### Scenario: Daemon session default title
- **WHEN** a daemon session is created via `session_created` event with a title from config.Prompt
- **THEN** the session title is set to the provided prompt value
- **AND** if no title is provided, the title is set to `Terminal Session-{sessionID后8位}`

#### Scenario: Session creation with empty CWD
- **WHEN** a `session_create` request arrives with `cwd: ""`
- **THEN** the Daemon resolves cwd to the user's home directory
- **AND** validates the directory exists and is accessible
- **AND** starts the session process in the home directory

#### Scenario: Session creation with invalid CWD
- **WHEN** a `session_create` request arrives with a cwd that does not exist or is not accessible
- **THEN** the Daemon returns an error event with a descriptive message
- **AND** no session is created
- **AND** no process is started

### Requirement: Valid state transitions
The system SHALL enforce the following valid state transitions:

- `running` → `idle`, `waiting_approval`, `error`, `killed`, `exited`, `completed`
- `idle` → `running`, `exited`
- `waiting_approval` → `running`, `idle`, `exited`
- `exited` → `running` (via resume only)
- `disconnected` → any state (overlay, resolved on daemon reconnect)
- `completed` → (terminal state)
- `error` → (terminal state)
- `killed` → (terminal state)

#### Scenario: Resume from exited state
- **WHEN** user sends a message to a session in `exited` state
- **THEN** session transitions to `running` via the resume mechanism
- **AND** daemon spawns `claude --resume <session_id>` process

#### Scenario: Exited session cannot transition to idle
- **WHEN** a session is in `exited` state
- **THEN** the system SHALL NOT transition it to `idle` without a resume

### Requirement: Exit reason tracking
The system SHALL track an exit reason for sessions that reach `exited` or terminal states. Exit reasons SHALL be one of: `user_interrupt`, `normal_exit`, `process_crash`, `signal_kill`, `unknown`.

#### Scenario: Terminal process exits normally
- **WHEN** a terminal session's Claude Code process exits and the session file shows `status: "idle"`
- **THEN** exit reason is set to `normal_exit`

#### Scenario: Terminal process killed by signal
- **WHEN** daemon kills a session with SIGTERM or SIGKILL
- **THEN** exit reason is set to `signal_kill`

#### Scenario: Exit reason unknown
- **WHEN** a terminal session's process exits and no exit code or signal information is available
- **THEN** exit reason is set to `unknown`

#### Scenario: User interrupt detection
- **WHEN** a terminal session's process exits with SIGINT (exit code 130 or signal 2)
- **THEN** exit reason is set to `user_interrupt`

### Requirement: Daemon online status affects session display
When a daemon goes offline, its sessions SHALL be displayed as `disconnected` in the web UI. When the daemon comes back online, the sessions SHALL revert to their actual persisted status.

#### Scenario: Daemon goes offline
- **WHEN** relay detects daemon WebSocket disconnect
- **THEN** relay broadcasts `daemon_status` event with `status: "offline"` to all clients
- **AND** web UI displays all sessions belonging to that daemon as `disconnected`

#### Scenario: Daemon comes back online
- **WHEN** daemon reconnects and re-registers with relay
- **THEN** relay broadcasts `daemon_status` event with `status: "online"` to all clients
- **AND** daemon reports actual session states
- **AND** web UI reverts sessions to their real status

#### Scenario: Daemon offline overlay not persisted
- **WHEN** daemon goes offline and web client refreshes the page
- **THEN** sessions are loaded from DB with their real status
- **AND** web client applies `disconnected` overlay locally after receiving `daemon_status: offline`

### Requirement: Last activity timestamp
Each session SHALL track a `last_activity_at` timestamp that updates whenever a session event is received. The `last_activity_at` SHALL be displayed in the web UI as a relative time string.

#### Scenario: Activity timestamp updated on event
- **WHEN** daemon sends any event for a session (agent_text, tool_call, session_status, etc.)
- **THEN** `last_activity_at` is updated to the current timestamp
- **AND** web UI displays the relative time (e.g., "3分钟前")

#### Scenario: Session list sorted by last activity
- **WHEN** user views the session list
- **THEN** sessions are sorted by `last_activity_at` descending (most recent first)

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
