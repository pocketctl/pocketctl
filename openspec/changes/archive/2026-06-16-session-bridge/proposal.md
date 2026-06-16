## Why

用户在 Mac 终端使用 Claude Code 进行长时间交互式工作时，离开电脑后无法在其他设备（手机/App/Web）查看进展或继续对话。pocketctl 当前只能管理自己启动的 session，对用户直接在终端运行的 `claude` 完全不可见。需要一种机制，让终端中自然运行的 Claude Code session 能被 pocketctl 发现、同步、并在其他设备上继续。

## What Changes

- **新增 Session Watcher**：daemon 后台监听 `~/.claude/sessions/` 目录，自动发现用户直接在终端启动的 Claude Code session
- **新增 JSONL Parser**：解析 Claude Code 的 JSONL 历史文件格式，转换为 pocketctl 统一的 DaemonEvent 事件
- **新增 JSONL Tailer**：实时追踪 JSONL 文件变化，增量读取新增行，实现终端→Web 实时同步
- **新增 Process Monitor**：检测终端 claude 进程存活状态，判断 session 是否可被 Web 端接管
- **改造 SendMessage**：区分 "daemon 管理的 session" 和 "终端发现的 session"，终端 session 在进程运行时只读，结束后可通过 `--resume` 接管
- **新增 Session 标题**：自动生成可读的 session 标题（取首条用户消息摘要），替代显示 UUID
- **Web 前端适配**：session 列表显示标题和来源标签，session detail 区分只读/可交互模式
- **DB schema 变更**：sessions 表新增 `title` 和 `source` 字段

## Capabilities

### New Capabilities
- `session-discovery`: 发现并同步用户直接在终端运行的 Claude Code session，包括 JSONL 解析、实时 tail、进程状态监控
- `cross-device-handoff`: 跨设备 session 接力 — 终端 session 结束后从 App/Web 继续发送消息，App/Web 创建的 session 在终端通过 `claude --resume` 恢复

### Modified Capabilities
（无现有 spec 需要修改）

## Impact

- **Go daemon**：新增 `internal/watcher/` 包（watcher + tailer + process monitor），新增 `internal/adapter/claude_jsonl.go`，修改 `internal/session/manager.go` 和 `internal/protocol/types.go`
- **Relay**：`relay/src/db.ts` schema 变更（新增列），`relay/src/router.ts` 适配新事件类型
- **Web 前端**：`SessionList.vue`（标题、来源标签）、`SessionDetail.vue`（只读/可交互模式切换）
- **依赖**：可能需要 `fsnotify` 库（Go 文件系统监听）
- **无 breaking change**：现有 daemon 管理的 session 行为不变
