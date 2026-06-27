## ADDED Requirements

### Requirement: 会话类型通过单一注册表注册

daemon SHALL 通过一张 `Provider` 注册表声明每种 agent 的全部能力，加一个新 agent SHALL 仅需注册一个 Provider，不再修改散落的工厂 switch（`NewAdapter` / `NewJSONLParser` / `NewLauncher` / `NewStorage` / `Capabilities` / `ListModelsForAgent` / `agentCLIName` / `discovery.knownAgents`）。

每个 `Provider` SHALL 声明：agent 类型与 CLI/包/升级命令、会话后端（`SessionBackend`）、终端会话发现器、实时通道构造、续聊方式、能力位（`AgentCapabilities`）、模型列表来源。

#### Scenario: 已注册 agent 被解析

- **WHEN** daemon 需要为某 `agentType` 解析后端/通道/能力
- **THEN** SHALL 通过 `registry.Get(agentType)` 返回对应 Provider
- **AND** 不再依赖 per-agent 的硬编码 switch 分支

#### Scenario: 未注册 agent 类型

- **WHEN** 请求的 `agentType` 未在注册表中
- **THEN** SHALL 返回明确错误，而非静默 fall-through 到 claude 默认实现

#### Scenario: discovery 与 adapter 不再不对称

- **WHEN** 一个 agent（如 opencode）被注册
- **THEN** 它在版本发现/升级 与 会话驱动 两侧 SHALL 来自同一 Provider 定义
- **AND** 不存在"能发现但不能驱动"的状态

### Requirement: 会话后端抽象

daemon SHALL 通过 `SessionBackend` 接口统一会话生命周期（Start/Send/Interrupt/Events/Close/Capabilities），使"一会话一进程"（claude/codex）与"一 server 多会话"（opencode）两种模型共存。`ProcessState` SHALL 仅保留后端无关的核心字段加一个不透明 backend 句柄；进程专属字段 SHALL 由 `SubprocessBackend` 内部持有。

#### Scenario: claude/codex 经 SubprocessBackend 行为不变

- **WHEN** claude-code 或 codex 会话被创建、发送、中断、续聊
- **THEN** 行为 SHALL 与重构前完全一致
- **AND** PTY/stdout-adapter/JSONL-tail/`--resume` 逻辑由 SubprocessBackend 承载

#### Scenario: opencode 经 ServerBackend 多路复用

- **WHEN** 多个 opencode 会话并存
- **THEN** 它们 SHALL 复用单个 `opencode serve` 进程
- **AND** 单条 SSE 流按 sessionID 解复用为各会话事件

### Requirement: 实时通道抽象

daemon SHALL 把实时跟读抽象为 `LiveChannel` 接口（Start/Events/Pause/Resume/Close），并提供 `SingleFileTail`、`DirWatch`、`ServeSSE` 三种实现。Pause/Resume 语义 SHALL 保留（续聊子进程运行期间暂停以避免重复转发）。

#### Scenario: 按 agent 选择实时通道

- **WHEN** 为一个会话建立实时通道
- **THEN** claude/codex SHALL 使用 `SingleFileTail`
- **AND** opencode 终端会话 SHALL 默认使用 `DirWatch`
- **AND** opencode 进入 daemon serve 进程内的会话 MAY 升级为 `ServeSSE`
