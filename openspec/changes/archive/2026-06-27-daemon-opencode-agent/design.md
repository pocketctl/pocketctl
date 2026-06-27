## Context

daemon 的会话模型是围绕"一会话一进程 + tail 单个 JSONL"建立的（claude/codex）。opencode 是 client/server 架构，会话存在共享 SQLite + `storage/` JSON 树，没有可逐行 tail 的单文件。引入 opencode 需要把"会话后端"和"实时通道"抽象出来，而不是再加一个 switch 分支。

调查发现（grounded，本机 opencode 1.17.8）：

- `opencode serve` 暴露完整 REST + SSE：`POST /api/session`、`POST /api/session/{id}/prompt`、`GET /event`（SSE，已实测 `server.connected`）、`/api/session/{id}/permission/{req}/reply`、`/api/session/{id}/question/...`、`GET /api/model`、`GET /api/command`、`GET /api/session/{id}/context`、`POST /api/session/{id}/compact`。owned 会话的对等能力全是原生 API，无需逆向。
- storage 布局：`session/<projectHash>/ses_*.json`（meta：directory/title/time）、`message/<sid>/msg_*.json`（role/model/agent/time）、`part/<msgId>/prt_*.json`（text/tool/token 统计）。
- `opencode run --format json` 输出 raw JSON events（≈ `claude -p stream-json`）；resume：`run -s <sid>` / `-c` / `--fork`。
- opencode 有 `attach <url>` 与内建 `--mdns` server 发现——TUI 可被指向已有 server，而非自起。
- model 形如 `provider/model`（如 `zhipuai-coding-plan/glm-5`）；sessionID 形如 `ses_...`。

## Goals / Non-Goals

**Goals:**
- opencode 成为一等 agent，owned 会话对等 claude/codex（建会话、实时输出、审批、交互提问、模型切换、context/用量、compact）。
- ★CORE：终端 TUI 起的 opencode 会话被 daemon 零配置发现、实时同步到客户端、并能在客户端续聊。
- 把 per-agent 分支收敛为注册表；加新 agent = 加一个文件。
- claude/codex 行为零变化（既有逻辑整体搬进 SubprocessBackend）。

**Non-Goals:**
- 不重写 claude/codex 的解析/PTY 逻辑，仅搬迁封装。
- 不实现多机 / 远程 opencode server。
- 不强制用户改变 opencode 启动方式（β attach 仅作可选增强，不作默认依赖）。
- 不在本 change 内做 opencode 的 token 级流式（若 storage part 只整文件落盘，逐 part 粒度即视为对等达标）。

## Decisions

### Decision 1: 抽象 `SessionBackend`，而非扩展 ProcessState

每个 agent 提供一个后端实现，统一会话生命周期：

```go
type SessionBackend interface {
    Start(ctx, config) (sessionID string, err error)
    Send(ctx, sessionID, content string) error
    Interrupt(sessionID string) error
    Events() <-chan protocol.DaemonEvent  // subprocess: 每会话一路; serve: 共享 SSE 解复用后
    Close(sessionID string) error
    Capabilities() adapter.AgentCapabilities
}
```

两个实现：
- `SubprocessBackend`（claude, codex）：把现有 PTY/stdout-adapter/JSONL-tail/`--resume` 逻辑原样搬入。
- `ServerBackend`（opencode）：托管单例 `opencode serve`，HTTP 客户端 + 单条 SSE 消费按 sessionID 解复用。

> **实现修正（2026-06-27, group 1）**：`Provider`（在 `internal/adapter`）**不能**持有 `Backend func() SessionBackend`——`SessionBackend` 需要 `SessionManager` 内部状态、只能放 `internal/session`，而 `session` 已 import `adapter`，反向引用会造成 import 环。改为：`Provider` 声明一个 `BackendKind` 枚举（`BackendSubprocess` / `BackendServer`），`internal/session` 按 kind 映射到具体后端实现。好处：session 只有两个后端实现、按 kind 选择，**完全没有 per-agent switch**（比原设计更干净）。同理 `LiveChannel` 接口定义在 `adapter`（`watcher` 已 import adapter，可实现之；`session` 可消费之）。

`ProcessState` 瘦身为后端无关核心字段（SessionID/Status/Cwd/Agent/Source/Model/...）+ 一个不透明 backend 句柄；进程专属字段（Cmd/PTY/Pid/TTY/Tailer）移入 SubprocessBackend 内部。

**备选**：给 ProcessState 加 opencode 专属字段。**放弃**：字段污染、switch 不减反增，且无法干净表达"一个 server 多会话"。

### Decision 2: 会话类型注册表

把 `adapter.go`（NewAdapter/NewJSONLParser/NewLauncher/NewStorage/Capabilities）、`manager.go`（ListModelsForAgent/agentCLIName）、`discovery.go`（knownAgents）的 per-agent 知识收敛成一张表：

```go
type Provider struct {
    Type      string  // "claude-code" | "codex" | "opencode"
    CLIName   string; Package string; UpdateCmd string  // ← 并入 discovery.knownAgents
    Backend         func() SessionBackend
    ForeignDiscover ForeignDiscoverer   // 怎么发现终端起的会话
    LiveChannel     func(sessionID, cwd string) LiveChannel
    Resume          func(sessionID, content string) error
    Capabilities    adapter.AgentCapabilities
    Models          func() []protocol.ModelOption
}
func Register(p Provider); func Get(agentType string) (Provider, bool)
```

`discovery.knownAgents` 作为单一事实源并入此表（或反向引用），消除"discovery 知道 opencode 但 adapter 不知道"的不对称。

### Decision 3: `LiveChannel` 三实现

把现有 `JSONLTailer` 泛化为接口：

```go
type LiveChannel interface {
    Start(ctx) error
    Events() <-chan protocol.DaemonEvent
    Pause(); Resume()   // 保留 sendToIdleTerminal 期间的 pause 语义
    Close() error
}
```

- `SingleFileTail`：现有 JSONLTailer（claude/codex）。
- `DirWatch`：fsnotify 监视 `message/<sid>/` 与 `part/<msgId>/`，新/改文件 → 整文件读 → 按 msg `time` + part 顺序重组为事件（opencode foreign 会话）。
- `ServeSSE`：消费 daemon serve 的 `/event`，按 sessionID 过滤（opencode owned 会话；以及若用户主动 attach 到 daemon serve 的 foreign 会话）。

### Decision 4: ★CORE — opencode 终端会话的发现与同步走"磁盘汇合"

与 claude/codex 同哲学：daemon 不和终端 opencode 进程直接通信，靠**共享磁盘**汇合。

- **发现**：fsnotify 监视 `~/.local/share/opencode/storage/session/<projectHash>/`，新 `ses_*.json` → `RegisterTerminalSession(Source:terminal)`，从 meta 取 directory/title/time。
- **实时同步**：对该会话挂 `DirWatch` LiveChannel。
- **续聊**：daemon 的单例 serve 共享同一个 DB，能加载别进程建的会话 → `POST /api/session/{id}/prompt`。

**为什么默认走磁盘而非"让 TUI attach 到 daemon serve"（β）**：磁盘路线保住 pocketctl 零配置承诺——用户照常 `opencode` 即可被发现，无需改启动方式。β（mDNS/attach → 全部会话同进程 → 原生 token 级 SSE）作为**可选增强**：当检测到某会话已在 daemon serve 进程内（出现在其 SSE），自动用 `ServeSSE` 取代 `DirWatch` 获得更高保真。

### Decision 5: 单例 `opencode serve` 生命周期

daemon 启动时拉起一个长驻 `opencode serve --port <固定/随机>`，配 `OPENCODE_SERVER_PASSWORD`（避免 unsecured 警告与本机其他进程误连）。健康检查（`GET /api/health`）失败则重启。所有 opencode owned 操作和 foreign 续聊都经它。

**备选**：每会话起一个 serve。**放弃**：重、端口管理复杂、且无法共享 SSE。

### Decision 6: 审批/交互统一进现有抽象

opencode 的 `/permission` 与 `/question` SSE 事件**翻译**成 daemon 现有的 approval / interactive_prompt 协议事件，对 web 端透明统一；reply 反向调 opencode 的 `/reply` endpoint。不为 opencode 单开一条客户端协议。

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| **跨进程 SSE 不可见**（daemon serve 看不到终端 TUI 会话的实时事件） | 这是 Decision 4 的前提假设（高置信但**未实测**）。默认走 DirWatch 不依赖跨进程 SSE；落地前用一次实验验证（见 Open Questions #1） |
| opencode 无 pid sidecar → 难判会话"是否正被终端占用" | 用 `session.time.updated` 新鲜度 + serve `GET /api/session/{id}` 状态判活；续聊前检查，避免与终端撞车 |
| part 文件可能只整文件落盘 → 实时只能逐 part | 视为对等达标（claude 也基本按消息粒度）；token 级留给 β 增强 |
| opencode DB schema 随版本迁移漂移（本机实测 serve 曾报 `no such column: name`） | serve 启动失败时降级：opencode owned 功能禁用并提示，foreign 发现/只读同步仍可经 storage 进行；记录最低兼容版本 |
| `opencode serve` 崩溃 | 健康检查 + 自动重启；重启期间 owned 会话标记 degraded |
| ProcessState 重构波及面大 | 先抽 backend 接口让 claude/codex 走新路径并全绿，再加 opencode；分阶段（见 tasks 分组） |

## Open Questions

### 已实测结论（2026-06-27，opencode 1.17.8，零 token 成本实验）

1. **SSE 是进程内总线，跨进程不可见** —— 起两个 serve 实例(A/B)共享同一 XDG 数据目录,捕获 A 的 `/event`(确认收到 `server.connected`),在 B 上 `POST /api/session` 建会话,**A 的 SSE 完全没有该会话的任何事件**。
   - 推论:终端 `opencode` TUI(自起内嵌 server)的会话 **不会** 出现在 daemon serve 的 SSE 上。
   - **决策确认:★CORE 终端会话必须走 `DirWatch`(文件系统),不能依赖 ServeSSE。`ServeSSE` 仅用于 daemon 自己 owned 的会话。** Decision 4 成立。
2. **part 文件在一个回合内会被原地重写** —— `tool` part 带 `state.status`(pending→running→completed),completed 时才填 `output`;`text` part 的 `text` 字段是该 part 的完整文本。
   - **决策:`DirWatch` 必须同时监听 CREATE 与 MODIFY(WRITE)事件并重读文件**;粒度 = 逐 part + 原地状态更新(工具状态可近实时,文本逐 part)。视为对等达标。
3. **共享 DB 的跨进程读可行** —— B 能 `GET /api/session` 看到 A 创建的会话。**foreign 续聊路径(daemon serve 对终端建的会话 `POST /prompt`)可行**。
4. **两个 serve 同时启动会 `database is locked`(迁移期 SQLite 锁竞争)**,但**先后启动正常共存**。
   - **决策:daemon serve 须在 daemon 启动早期、独占地拉起**(先完成 DB 迁移),避免与终端 opencode 的启动撞迁移锁。
5. TUI 默认自起内嵌 server(由结论 1 的进程内 SSE 行为间接证实)。

### 事件映射表(Group 5.1 输入,源自真实历史数据)

| opencode part `type` | → DaemonEvent |
|---|---|
| `text`（含完整 `text`） | message.role=user→`user_text`；assistant→`agent_text`（model 取 message.model） |
| `tool`（`callID`/`tool`/`state{status,input,output}`） | status=running→`tool_call`；completed→`tool_call`+`tool_result`(output) |
| `step-finish`（tokens） | usage 事件 |
| `reasoning` / `step-start` | skip |
| `patch` / `file` | 可选(暂 skip) |

### API 契约（从 opencode 1.17.8 OpenAPI `/doc` 抓取，Group 4/5 输入）

- **建会话** `POST /api/session` body：`{id?, agent?, model?:{id,providerID,variant?}, location?}` → 返回 `{data:{id:"ses_...",...}}`
- **发消息(实测修正)**：`POST /api/session/{id}/prompt` 只**admit**(delivery:"steer"),空闲会话不执行 → 永远 0 消息。**真正执行 turn 的是 legacy `POST /session/{id}/message`**,body `{model:{providerID,modelID}, parts:[{type:"text",text}]}`,**model 必须在 body 里**(不继承会话 model,缺失则回退到 stale config 默认 → ProviderModelNotFoundError)。同步阻塞至 turn 完成。
- **SSE** `GET /event`：`data: {id:"evt_...", type, properties}`。关键事件：
  - `message.part.updated` → `properties:{sessionID, part:<Part>, time}` —— **part 与 storage 文件里的 Part 同构**
  - `message.updated` → `properties:{sessionID, info:<Message>}`,`info` 为 UserMessage|AssistantMessage(含 role、assistant 的 model)。**SSE demux 须缓存 msgID→(role,model)**,供随后 `message.part.updated` 的 part 转换查 role/model(part 自身不带 role/model)
  - `message.part.delta` / `session.next.tool-input.delta` —— **token 级增量(owned 会话可达 token 级保真)**
  - `message.part.removed` / `message.removed`
- **统一映射**：DirWatch(从文件读 Part) 与 ServeSSE(从 `properties.part` 取 Part) **共用同一个 `Part → DaemonEvent` 转换器**(见上"事件映射表") + `message.updated` 处理 role/model。
- 其余：`GET /api/model`、`GET /api/session/{id}/context`、`POST /api/session/{id}/compact`、`POST /api/session/{id}/permission/{req}/reply`、`POST /api/session/{id}/question/{req}/reply`、`GET /api/health`。

### ⚠️ 重大修正（2026-06-27 本地实测,opencode 1.17.11）

**当前 opencode 已把会话持久化从 `storage/` JSON 文件树迁移到 SQLite(`opencode.db`)。** 实测:终端发起会话后 `opencode.db` 更新,但 `storage/session|message|part/` **无任何新文件**(全是旧版历史)。因此:

- **DirWatch / storage 文件发现方案对当前版本完全失效**(它们监视的文件不再被写)。
- **改为:daemon 的共享 serve 通过 HTTP API 轮询共享 DB**(实测可读到终端会话):
  - 发现:`GET /api/session` → 列出全部会话(含终端的),按 `time.updated` 新鲜度筛选。
  - 实时同步:`GET /session/{id}/message`(**legacy 路径,非 `/api/...`**——后者返回空)→ `[{info:{role,model}, parts:[Part]}]`,复用 `ConvertOpencodePart`,按 partID + tool status 去重。
  - cwd:`GET /api/session/{id}` 的 `location.directory`。
  - 续聊:`POST /api/session/{id}/prompt`(不变)。
- **daemon serve 须在启动时即拉起**(不再仅 lazy),终端发现才能在无客户端动作时工作。
- 代价:轮询(1s 量级);终端会话 SSE 跨进程不可见的结论不变,API 轮询是替代。
- 被废弃:`internal/watcher/dirwatch.go`、`opencode_watcher.go`(文件方案)。

### 仍待定（不阻塞实现）

- model 列表 `provider/model` 形态如何映射到 `protocol.ModelOption{Alias,Name}` 与 web 模型切换 UI（Group 5.4 落地时定）。
- `OPENCODE_SERVER_PASSWORD` 设定后鉴权头细节（Group 4.1 落地时定）。
