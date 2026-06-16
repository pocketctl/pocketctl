## MODIFIED Requirements

### Requirement: Web-created sessions can be resumed in terminal
Web 客户端 SHALL 提供「恢复会话命令」入口（**两处**：SessionActions 列表卡片 ⋮ 菜单 + SessionDetail 详情页 header），点击**复制到粘贴板**一个可在主机终端粘贴运行的完整命令（仅复制 + toast，无 dialog）。命令格式：`cd "<cwd>" && <agent resume <session-id>>`，按 `session.agent` 映射：
- `claude-code` → `claude --resume <session-id>`
- `codex` → `codex resume <session-id>`
- `opencode` → **暂隐藏入口**（后续支持 `opencode -s <session-id>`）

cwd SHALL 用引号包裹（`"<cwd>"`，防空格/特殊字符）；session 无 cwd 时 fallback `cd ~`。复制后显示 toast「已复制恢复命令 — 在主机终端粘贴运行」。命令 SHALL 由共享的 `buildResumeCommand(session)` 工具函数构建（SessionActions 与 SessionDetail 复用，避免逻辑重复）。

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
- **AND** 后续支持时加 `opencode -s <session-id>` 分支

#### Scenario: 无 cwd 时 fallback
- **WHEN** session 无 cwd（cwd 为空）
- **THEN** 命令使用 `cd ~ && <agent resume>`

#### Scenario: cwd 含空格用引号包裹
- **WHEN** cwd=/Users/x/My Project
- **THEN** 命令 `cd "/Users/x/My Project" && claude --resume <sid>`（引号包裹防空格破坏命令）

#### Scenario: 用户在终端运行恢复命令
- **WHEN** 用户在主机终端粘贴运行 `cd "<cwd>" && claude --resume <session-id>`
- **THEN** agent CLI 加载该 session 的完整历史（含 web 发送的消息），会话在终端继续
