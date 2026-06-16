## ADDED Requirements

### Requirement: Daemon 过滤 isMeta 元消息
Daemon 在转发会话消息给 web 时，SHALL 过滤 `isMeta:true` 的 **user 类型** entry（如 Claude Code 注入的 `<local-command-caveat>` 噪音），不转发给前端。`assistant` 与 `system` 类型的消息不受此过滤影响。过滤 SHALL 同时作用于 replay（读取 JSONL history）与实时（readOutput stream-json）两条路径。

#### Scenario: replay 时过滤 isMeta user 消息
- **WHEN** daemon replay 一个 session，其 JSONL history 含一条 `isMeta:true` 的 user 消息（`<local-command-caveat>...`）
- **THEN** 该消息 SHALL NOT 被转发给 web
- **AND** 同 session 中非 isMeta 的 user 消息正常转发

#### Scenario: 实时路径过滤 isMeta user 消息
- **WHEN** stream-json 实时流中出现 `isMeta:true` 的 user 事件
- **THEN** 该事件 SHALL NOT 被转发给 web

#### Scenario: assistant/system 消息不受 isMeta 过滤影响
- **WHEN** 一条 `isMeta:true` 但类型为 `assistant` 或 `system` 的消息出现
- **THEN** 该消息 SHALL 按其原有类型逻辑处理（不因 isMeta 被过滤）

### Requirement: 识别 local command 反馈并转为 command_receipt
Adapter SHALL 把 local command 执行反馈转为 `command_receipt`（而非 `agent_text`），反馈有两种格式都要识别：(1) `system` 事件 `subtype:"local_command"`，`content` 为 `<local-command-stdout>...</local-command-stdout>`（**--resume session 与 JSONL replay 的真实格式**）；(2) `assistant` 事件 `message.model:"<synthetic>"` 的 text（单次 `claude -p` 格式）。`/compact` 的 `system` 事件（`compact_result`）SHALL 作为补充状态源。普通（非 synthetic）assistant text SHALL 继续作为 `agent_text` 转发。

#### Scenario: --resume 路径的 system local_command 转 receipt
- **WHEN** --resume session 对 `/model` 产出 `system` 事件（`subtype:"local_command"`，`content:"<local-command-stdout>/model isn't available in this environment.</local-command-stdout>"`）
- **THEN** daemon 产出 `command_receipt`（status="unavailable"，message 解包为 "/model isn't available in this environment."）
- **AND** SHALL NOT 同时产出 `agent_text`

#### Scenario: 不可用命令转为 unavailable receipt（单次 synthetic 路径）
- **WHEN** agent 对 `/model` 输出 `<synthetic>` assistant text "/model isn't available in this environment."
- **THEN** daemon 产出 `command_receipt`（command="/model", status="unavailable", message=该文本）
- **AND** SHALL NOT 同时产出 `agent_text`

#### Scenario: compact 失败转为 failed receipt
- **WHEN** `/compact` 的 stream-json 含 system `compact_result:"failed"` + `compact_error:"Not enough messages to compact."`
- **THEN** daemon 产出 `command_receipt`（command="/compact", status="failed", message="Not enough messages to compact."）

#### Scenario: 普通命令输出转为 success receipt
- **WHEN** agent 对 `/context` 输出 `<synthetic>` assistant text "## Context Usage\n..."
- **THEN** daemon 产出 `command_receipt`（command="/context", status="success", message=该文本）

#### Scenario: 非 synthetic 的 agent 对话仍为 agent_text
- **WHEN** agent 输出普通（model 非 `<synthetic>`）assistant text
- **THEN** daemon SHALL 作为 `agent_text` 转发，SHALL NOT 转 command_receipt

### Requirement: command_receipt 状态映射规则
`command_receipt.status` SHALL 按以下优先级映射：(1) synthetic text 含 `"isn't available in this environment"` → `unavailable`；(2) `/compact` 且 `compact_result:"failed"` → `failed`（message 取 `compact_error`）；(3) `/compact` 且 `compact_result:"success"` → `success`；(4) 其他 synthetic text → `success`。

#### Scenario: isn't available 映射为 unavailable
- **WHEN** synthetic text 含 "isn't available in this environment"
- **THEN** status SHALL 为 `unavailable`

#### Scenario: compact_result failed 映射为 failed
- **WHEN** `/compact` 的 system 事件 `compact_result:"failed"`
- **THEN** status SHALL 为 `failed`，message 取 `compact_error`

#### Scenario: 未识别的 synthetic 默认 success
- **WHEN** synthetic text 不匹配上述任何失败/不可用模式
- **THEN** status SHALL 为 `success`

### Requirement: Daemon 跟踪 pending slash command
Daemon SHALL 在向 agent 发送以 `/` 开头的 user_message 时，记录 pending command 名（取 `/` 之后的首个 token，如 `/compact arg` → `compact`，结果 command 字段为 `/compact`）。产出的 `command_receipt` SHALL 携带该 pending 命令名。

#### Scenario: 记录 pending command 名
- **WHEN** daemon 发送 user_message content="/compact"
- **THEN** 记录 pending command 为 `compact`
- **AND** 后续该次 agent 执行的 command_receipt.command SHALL 为 "/compact"

#### Scenario: 带参数的命令取主命令名
- **WHEN** daemon 发送 user_message content="/model sonnet"
- **THEN** pending command 取首个 token `model`
- **AND** command_receipt.command SHALL 为 "/model"

### Requirement: Web cleanContent 对齐 iOS 处理 local-command-caveat
Web 的 `cleanContent` SHALL 整段删除 `<local-command-caveat>...</local-command-caveat>`（与 iOS `sanitizeUserMessage` 一致），而非仅剥标签留下内部文本。

#### Scenario: 删除 local-command-caveat 整段
- **WHEN** 一条 user 消息 content 含 `<local-command-caveat>Caveat: DO NOT respond...</local-command-caveat>`
- **THEN** cleanContent SHALL 删除整个 caveat 段落
- **AND** 不在界面上显示 "Caveat:..." 文本

### Requirement: Web 命令回执卡片渲染
Web SHALL 将 `command_receipt` 事件渲染为命令回执卡片，展示命令名、状态图标与可选消息。状态视觉 SHALL 区分：`success` → ✓、`failed` → ✗、`unavailable` → ⊘。

#### Scenario: 渲染 success 回执
- **WHEN** web 收到 `command_receipt`（command="/context", status="success", message="## Context Usage..."）
- **THEN** 渲染卡片，显示 "/context" + success 图标（✓）+ 消息

#### Scenario: 渲染 unavailable 回执
- **WHEN** web 收到 `command_receipt`（command="/model", status="unavailable", message="/model isn't available..."）
- **THEN** 渲染卡片，显示 "/model" + unavailable 图标（⊘）+ 消息

#### Scenario: 渲染 failed 回执
- **WHEN** web 收到 `command_receipt`（command="/compact", status="failed", message="Not enough messages..."）
- **THEN** 渲染卡片，显示 "/compact" + failed 图标（✗）+ 消息

#### Scenario: 空消息的回执仍显示命令与状态
- **WHEN** web 收到 `command_receipt`（command="/clear", status="success", message 为空）
- **THEN** 渲染卡片，显示 "/clear" + success 图标，不强制显示消息区

### Requirement: terminal session 命令反馈统一为 stdout 捕获
terminal session（用户终端开的 claude，source=terminal）的命令反馈 SHALL 通过 stdout stream-json + adapter 捕获（与 daemon session 的 `CreateSession`/`SendMessage` 路径统一），SHALL NOT 依赖 JSONL tailer 转发命令反馈。`sendToIdleTerminal` SHALL 用 `StdoutPipe` + adapter 解析 stdout，由 adapter 产出 `command_receipt`（命令名来自 adapter 的 `pendingCmd` 跟踪）。`sendToIdleTerminal` 执行期间 SHALL 暂停该 session 的 JSONL tailer（避免 stdout 与 JSONL 双源重复转发），`cmd.Wait()` 完成后恢复。

#### Scenario: terminal session 命令收到 command_receipt
- **WHEN** terminal session（idle 且进程存活）收到 web 发的 `/model`
- **THEN** daemon 通过 `sendToIdleTerminal` spawn `claude -p "/model" --resume` 并用 StdoutPipe 捕获 stdout
- **AND** adapter 识别 `assistant <synthetic>` 或 `system local_command` 产出 `command_receipt`
- **AND** SHALL NOT 依赖 JSONL tailer 转发该命令反馈

#### Scenario: sendToIdleTerminal 期间暂停 tailer 防双发
- **WHEN** `sendToIdleTerminal` 执行（web 触发 `claude -p --resume`）
- **THEN** 该 session 的 JSONL tailer 进入 paused 状态，不转发新事件
- **AND** `claude -p --resume` 进程退出（`cmd.Wait` 完成）后恢复 tailer
- **AND** 避免同一事件被 stdout adapter 与 tailer 重复转发

#### Scenario: terminal session command_receipt 携带命令名
- **WHEN** `sendToIdleTerminal` 发送 `/compact`
- **THEN** adapter 的 `pendingCmd` 记录命令名 "compact"
- **AND** 产出的 `command_receipt.command` SHALL 为 "/compact"（非空，区别于旧 JSONL 路径传空）
