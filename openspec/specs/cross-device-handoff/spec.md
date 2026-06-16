## Purpose
跨设备 session 接力：终端 session 结束后从 web/app 继续发消息（--resume 接管）；web 创建的 session 在终端用 `claude --resume` 恢复。终端 session 运行时 web 只读（session-bridge capability）。

## ADDED Requirements

### Requirement: Web shows terminal sessions as read-only when process is alive
When a terminal-discovered session has an active process (PID alive), the web session detail page SHALL disable the message input and show a status indicator.

#### Scenario: User opens busy terminal session on web
- **WHEN** user navigates to a terminal session that has an active claude process
- **THEN** the input area SHALL show "终端正在使用此 session" with a disabled input field, and the user can still see real-time events

#### Scenario: Terminal process ends while user is viewing
- **WHEN** the terminal claude process exits while the user has the session detail page open
- **THEN** the input area SHALL become enabled and show "可以发消息了" without requiring a page refresh

### Requirement: App/Web can send messages to idle terminal sessions
When a terminal-discovered session's process has exited, daemon SHALL accept user messages from web clients. The message SHALL be sent by spawning a new `claude -p "<message>" --resume <session-id> --output-format stream-json` process.

#### Scenario: Send follow-up message after terminal session ends
- **WHEN** user sends a message from web to a terminal session whose process has exited
- **THEN** daemon starts a new claude process with `--resume <session-id>`, the response streams back to the web client, and the session status returns to `busy`

#### Scenario: Attempt to send message to busy terminal session
- **WHEN** user tries to send a message from web to a terminal session whose process is still alive
- **THEN** daemon returns an error "session busy in terminal" and the web shows the error to the user

### Requirement: Web-created sessions can be resumed in terminal
Web 客户端 SHALL 提供「恢复会话命令」入口（**两处**：SessionActions 列表卡片 ⋮ 菜单 + SessionDetail 详情页 header），点击**复制到粘贴板**一个可在主机终端粘贴运行的完整命令（仅复制 + toast，无 dialog）。命令格式：`cd "<cwd>" && <agent resume <session-id>>`，按 `session.agent` 映射：
- `claude-code` → `claude --resume <session-id>`
- `codex` → `codex resume <session-id>`
- `opencode` → **暂隐藏入口**（后续支持 `opencode -s <session-id>`）

cwd SHALL 用引号包裹（`"<cwd>"`，防空格/特殊字符）；session 无 cwd 时 fallback `cd ~`。复制后显示 toast「已复制恢复命令 — 在主机终端粘贴运行」。命令 SHALL 由共享的 `buildResumeCommand(session)` 工具函数构建（SessionActions 与 SessionDetail 复用）。

#### Scenario: claude-code 会话复制恢复命令
- **WHEN** 用户在 SessionActions 菜单或 SessionDetail header 点「恢复会话命令」（agent=claude-code, cwd=/Users/x/proj, session_id=abc-123）
- **THEN** 复制到粘贴板：`cd "/Users/x/proj" && claude --resume abc-123`
- **AND** toast「已复制恢复命令 — 在主机终端粘贴运行」

#### Scenario: codex 会话复制恢复命令
- **WHEN** session.agent=codex
- **THEN** 复制：`cd "<cwd>" && codex resume <session-id>`

#### Scenario: opencode 会话暂不显示入口
- **WHEN** session.agent=opencode
- **THEN** 「恢复会话命令」入口隐藏（`v-if="session.agent !== 'opencode'"`）

#### Scenario: 无 cwd fallback + cwd 含空格引号
- **WHEN** session 无 cwd → 命令用 `cd ~`；cwd 含空格 → `cd "<cwd>"`（引号包裹防破坏命令）

#### Scenario: 用户在终端运行恢复命令
- **WHEN** 用户在主机终端粘贴运行 `cd "<cwd>" && claude --resume <session-id>`
- **THEN** agent CLI 加载该 session 完整历史（含 web 发送的消息），会话在终端继续

### Requirement: App/Web sessions from relay persist across daemon restarts
When daemon restarts, it SHALL re-discover terminal sessions by scanning `~/.claude/sessions/` and reconcile with the relay's existing session records.

#### Scenario: Daemon restarts while terminal session is active
- **WHEN** daemon restarts and a terminal claude process is still running
- **THEN** daemon re-discovers the session, resumes tailing the JSONL file from last known offset (or from end if offset unknown), and continues streaming events to relay
