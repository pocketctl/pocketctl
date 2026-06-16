## Why

用户在 web 客户端创建/查看的会话，常想**在主机终端恢复继续**（web→terminal handoff）：终端有完整 local command / skill 支持、更好的交互体验、或想在终端跑自动化。当前 web **无此入口**（cross-device-handoff spec 提过 `claude --resume` 但未实现 UI），且只考虑 claude，未覆盖 codex。

## What Changes

- **SessionActions（列表卡片 ⋮ 菜单）+ SessionDetail（详情页 header）新增「恢复会话命令」入口**
- 点击**复制到粘贴板**：`cd "<cwd>" && <agent resume 命令>`（仅复制 + toast，与"复制会话 ID"一致，无 dialog）
- **agent 命令映射**（按 session.agent）：
  - `claude-code` → `claude --resume <session-id>`
  - `codex` → `codex resume <session-id>`
  - `opencode` → **暂隐藏入口**（后续支持 `opencode -s <session-id>`）
- cwd 引号包裹（`"<cwd>"`，防空格/特殊字符）；session 无 cwd 时 fallback `cd ~`
- 共享 `buildResumeCommand(session)` 工具函数（两组件复用）

## Capabilities

### Modified Capabilities
- `cross-device-handoff`: web session 在终端 resume——扩展为**多 agent 命令映射**（claude/codex）+ cwd 前缀 + 实际复制命令 UI（原 spec 仅 claude `--resume` 且无实现）

## Impact

- **web**：`SessionActions.vue`（菜单项）+ `SessionDetail.vue`（header 按钮）+ 共享 `buildResumeCommand`（utils 或 composable）
- **daemon / relay / protocol**：**不涉及**（纯前端 clipboard，无新 API/事件）
- **无 breaking change**：纯新增入口
- **opencode 后续**：本次 opencode session 隐藏入口，未来加 `opencode -s <sid>` 分支即可
