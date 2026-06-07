## Context

pocketctl 当前架构：daemon 通过 `exec.Command` 启动 Claude Code 子进程，读取 stdout（stream-json 格式），解析为 DaemonEvent，发送到 relay。Relay 存储事件到 PostgreSQL，Web 前端通过 WebSocket 订阅事件流。

核心限制：daemon 只能看到自己 spawn 的进程。用户直接在终端运行 `claude` 时，daemon 完全不知道这个 session 的存在。

关键发现：Claude Code 将所有 session 元数据写入 `~/.claude/sessions/<pid>.json`，对话历史写入 `~/.claude/projects/<encoded-path>/<session-id>.jsonl`。这些文件实时更新，可以被外部程序读取。

Claude Code 支持 `--resume <session-id>` 参数恢复之前的 session，这是跨设备接力的基础。

## Goals / Non-Goals

**Goals:**
- 用户照常在终端使用 `claude`，pocketctl 自动发现并同步 session 到 Web/App
- Web/App 可以实时查看终端 session 的进展（agent_text, tool_call, tool_result）
- 终端 session 结束后，Web/App 可以发送后续消息（daemon 用 `--resume` 接管）
- Web 创建的 session 可以在终端通过 `claude --resume <id>` 继续
- Session 列表显示可读标题而非 UUID
- 长时间交互式 session 的实时同步（用户主要使用模式）

**Non-Goals:**
- 不在终端 claude 运行时从 Web "接管"（杀进程）— 选择 Wait & Notify 策略
- 不修改 Claude Code 本身
- 不支持系统推送通知（仅 App 内状态切换）
- 不在 Phase 1 做 AI 生成标题（用首条消息摘要）
- 不做 OpenCode agent 支持（后续 change）

## Decisions

### D1: Session 发现 — fsnotify vs 轮询

**选择：fsnotify + 启动扫描**

用 `fsnotify` 监听 `~/.claude/sessions/` 目录变化，实现准实时发现。启动时扫描已有文件。

**备选方案**：每 2 秒轮询 `~/.claude/sessions/` 目录。更简单但延迟更高、浪费资源。

**理由**：fsnotify 延迟在毫秒级，且只在实际变化时触发。Go 的 `fsnotify` 库成熟稳定。启动扫描覆盖 daemon 重启场景。

### D2: JSONL 实时同步 — tail 模式

**选择：维护文件偏移量 + 定时读新增行**

每个被监控的 session 维护一个 `fileOffset`，每秒检查文件大小是否增长，只读取新增部分。

**备选方案**：fsnotify 监听 JSONL 文件变化。问题：高频写入时事件风暴，且需要处理批量化。

**理由**：简单可靠。Claude Code 追加写入 JSONL，不会修改已有内容，seek + read 是安全的。1 秒延迟对 "看 agent 工作" 场景完全可接受。

### D3: 进程状态检测 — PID 检查 + sessions 文件监听

**选择：双通道检测**

1. 用 `syscall.Kill(pid, 0)` 检查进程是否存活（每 2 秒）
2. fsnotify 监听 sessions 文件变化（status 字段从 busy → idle）
3. sessions 文件删除视为进程退出

**备选方案**：只读 sessions 文件的 status 字段。问题：Claude Code 不一定在等待输入时更新 status 字段（未验证）。

**理由**：PID 检查是确定性的。sessions 文件变化作为补充信号。两者结合最可靠。

### D4: JSONL 解析器 — 独立 adapter

**选择：新增 `internal/adapter/claude_jsonl.go`**

与现有 `claude.go`（解析 stream-json stdout）并列，新文件解析 JSONL 历史格式。两者输出相同的 `[]protocol.DaemonEvent`。

**备选方案**：扩展 `ClaudeAdapter` 支持 JSONL。问题：违反单一职责，两种格式差异较大。

**理由**：清晰分离。stream-json 是 stdout 行格式，JSONL 是文件存储格式。共享 protocol.DaemonEvent 作为输出契约即可。

### D5: 终端 session 的 SendMessage — Wait & Notify

**选择：进程活着 → 返回错误；进程死了 → `--resume` 接管**

当 web 发送 user_message 给终端发现的 session：
- 进程活着：返回 `{type: "error", error: "session busy in terminal"}`
- 进程死了：`exec.Command("claude", "-p", msg, "--resume", sessionID, "--output-format", "stream-json")`

**备选方案**：排队等进程结束后自动发送。复杂度高，且用户可能已经忘了。

**理由**：Wait & Notify 最简单。Web 端实时显示进程状态，用户知道什么时候能发。这是用户明确选择的方案。

### D6: Session 标题 — 首条消息摘要

**选择：取 JSONL 中第一条 `type: "user"` 消息的 content，截断 60 字符**

如果还没有 user 消息，标题为 "Terminal Session"。JSONL tailer 检测到第一条 user 消息时更新标题。

**备选方案**：调用 LLM 生成标题。Phase 1 太重，后续可升级。

**理由**：用户的首条消息通常已经描述了意图，截断后就是很好的标题。零成本，零延迟。

### D7: 新增 watcher 包的位置

**选择：`internal/watcher/` 新包**

包含三个文件：`watcher.go`（session 发现）、`tailer.go`（JSONL 追踪）、`process.go`（PID 检查）。

**理由**：职责清晰，与 `internal/session/`（进程管理）和 `internal/adapter/`（格式解析）解耦。watcher 发现 session → 调用 adapter 解析 → 通知 session manager。

## Risks / Trade-offs

- **[Claude Code JSONL 格式不稳定]** → JSONL 格式可能随 Claude Code 版本更新变化。缓解：解析器做宽容处理，未识别的 type 静默跳过而非报错。
- **[fsnotify 在 macOS 上的可靠性]** → macOS 的 FSEvents 偶尔会丢事件。缓解：启动时全量扫描 + 定期（30s）扫描兜底。
- **[JSONL 文件很大（长时间 session）]** → 当前有 3.8MB 的文件。缓解：只 tail 新增部分，初始加载只解析最后 N 行。
- **[进程 PID 被复用]** → 旧 claude 进程退出后 PID 可能被其他进程使用。缓解：检查 sessions 文件是否存在 + PID + 进程启动时间比对。
- **[daemon 重启后偏移量丢失]** → 重启后不知道 JSONL 读到哪里了。缓解：从文件末尾开始 tail（不重放历史），或记录偏移量到本地 state 文件。

## Migration Plan

1. DB migration：`ALTER TABLE sessions ADD COLUMN title TEXT; ALTER TABLE sessions ADD COLUMN source VARCHAR(16) DEFAULT 'daemon';`
2. 部署新 daemon（Go build + 重启）
3. 现有 daemon session（source=daemon）行为不变
4. 新功能（terminal session 发现）自动生效，无需用户配置
