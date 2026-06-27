# agent-registry

## Purpose

定义 daemon 接入多种 coding agent 的统一机制：一张会话类型注册表（`Provider`）把每个
agent 的发现/升级元数据、驱动工厂、能力位、后端类型收敛到一处。接入新 agent = 注册一个
Provider，不再修改散落各处的 switch。开发指引见 `docs/adding-an-agent.md`。

## Requirements

### Requirement: 会话类型通过单一注册表注册

daemon SHALL 通过一张 `Provider` 注册表声明每种 agent 的能力（`internal/adapter/registry.go` /
`providers.go`）。加一个新 agent SHALL 仅需注册一个 Provider；`adapter` 的工厂
（`NewAdapter` / `NewJSONLParser` / `NewLauncher` / `NewStorage` / `Capabilities` /
`BackendKindFor`）与 `internal/discovery` 的发现/升级 SHALL 全部从注册表派生，不再依赖
per-agent 的硬编码列表。

每个 `Provider` SHALL 声明：agent 类型、CLI 名、npm 包、升级命令、后端类型
（`BackendKind`）、能力位（`AgentCapabilities`），以及（子进程型 agent）adapter/parser/
launcher/storage 工厂。

#### Scenario: 已注册 agent 被解析

- **WHEN** daemon 需要为某 `agentType` 解析工厂/能力/后端类型
- **THEN** SHALL 通过 `adapter.Get(agentType)` / `BackendKindFor(agentType)` 返回对应 Provider 的声明
- **AND** 不再依赖 per-agent 的硬编码 switch 分支

#### Scenario: discovery 与 adapter 不再不对称

- **WHEN** 一个 agent（如 opencode）被注册
- **THEN** 它在版本发现/升级 与 会话驱动 两侧 SHALL 来自同一 Provider 定义
- **AND** 不存在"能发现但不能驱动"的状态

#### Scenario: 未实现工厂的 agent 安全兜底

- **WHEN** 某 agent 注册了元数据但未提供某驱动工厂（如服务型 agent 不需要 JSONL 工厂）
- **THEN** 对应工厂调用 SHALL 回退到 Claude 默认实现，而不会 panic

### Requirement: 会话后端抽象（加法式）

daemon SHALL 通过 `SessionBackend` 接口（`internal/session/backend.go`：Start/Send/
Interrupt/Close）支持"服务型"agent。该抽象 SHALL 为加法式：子进程型 agent（claude-code /
codex）继续使用 SessionManager 既有的 PTY / JSONL-tail / `--resume` 路径，行为不变；
仅服务型 agent（opencode）实现 `SessionBackend`，`ProcessState.Backend` 指向它，
`CreateSession` / `SendMessage` / `InterruptSession` 按 `BackendKind` 分流。

#### Scenario: claude/codex 行为不变

- **WHEN** claude-code 或 codex 会话被创建、发送、中断、续聊
- **THEN** 行为 SHALL 与引入注册表/后端抽象前完全一致

#### Scenario: 服务型 agent 经 backend 驱动

- **WHEN** 创建/驱动一个 `BackendServer` 类型 agent 的会话
- **THEN** daemon SHALL dispatch 到该 agent 的 `SessionBackend`，而非 PTY spawn 流程

### Requirement: 实时通道接口

daemon SHALL 定义 `LiveChannel` 接口（`internal/adapter/registry.go`：Start/Events/
Pause/Resume/Close）作为实时事件源的统一抽象。子进程型 agent 的实时输出经单文件 JSONL
tail（`internal/watcher` 的 `JSONLTailer`）。服务型 agent 经其 server API 获取实时输出
（见 `opencode-agent`）。

#### Scenario: 子进程型实时输出

- **WHEN** 为 claude/codex 会话建立实时输出
- **THEN** daemon SHALL tail 该会话的 JSONL 历史文件
