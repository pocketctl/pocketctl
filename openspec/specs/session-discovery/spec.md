## Purpose
daemon 发现用户在终端启动的 Claude Code session，解析 + tail 其 JSONL 历史，监控进程存活，生成标题——让终端 claude 能被 web/app 看到（session-bridge 的核心 capability）。

## Requirements

### Requirement: Daemon discovers terminal-started Claude Code sessions
Daemon SHALL monitor `~/.claude/sessions/` directory for new or changed JSON files. Each file represents an active Claude Code session with fields: `pid`, `sessionId`, `cwd`, `status`, `startedAt`.

#### Scenario: User starts claude in terminal
- **WHEN** user runs `claude` in a terminal and Claude Code writes a new `<pid>.json` file to `~/.claude/sessions/`
- **THEN** daemon detects the new file within 2 seconds, reads the session metadata (sessionId, cwd, pid), and registers the session with source=`terminal`

#### Scenario: Daemon startup with existing active sessions
- **WHEN** daemon starts and there are already JSON files in `~/.claude/sessions/`
- **THEN** daemon scans all existing files and registers each active session within 5 seconds

### Requirement: Daemon parses Claude Code JSONL history files
Daemon SHALL parse `~/.claude/projects/<encoded-path>/<session-id>.jsonl` files to extract conversation events. The adapter SHALL convert JSONL entries to pocketctl DaemonEvent format:
- `type: "assistant"` with `content: [{type: "text"}]` → `agent_text` event
- `type: "assistant"` with `content: [{type: "tool_use"}]` → `tool_call` event
- `type: "user"` with `content: [{type: "tool_result"}]` → `tool_result` event

#### Scenario: Parse a complete conversation turn
- **WHEN** daemon reads a JSONL file containing a user message, assistant text, tool call, and tool result
- **THEN** each entry is converted to the corresponding DaemonEvent type and sent to the output channel

#### Scenario: Skip non-essential JSONL entries
- **WHEN** daemon encounters entries with `type: "mode"`, `type: "permission-mode"`, `type: "file-history-snapshot"`, `type: "attachment"`, or `type: "assistant"` with `content: [{type: "thinking"}]`
- **THEN** these entries SHALL be silently skipped without generating events

### Requirement: Daemon tails JSONL files for real-time sync
Daemon SHALL track the file offset of each monitored JSONL file and periodically read new lines. New lines SHALL be parsed and sent as events to the relay.

#### Scenario: Agent generates output during active session
- **WHEN** the terminal claude process appends new lines to the JSONL file
- **THEN** daemon reads and parses the new lines within 1 second and sends DaemonEvents to the relay

#### Scenario: Session JSONL file grows large
- **WHEN** a JSONL file exceeds 5MB during a long session
- **THEN** daemon continues to tail only new content without re-reading the entire file

### Requirement: Daemon monitors terminal process status
Daemon SHALL periodically check whether the terminal Claude Code process (identified by PID from sessions file) is still running. Process status SHALL be reported as a session attribute.

#### Scenario: Terminal claude process is still running
- **WHEN** daemon checks the PID and the process exists
- **THEN** session status SHALL be `busy` and web clients SHALL see the session as read-only

#### Scenario: Terminal claude process has exited
- **WHEN** daemon checks the PID and the process no longer exists
- **THEN** session status SHALL change to `idle` (available for cross-device handoff)

#### Scenario: Sessions file is deleted
- **WHEN** the `<pid>.json` file is removed from `~/.claude/sessions/`
- **THEN** daemon detects the removal and marks the session as `idle`

### Requirement: Sessions table includes title and source
The relay's sessions table SHALL include a `title` column (TEXT, nullable) and a `source` column (VARCHAR, default `'daemon'`). Terminal-discovered sessions SHALL have source=`terminal`.

#### Scenario: Terminal session appears in session list
- **WHEN** daemon registers a terminal-discovered session
- **THEN** the session appears in the web session list with source=`terminal` and a title derived from the first user message

### Requirement: Session title auto-generation
Daemon SHALL generate a readable title for each session by extracting the first user message from the JSONL file, truncated to 60 characters.

#### Scenario: Session with user message
- **WHEN** daemon discovers a session with a first user message "实现用户认证模块 - 添加 JWT 登录"
- **THEN** the session title SHALL be "实现用户认证模块 - 添加 JWT 登录" (or truncated to 60 chars if longer)

#### Scenario: Session with no user message yet
- **WHEN** daemon discovers a session that has not yet written a user message to JSONL
- **THEN** the title SHALL be "Terminal Session" as placeholder, updated when the first user message appears

### Requirement: 终端会话发现按 agent 分发

daemon 的终端会话发现 SHALL 按 agent 类型分发，而非仅 claude 的 `~/.claude/sessions/` 约定。
claude-code 经 `SessionWatcher`（fsnotify sidecar）发现；opencode 经其专用发现器
（见下）。现有 claude-code 的发现行为 SHALL 保持不变。

#### Scenario: 多 agent 并存发现

- **WHEN** 用户在不同终端分别运行 claude 与 opencode
- **THEN** daemon SHALL 分别经各自发现器登记会话
- **AND** 每个会话 SHALL 携带正确的 `agent` 类型与 `Source: terminal`

### Requirement: daemon 发现终端启动的 opencode 会话

daemon SHALL 经其托管的共享 `opencode serve` 轮询 `GET /api/session` 来发现终端启动的会话
（opencode 会话存于 SQLite、事件总线为进程内，故不走文件监视），按 `time.updated` 新鲜度过滤
（避免登记历史会话），登记为 `Source: terminal`、`agent: opencode`，cwd/title 取自会话记录。
opencode 会话 SHALL NOT 依赖 pid sidecar（opencode 不提供）。

#### Scenario: 用户在终端启动 opencode

- **WHEN** 用户运行 `opencode` 并创建会话
- **THEN** daemon SHALL 在数秒内经 `GET /api/session` 轮询发现并登记该会话（cwd/title 取自记录，source=`terminal`，agent=`opencode`）

#### Scenario: daemon 启动时已有 opencode 会话

- **WHEN** daemon 启动且 DB 中已存在 opencode 会话
- **THEN** daemon SHALL 仅登记近期活跃（新鲜度窗口内）的会话，不 flood 历史会话

### Requirement: daemon 经 serve API 轮询实时同步 opencode 会话

daemon SHALL 对每个已发现的 opencode 终端会话轮询 `GET /session/{id}/message`，增量差分出新
消息/part，转换为 DaemonEvent 实时转发（约 1 秒级，等价 claude/codex 的 JSONL tail 节奏）。

#### Scenario: opencode 终端会话产生输出

- **WHEN** 终端 opencode 进程为某会话产生新消息
- **THEN** daemon SHALL 在约 1 秒内差分并转换为 `user_text` / `agent_text` / `tool_call` / `tool_result` / 用量事件转发到 relay

### Requirement: opencode 会话存活判定不依赖 pid

由于 opencode 不写 pid sidecar，daemon SHALL 依据会话消息历史（最新消息是否为未完成的
assistant）推导其 `running` / `idle` 状态，并据此决定客户端能否续聊。掉出实时同步窗口的
`running` 会话 SHALL 被一次性对账为 `idle`。

#### Scenario: 终端会话活跃中

- **WHEN** 某 opencode 会话的最新消息是未完成的 assistant（正在生成）
- **THEN** 会话状态 SHALL 为 `running`，续聊请求被拒绝以避免撞车

#### Scenario: 终端会话已空闲

- **WHEN** 某 opencode 会话的最新消息是已完成的 assistant，或会话已掉出同步窗口
- **THEN** 会话状态 SHALL 为 `idle`，可供跨设备续聊
