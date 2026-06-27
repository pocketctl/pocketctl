# opencode-agent

## Purpose

把 opencode 接入为一等 agent。opencode 是 client/server 架构（会话存 SQLite，非可 tail 的
JSONL 文件），因此 daemon 托管一个共享 `opencode serve` 进程，经其 HTTP API 驱动客户端会话、
发现并实时同步终端会话、续聊。实现：`internal/adapter/opencode.go`、`opencode_serve.go`、
`internal/session/opencode_backend.go`。

## Requirements

### Requirement: daemon 托管单例 opencode serve 并自愈

daemon SHALL 在启动时拉起一个长驻 `opencode serve --port 0` 进程（解析其打印的监听地址），
设置 `OPENCODE_SERVER_PASSWORD` 并在 HTTP/SSE 客户端携带 basic auth。daemon SHALL 周期性
`GET /api/health` 健康检查，进程异常退出时自动重启。serve 进程 SHALL 跑在 daemon 生命周期
ctx 的子 ctx 上，可独立重启而不影响发现/同步循环。

#### Scenario: serve 正常拉起

- **WHEN** daemon 启动且检测到 opencode 已安装
- **THEN** SHALL 拉起单例 `opencode serve` 并通过 `/api/health` 确认就绪
- **AND** 任意时刻 SHALL 只有一个 daemon 托管的 serve 实例

#### Scenario: serve 崩溃自动重启

- **WHEN** 运行中的 serve 进程退出/不健康
- **THEN** 健康检查 supervisor SHALL 自动重启它（实测 kill 后约 15s 内恢复，仍只有一个实例）

#### Scenario: serve 启动失败降级

- **WHEN** `opencode serve` 启动失败
- **THEN** opencode 相关操作（建会话/模型列表/发现）SHALL 返回明确错误而非静默失败或 panic

### Requirement: 自动放行工具权限（unattended 等价 bypassPermissions）

opencode SHALL NOT 向第三方 API 客户端暴露权限/问题请求（经实测：`/event`、`/api/event`、
`GET /api/session/{id}/permission`、`/api/permission/request` 均不含；用 serve 日志里的
`per_` id 回复返回 404）。因此 daemon 托管的 serve SHALL 以自动放行工具的配置启动
（`OPENCODE_CONFIG_CONTENT` 合并 `permission.edit/bash = allow`），等价 Claude daemon 的
bypassPermissions，使无人值守会话不会卡在无法应答的权限请求上。该配置 SHALL 只影响 daemon
的 serve；用户在终端运行的 opencode 用自身 server 与配置，权限仍在终端应答。

#### Scenario: 客户端会话执行写/命令工具

- **WHEN** daemon 驱动的 opencode 会话调用 edit/bash 工具
- **THEN** 工具 SHALL 被自动放行并执行，不会无限期挂起等待审批

#### Scenario: 终端 opencode 保留 ask

- **WHEN** 用户在终端运行 opencode（其自身 server）
- **THEN** 其权限行为 SHALL 遵循用户自己的配置，在终端应答

### Requirement: opencode owned 会话经 serve API 驱动

由客户端创建的 opencode 会话 SHALL 经 serve API 驱动：建会话 `POST /api/session`（带
`location.directory` 指定 cwd、`model`）；发消息/续聊 SHALL 用 `POST /session/{id}/message`
并在 body 携带 `{model:{providerID,modelID}, parts:[{type:"text",text}]}`（`/api/.../prompt`
仅 admit 不执行；message 端点不继承会话 model，必须在 body 带）；中断
`POST /session/{id}/abort`；压缩 `/compact` SHALL 调 `POST /session/{id}/summarize`
（`/api/.../compact` 在当前 opencode 为未实现占位，返回 503）。实时输出经按会话轮询
`GET /session/{id}/message` 增量差分得到（1 秒级，等价 claude/codex 的 JSONL tail 节奏）。

#### Scenario: 创建并实时输出

- **WHEN** 客户端创建一个 opencode 会话并发送消息
- **THEN** sessionID SHALL 来自 `POST /api/session` 响应
- **AND** 助手输出 SHALL 经消息轮询差分为 `agent_text` / `tool_call` / `tool_result` / 用量事件实时同步到客户端

#### Scenario: 无显式模型时回退到有效模型

- **WHEN** 客户端创建会话未指定 model
- **THEN** daemon SHALL 选用有效模型（配置默认若仍有效，否则同 provider 的有效模型，否则首个可用），避免用已重命名/失效的模型导致 turn 失败

#### Scenario: 模型列表与切换

- **WHEN** 客户端请求 opencode 可用模型，或会话模型在终端被切换
- **THEN** daemon SHALL 经 `GET /api/model` 提供模型列表（`providerID/modelID` 形态）
- **AND** 经消息携带的 model 检测运行时切换并发 `session_model_changed`

### Requirement: 会话状态从消息历史推导

opencode 不提供 PTY idle 信号。daemon SHALL 从会话消息历史推导 `session_status`：当最新消息是
未完成（无 `time.completed`）的 assistant 消息时为 `running`，否则为 `idle`。续聊前 SHALL
据此做 busy 撞车检测：正在生成时拒绝新 prompt。

#### Scenario: turn 完成回到 idle

- **WHEN** opencode 会话的助手 turn 完成（assistant 消息带 `time.completed`）
- **THEN** daemon SHALL 发出 `session_status: idle`，客户端计时停止

#### Scenario: 续聊撞车保护

- **WHEN** 客户端在一个 turn 仍在生成时发送新消息
- **THEN** daemon SHALL 拒绝并提示"会话正在生成回复"

### Requirement: 终端 opencode 会话的发现、实时同步与续聊（CORE）

用户在终端正常运行 `opencode` 所创建的会话 SHALL 被 daemon 零配置发现、实时同步到客户端、
并能在客户端续聊，无需用户改变启动方式。由于 opencode 的事件总线为进程内（daemon 的 serve
看不到别的 opencode 进程的实时事件），发现与同步 SHALL 经 daemon 托管 serve 的共享 DB 视图
进行（HTTP API 轮询），而非进程间直连。

#### Scenario: 发现终端会话

- **WHEN** 用户在终端运行 `opencode` 并创建会话
- **THEN** daemon SHALL 经 `GET /api/session` 轮询发现该会话（按 `time.updated` 新鲜度过滤），登记为 `Source: terminal`、`agent: opencode`，cwd/title 取自会话记录

#### Scenario: 实时同步终端会话

- **WHEN** 一个已发现的终端会话产生新消息
- **THEN** daemon SHALL 经轮询 `GET /session/{id}/message` 增量差分并实时同步到客户端

#### Scenario: 客户端续聊终端会话

- **WHEN** 客户端对一个终端发起的 opencode 会话发送消息
- **THEN** daemon SHALL 经其共享 serve 的 `POST /session/{id}/message` 续聊（共享 DB 可加载别进程创建的会话）

#### Scenario: 标题自动更新

- **WHEN** opencode 为终端会话异步生成了真实标题
- **THEN** daemon SHALL 在轮询中拾取并经 `session_title_update` 更新客户端（跳过 "New session" 占位）

### Requirement: 卡住的 running 状态被对账

daemon SHALL 在发现轮询中对掉出实时同步窗口但仍在近期（有界窗口内）的会话一次性对账其状态为
`idle`（掉出窗口 ⇒ 非活跃），避免被遗弃于 `running` 状态的会话在 relay DB 中长期卡住。客户端侧
SHALL 对 `last_activity_at` 已过期的 `running` 状态视为 idle 兜底，避免计时器从 0 误启。

#### Scenario: 遗弃的 running 会话被纠正

- **WHEN** 一个 opencode 会话以 `running` 掉出实时同步窗口
- **THEN** daemon SHALL 一次性发出 `session_status: idle` 纠正其 DB 状态
