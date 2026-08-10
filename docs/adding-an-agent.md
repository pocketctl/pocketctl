# 如何接入一个新的 Coding Agent

pocketctl 用一张**会话类型注册表**把每种 agent 的能力收敛到一处。接入一个新 agent =
注册一个 `Provider`，不需要再改散落各处的 `switch`。本文以现有的 claude-code / codex
（子进程型）和 opencode（服务型）为例，说明两类后端的接法。

## 0. 先判断 agent 属于哪类后端

| 后端类型 | 特征 | 例子 | 实时输出方式 |
|---|---|---|---|
| **子进程型** (`BackendSubprocess`) | 一会话一进程；会话历史写成可逐行追加的 JSONL 文件 | claude-code、codex | 启动 PTY → tail 该会话的 JSONL 文件 |
| **服务型** (`BackendServer`) | 一个常驻 server 进程，多会话经 HTTP/API 复用；会话存 DB | opencode | daemon 托管 server，经 API 轮询/SSE |

绝大多数 CLI agent 是**子进程型**，接入成本低；服务型需要额外写一个后端（见 §3）。

## 1. 注册 Provider（必做）

在 `internal/adapter/providers.go` 的 `init()` 里加一段 `Register`：

```go
Register(Provider{
    Type:      "myagent",            // 规范 agent 类型名（也是 web/relay 传的 agent 字段）
    CLIName:   "myagent",            // 安装的二进制名（discovery 用它定位）
    Package:   "@vendor/myagent",    // npm 包名（版本检测/升级用，没有就留空）
    UpdateCmd: "myagent upgrade",    // 内置升级命令（空 = 回退 npm install -g <pkg>@latest）
    Backend:   BackendSubprocess,    // 或 BackendServer
    Capabilities: AgentCapabilities{ // 声明运行时能力，daemon 据此决定哪些命令可用
        SupportsPermissionCycle: false, // Shift+Tab 模式切换（仅 claude）
        SupportsEffort:          false, // /effort 运行时切换（仅 claude）
        SupportsApprovalHook:    false, // PreToolUse hook 注入（仅 claude）
        SlashCommandsFromInit:   false, // init 事件携带可用命令（仅 claude）
    },
    // 子进程型需要下面四个工厂；服务型可留 nil（走专用后端）
    NewAdapter:  func(prompt string) AgentAdapter { return NewMyAgentAdapter() },
    NewParser:   func() JSONLParser { return NewMyAgentJSONLParser() },
    NewLauncher: func() SessionLauncher { return MyAgentLauncher{} },
    NewStorage:  func() SessionStorage { return MyAgentSessionStorage{} },
})
```

注册后，下面这些都会自动对该 agent 生效，**无需再改任何 switch**：

- `discovery.DiscoverAgents()` / `AgentUpgradeInfo` / `AgentTypeToCLI`（发现 + 升级）
- `adapter.NewAdapter/NewJSONLParser/NewLauncher/NewStorage/Capabilities`（驱动工厂）
- `adapter.BackendKindFor`（后端类型分流）

## 2. 子进程型 agent（claude/codex 路线）

实现 `internal/adapter/myagent.go`，提供四个接口（契约见 `adapter.go` 顶部注释）：

| 接口 | 职责 | 参考 |
|---|---|---|
| `AgentAdapter` | 解析 agent 流式 stdout 的一行 → `[]DaemonEvent`，并报告 sessionID | `codex.go: CodexAdapter` |
| `JSONLParser` | 解析持久化 JSONL 历史的一行 → `[]DaemonEvent` | `codex.go: CodexJSONLParser` |
| `SessionLauncher` | 构造交互(PTY)与 resume 的 CLI 参数 | `codex.go: CodexLauncher` |
| `SessionStorage` | 解析该 agent 的 JSONL 磁盘布局；提取 title/model | `codex.go: CodexSessionStorage` |

把各类输出都映射成统一的 `protocol.DaemonEvent`：`user_text` / `agent_text`（可带
`Usage`）/ `tool_call` / `tool_result` / `session_status` 等。终端会话发现走 `internal/watcher`
的 `SessionWatcher`（fsnotify 监视 agent 的 sessions 目录）。**到这里子进程型就接完了**——
`CreateSession`/`SendMessage` 的 PTY+tail 流程会自动适配。

## 3. 服务型 agent（opencode 路线）

服务型不走 PTY，需要额外实现一个 `SessionBackend`（`internal/session/backend.go`），并在
`manager.go` 的 `BackendServer` 分支接线。参考完整实现 `internal/session/opencode_backend.go`：

1. **托管 server 进程**：`internal/adapter/<agent>_serve.go` 负责启动常驻 server（解析监听
   地址、鉴权）、`Healthy()` 健康检查，并封装 HTTP/SSE 客户端。参考 `opencode_serve.go`。
2. **协调器**（coordinator）维护：
   - server 单例 + **健康 supervisor**（崩溃自动重启，serve 跑在 daemon-lifetime ctx 的子
     ctx 上，可独立重启不影响循环）；
   - **发现循环**：轮询 server 列出会话，按 `time.updated` 新鲜度过滤，注册终端会话；
   - **同步循环**（每会话）：轮询消息历史，增量差分成 `DaemonEvent` 转发；
   - **续聊**：客户端消息经 server API 注入（共享 DB 可加载终端建的会话）。
3. **SessionBackend** 实现 `Start/Send/Interrupt/Close`；`ProcessState.Backend` 指向它，
   `CreateSession`/`SendMessage`/`InterruptSession` 在 `BackendServer` 分支 dispatch 到它。

### 服务型的几个坑（来自 opencode 实战）

- **状态推导**：服务型没有 PTY 的 idle 信号。要从消息历史推导 `session_status`（如"末条是
  未完成的 assistant 才算 running"），否则会话状态会卡在 running，客户端计时器停不下来。
- **模型/标题**：terminal 会话不带 model/title，需经 server API 拉取（`get_session_meta`
  对服务型走 server 而非 JSONL）。模型字符串格式要全链路统一（如 `providerID/modelID`），
  否则会误报"模型变更"。
- **权限**：若 server 不向第三方 API 暴露权限请求，daemon 会话应配置为自动放行（等价
  bypassPermissions），避免无人应答时永久卡死。
- **busy 撞车**：续聊前用消息历史判活，正在生成时拒绝，避免并发写冲突。

## 4. 模型列表（可选，让 web 有模型下拉）

`SessionManager.ModelsForAgent(agentType)` 返回 `[]protocol.ModelOption`。子进程型在
`ListModelsForAgent` 加分支（如读配置文件）；服务型经 server API 拉取（参考 opencode 的
`ListModels` → `GET /api/model`）。web 新建会话对话框会自动用它填充下拉。

## 5. 只读 observer 型 agent（zcode 路线）

第三类后端是 `BackendObserver`：daemon **不启动、不驱动**该 agent 的任何进程，只从其本地
只读存储（如 SQLite）读取可见历史与增量，经现有 DaemonEvent/spool/Relay 上传，Web/iOS 只读
查看。当前实现是 ZCode（见 `docs/zcode-session-observer.md` 与 ADR-001）。

### 与前两类的关键区别

| 维度 | 子进程型 / 服务型 | 只读 observer 型 |
|---|---|---|
| 后端 | `BackendSubprocess` / `BackendServer` | `BackendObserver` |
| 发现 | `DiscoveryCLI`（npm/CLI 版本探测） | `DiscoveryStorage`（只读存储 probe） |
| 进程 | daemon 启动/接管进程 | daemon 不拥有任何进程 |
| 可控 | 可发送/停止/审批/恢复 | **绝不可控**：`CreateSession` fail-closed 返回 `ErrObserverReadOnly` |
| SessionManager | 注册进 sessions / ActiveRootSessionIDs | **绝不**注册；独立 catalog/cursor |
| differ | 各 agent 自己的 mapper | **独立** differ，不复用 OpenCode（ADR-001） |

### 接入步骤（以 zcode 为模板）

1. **Provider 注册**：在 `providers.go` 加 `Backend: BackendObserver`、`Discovery:
   DiscoveryStorage`、`CLIName=""`、`Package=""`、`Manageable` 隐含 false；工厂指向
   `observer.go` 里的 fail-closed sentinel（`observerStorage`/`observerLauncher`/…）。
2. **阻断创建路径**：`SessionManager.CreateSession` 在 `resolveAgentCLI` 之前对
   `BackendObserver` 返回 `ErrObserverReadOnly`（见 `internal/session/lifecycle.go`）。
3. **独立 package**：在 `internal/<agent>` 实现 Store（只读打开 + schema probe + 分页）、
   Mapper/Sync（独立 event-id 命名空间）、CursorStore（无内容 checkpoint）、Observer（低优先级
   门 + ACK + resync）。**禁止**导入或修改 OpenCode differ。
4. **main 接线**：仅当配置 `enabled=true` 才构造 observer；注入 `tryEmitLowPriority`（≤
   outputCh cap/4 才非阻塞 send）；组合 `OnEventsAcknowledged`（既有 cursor + observer
   cursor）；`OnReconnected` 调 `observer.QueueResync`；shutdown 调 `observer.Stop`。**不要**
   把 observer session 加入 SessionManager / state persistence / ProcessMonitor。
5. **Relay source 特例**：materializer 仅对 `agent=<x> && source=observer` 接受 observer
   source，其它一律 terminal。
6. **Web/iOS 只读门**：对 `<x>` 显式 `canWrite=false`（在所有其它判断之前），隐藏 composer /
   stop / approval / resume；不加入新建会话选项。

### 约束（务必遵守）

- source DB **只读**（`mode=ro` + `query_only=ON`）；不得 migration/CREATE/INSERT/UPDATE/
  DELETE/VACUUM/checkpoint；不得复制 DB 或读 WAL 文件内容。
- 严格白名单（表/列/part 类型）；synthetic/system/hidden/unknown-role 整条丢弃；file 只留
  basename + 限长 mime。
- 日志**无内容**：只允许 session id 短 hash、表名、reason code、计数、耗时。
- native session id 不离开 observer 内存；wire id 哈希化；cursor 只存 hash。
- pending 必须**先于** enqueue 持久化；**仅** Relay ACK 后才推进 source cursor。

## 6. 自测清单

- `go build ./...` + `go vet ./...`
- 单测：事件映射用真实样本驱动（参考 `opencode_test.go` / `opencode_sync_test.go`）
- 端到端：① 客户端建会话→实时输出；② **终端起会话→客户端发现+实时同步+续聊**（这是
  pocketctl 的核心卖点，务必验证）；③ claude/codex 回归无变化
