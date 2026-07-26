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

## 5. 自测清单

- `go build ./...` + `go vet ./...`
- 单测：事件映射用真实样本驱动（参考 `opencode_test.go` / `opencode_sync_test.go`）
- 端到端：① 客户端建会话→实时输出；② **终端起会话→客户端发现+实时同步+续聊**（这是
  pocketctl 的核心卖点，务必验证）；③ claude/codex 回归无变化
