## ADDED Requirements

### Requirement: 终端会话发现按 agent 注册表分发

daemon 的终端会话发现 SHALL 按 agent 注册表分发到各 agent 的发现器，而非硬编码仅 claude 的 `~/.claude/sessions/` 约定。每个 Provider SHALL 声明其终端会话发现方式。现有 claude-code / codex 的发现行为 SHALL 保持不变。

#### Scenario: 多 agent 并存发现

- **WHEN** 用户在不同终端分别运行 claude、codex、opencode
- **THEN** daemon SHALL 分别经各 agent 注册的发现器登记会话
- **AND** 每个会话 SHALL 携带正确的 `agent` 类型与 `Source: terminal`

### Requirement: daemon 发现终端启动的 opencode 会话

daemon SHALL 经 fsnotify 监视 `~/.local/share/opencode/storage/session/<projectHash>/`，在出现新的 `ses_*.json` 时登记会话，从其 meta 读取 `directory`（cwd）、`title`、`time`。opencode 会话 SHALL NOT 依赖 pid sidecar（opencode 不提供）。

#### Scenario: 用户在终端启动 opencode

- **WHEN** 用户运行 `opencode` 并创建会话，opencode 写入 `storage/session/<projectHash>/ses_*.json`
- **THEN** daemon SHALL 在 2 秒内发现该文件并登记会话（cwd/title 来自 meta，source=`terminal`，agent=`opencode`）

#### Scenario: daemon 启动时已有 opencode 会话

- **WHEN** daemon 启动且 storage 中已存在 opencode 会话文件
- **THEN** daemon SHALL 扫描并登记其中近期活跃的会话

### Requirement: daemon 经 DirWatch 实时同步 opencode 会话

daemon SHALL 经 `DirWatch` 监视已发现 opencode 会话的 `storage/message/<sid>/` 与 `storage/part/<msgId>/`，把新增/变更文件整文件读取并按 message `time` 与 part 顺序重组为 DaemonEvent 实时转发。

#### Scenario: opencode 终端会话产生输出

- **WHEN** 终端 opencode 进程为某会话写入新 message/part 文件
- **THEN** daemon SHALL 在 1 秒内读取并转换为 `user_text` / `agent_text` / `tool_call` / `tool_result` / 用量事件转发到 relay

### Requirement: opencode 会话存活判定不依赖 pid

由于 opencode 不写 pid sidecar，daemon SHALL 依据 `session.time.updated` 新鲜度与 serve `GET /api/session/{id}` 状态判定 opencode 会话是否仍被终端活跃占用，用于决定其是否可被客户端续聊。

#### Scenario: 终端会话活跃中

- **WHEN** 某 opencode 会话的 `time.updated` 近期持续刷新或 serve 报其运行中
- **THEN** 会话状态 SHALL 为 `busy`，客户端视其为只读

#### Scenario: 终端会话已空闲

- **WHEN** 某 opencode 会话长时间无更新且 serve 未报其运行
- **THEN** 会话状态 SHALL 变为 `idle`，可供跨设备续聊
