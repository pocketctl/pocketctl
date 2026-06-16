## 1. DB Schema & Protocol

- [x] 1.1 relay `db.ts`: sessions 表新增 `title TEXT` 和 `source VARCHAR(16) DEFAULT 'daemon'` 列，更新 `initDB` migration
- [x] 1.2 relay `db.ts`: `upsertSession` 函数接受 `title` 和 `source` 参数，`listSessions` 返回包含 `title` 和 `source` 字段
- [x] 1.3 daemon `protocol/types.go`: DaemonEvent 新增 `Source string` 和 `Title string` 字段；新增事件类型常量 `EventSessionDiscovered = "session_discovered"`

## 2. JSONL Parser Adapter

- [x] 2.1 daemon `internal/adapter/claude_jsonl.go`: 定义 JSONL 条目结构体（JSONLEntry），包含 type、message.role、message.content 数组
- [x] 2.2 daemon `internal/adapter/claude_jsonl.go`: 实现 `ParseJSONLLine(line string) ([]protocol.DaemonEvent, error)` 函数，映射 assistant/text → agent_text、assistant/tool_use → tool_call、user/tool_result → tool_result
- [x] 2.3 daemon `internal/adapter/claude_jsonl.go`: 实现 `ExtractFirstUserMessage(lines []string) string` 工具函数，从 JSONL 行中提取第一条用户消息内容
- [x] 2.4 为 JSONL parser 编写单元测试，覆盖各事件类型转换和跳过逻辑

## 3. Session Watcher

- [x] 3.1 添加 `fsnotify` 依赖（`go get github.com/fsnotify/fsnotify`）
- [x] 3.2 daemon `internal/watcher/watcher.go`: 实现 `SessionWatcher` 结构体，用 fsnotify 监听 `~/.claude/sessions/` 目录
- [x] 3.3 daemon `internal/watcher/watcher.go`: 实现启动扫描 `scanExisting()`，读取所有 `*.json` 文件并返回活跃 session 列表
- [x] 3.4 daemon `internal/watcher/watcher.go`: 解析 sessions JSON 文件，提取 pid、sessionId、cwd、status 字段
- [x] 3.5 daemon `internal/watcher/watcher.go`: 实现事件回调机制，新 session 发现时通过 channel 通知

## 4. JSONL Tailer

- [x] 4.1 daemon `internal/watcher/tailer.go`: 实现 `JSONLTailer` 结构体，为每个 session 维护 `fileOffset`，提供 `TailNewLines()` 方法返回新增行
- [x] 4.2 daemon `internal/watcher/tailer.go`: 实现 JSONL 文件路径解析 `sessionID → ~/.claude/projects/<encoded-cwd>/<sessionID>.jsonl`
- [x] 4.3 daemon `internal/watcher/tailer.go`: 初始加载时从文件末尾开始 tail（避免加载大量历史），或提供 `LoadFrom(offset int64)` 方法

## 5. Process Monitor

- [x] 5.1 daemon `internal/watcher/process.go`: 实现 `IsProcessAlive(pid int) bool`，使用 `syscall.Kill(pid, 0)` 检查
- [x] 5.2 daemon `internal/watcher/process.go`: 实现 `ProcessMonitor` 结构体，定期（每 2 秒）检查已注册 PID 的存活状态，通过 channel 发送状态变化通知

## 6. Session Manager 改造

- [x] 6.1 daemon `session/manager.go`: `ProcessState` 新增 `Source string`（`daemon` / `terminal`）、`Pid int`（终端 session 的进程 ID）字段
- [x] 6.2 daemon `session/manager.go`: 新增 `RegisterTerminalSession(sessionID, cwd string, pid int)` 方法，注册终端发现的 session
- [x] 6.3 daemon `session/manager.go`: 修改 `SendMessage`，终端 session 在进程存活时返回 `error "session busy in terminal"`，进程退出后用 `--resume` 接管
- [x] 6.4 daemon `session/manager.go`: 新增 `UpdateTitle(sessionID, title string)` 方法，更新 session 标题并发送事件

## 7. Daemon 主循环集成

- [x] 7.1 daemon `cmd/pocketctl/main.go`: 启动 SessionWatcher，订阅发现事件
- [x] 7.2 daemon `cmd/pocketctl/main.go`: 发现新 session 时调用 `RegisterTerminalSession`，发送 `session_discovered` 事件到 relay
- [x] 7.3 daemon `cmd/pocketctl/main.go`: 启动 JSONL Tailer goroutine，解析新行并发送 DaemonEvent
- [x] 7.4 daemon `cmd/pocketctl/main.go`: 启动 ProcessMonitor goroutine，检测进程退出并更新 session 状态为 `idle`
- [x] 7.5 daemon `cmd/pocketctl/main.go`: 检测到第一条 user 消息时调用 `UpdateTitle` 更新标题

## 8. Relay 路由适配

- [x] 8.1 relay `router.ts`: 处理 `session_discovered` 事件，将 session 注册到 sessions 表（source=terminal），并广播给订阅的 clients
- [x] 8.2 relay `router.ts`: 处理 `session_title_update` 事件，更新 sessions 表的 title 字段
- [x] 8.3 relay `router.ts`: `handleClientMessage` 中 `user_message` 到终端 session 且 busy 时，relay 转发 daemon 的 error 到 client

## 9. Web 前端

- [x] 9.1 `SessionList.vue`: 显示 session 的 `title` 字段作为主标题，UUID 折叠为副标题
- [x] 9.2 `SessionList.vue`: 显示来源标签（terminal 显示 "📺 终端" 标签，daemon 显示 "🌐 Web" 标签）
- [x] 9.3 `SessionDetail.vue`: 处理 `session_discovered` 和 `session_status` 事件中的 source/busy 状态，busy 时禁用输入框并显示 "终端正在使用此 session"
- [x] 9.4 `SessionDetail.vue`: 进程结束后（状态变为 idle/completed）自动启用输入框并显示 "可以发消息了"
- [x] 9.5 `SessionDetail.vue`: 新增 "在终端继续" 按钮，点击显示 `claude --resume <session-id>` 可复制命令

## 10. 端到端验证

- [x] 10.1 重建 Docker 镜像（relay + web），重启 daemon，确认所有服务正常
- [x] 10.2 验证终端 session 发现：在终端运行 `claude`，Web 页面自动出现该 session
- [x] 10.3 验证实时同步：终端 agent 工作时，Web 页面实时显示 agent_text/tool_call/tool_result
- [x] 10.4 验证 Wait & Notify：终端 session busy 时 Web 禁用输入，进程结束后自动启用
- [x] 10.5 验证跨设备接力：终端 session 结束后从 Web 发消息，daemon 用 `--resume` 接管
- [x] 10.6 验证终端恢复：在终端运行 `claude --resume <id>` 或 `claude -c`，能看到 Web 端发的消息
