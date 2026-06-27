## Why

daemon 目前能驱动 claude-code 和 codex 两种 agent。opencode 已经在 `internal/discovery` 的 `knownAgents` 里注册（版本检测、`opencode upgrade` 可用），但 **adapter 的四个工厂（`NewAdapter` / `NewJSONLParser` / `NewLauncher` / `NewStorage`）和 `Capabilities` 都没有 opencode 分支**——一旦真去开会话，opencode 会静默 fall-through 到 Claude 的实现，必然失败。"能发现、能升级、不能跑"。

更深的问题：opencode 的架构和现有两个 agent 根本不同。

- claude/codex：**一会话一进程**——spawn PTY → 解析 init 行拿 sessionID → tail 单个 append-only JSONL 文件。
- opencode：**client/server**——`opencode serve` 暴露完整 REST + SSE API；会话存在共享 SQLite + `storage/` JSON 树（`session/` `message/<sid>/` `part/<msgId>/`），不存在可逐行 tail 的单文件。

现有 `ProcessState` 的字段（`Cmd *exec.Cmd` / `PTY *os.File` / `Tailer *JSONLTailer` / `Pid`）全是"进程模型"产物，opencode 一个都对不上。因此本 change 不能只加一个 `case`，必须把"会话后端 / 实时通道"抽象成可插拔接口（用户标题里的"会话类型注册"），opencode 是第一个非进程后端、正好逼出这个抽象。

**pocketctl 的核心卖点**——用户在终端正常跑 agent，daemon 零配置发现该会话、实时同步到客户端、并能在客户端续聊——必须在 opencode 上同等成立。这是本 change 的最高优先级约束。

## What Changes

- **会话类型注册表（agent-registry，新能力）**：把散落在 `adapter.go`（×5）、`manager.go`（×2）、`discovery.go` 的 per-agent 分支收敛成一张注册表。每个 agent 注册一个 `Provider`，声明它的 owned-backend（客户端建的会话）、foreign-discover（终端起的会话）、live-channel（实时跟读）、resume（续聊）、capabilities、models。加一个新 agent = 加一个文件。
- **实时通道抽象**：把当前 `JSONLTailer`（单文件逐行）抽象为 `LiveChannel` 接口，提供三种实现——`SingleFileTail`（claude/codex JSONL）、`DirWatch`（opencode storage 目录树）、`ServeSSE`（opencode 经 serve 的原生事件流）。
- **opencode agent（opencode-agent，新能力）**：
  - owned 会话：daemon 托管单例 `opencode serve`，经 `POST /api/session` 建会话、`POST /api/session/{id}/prompt` 发消息、`/event` SSE 收实时输出、`/permission` 与 `/question` 走审批/交互。
  - foreign（终端 TUI）会话 ★CORE：fsnotify 监视 `~/.local/share/opencode/storage/session/`（发现）+ `message/`、`part/`（实时同步），续聊经 daemon serve 的 `POST /prompt`（共享 DB 可加载别进程建的会话）。
- **session-discovery 扩展（修改能力）**：发现层从"仅 claude sidecar"扩展到按 agent 注册表分发，新增 opencode storage 树的发现。
- **无 BREAKING**：claude/codex 的现有行为通过把既有逻辑搬进 `SubprocessBackend` 完整保留；opencode 为纯新增。

## Capabilities

### New Capabilities
- `agent-registry`: 可插拔的会话后端 / 实时通道注册表；加 agent = 注册一个 Provider，不再改散落的 switch
- `opencode-agent`: opencode 作为一等 agent——owned 会话经 serve API，foreign（终端）会话经 storage 监视发现并实时同步，续聊经 serve prompt

### Modified Capabilities
- `session-discovery`: 终端会话发现从"仅 claude/codex 文件约定"扩展为按 agent 注册表分发，新增 opencode storage 树发现

## Impact

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `internal/adapter/registry.go` | 新建 | `Provider` 注册表 + `LiveChannel` 接口定义 |
| `internal/adapter/adapter.go` | 修改 | 5 个工厂 switch 收敛为注册表查询；新增 `AgentOpencode` 常量 |
| `internal/adapter/opencode.go` | 新建 | opencode 的 adapter / parser / launcher / storage / capabilities |
| `internal/adapter/opencode_serve.go` | 新建 | `opencode serve` 进程托管 + HTTP 客户端 + SSE 消费 |
| `internal/session/backend.go` | 新建 | `SessionBackend` 接口 + `SubprocessBackend`（claude/codex 现有逻辑搬入）+ `ServerBackend`（opencode） |
| `internal/session/manager.go` | 修改 | `ProcessState` 瘦身为后端无关核心 + backend 句柄；start/send/interrupt/discover 改走 backend |
| `internal/watcher/dirwatch.go` | 新建 | opencode storage 目录树的 `DirWatch` LiveChannel |
| `internal/watcher/watcher.go` | 修改 | 发现层按 agent 注册表分发 |
| `internal/discovery/discovery.go` | 修改 | `knownAgents` 表并入或对齐 agent-registry（单一事实源） |
| `internal/session/manager.go`（models） | 修改 | `ListModelsForAgent` opencode 分支：经 serve `GET /api/model` |
| `openspec/specs/agent-registry/spec.md` | 新建 | 注册表规格 |
| `openspec/specs/opencode-agent/spec.md` | 新建 | opencode agent 规格 |
| `openspec/specs/session-discovery/spec.md` | 修改 | 扩展发现规格 |
