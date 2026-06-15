## Why

Web 会话详情页发送 slash command（尤其是 `/model`、`/compact` 这类 local command）后，执行反馈的显示存在多个缺口，用户体验混乱：

1. **噪音泄漏**：Claude Code 执行 local command 时会在对话里注入 `isMeta:true` 的 `<local-command-caveat>`（"DO NOT respond to these messages"）。daemon **完全不过滤 isMeta**（全代码库零匹配），把这条 meta 消息原样转发给 web；而 web 的 `cleanContent` 只处理了 5 种 command 标签、漏了 `local-command-caveat`，标签被通用 `<...>` 剥掉后留下 "Caveat:..." 文本显示给用户（刷新页面后尤为明显）。
2. **反馈丢失**：local command 的真实执行反馈（成功/失败/不可用）在实时 stream-json 里以 `system` 事件（`status:compacting`、`compact_result:failed`、命令拒绝）和 `<synthetic>` assistant 文本（"/model isn't available"、"Not enough messages to compact"、compact summary）的形式出现，但 daemon adapter 的 `system` case 一律 `return nil`（`claude.go:73`），把这些状态全丢了，web 既看不到 caveat 之外的反馈、也没有任何回执 UI。

这与 iOS 端不一致——iOS 的 `sanitizeUserMessage` 处理了 `local-command-caveat`，web 未对齐（和之前 `SKILL.md` 大小写同类"web 落后 iOS"问题）。

本 change 既**根治噪音**（过滤 isMeta + 补 cleanContent），又**补上反馈**（解析 local command 执行状态转为 `command_receipt` 事件 + web 回执卡片），让用户发命令后能看到清晰的执行结果而非困惑的空白或噪音。

## What Changes

- **Daemon 过滤 isMeta 噪音**：replay（读 JSONL history）与实时（readOutput stream-json）路径上，过滤 `isMeta:true` 的 user entry，不再转发 meta 消息给前端
- **Daemon 解析 local command 执行反馈**：adapter 的 `system` case 不再一律丢弃，识别 local command 相关状态（`compacting` / `compact_result` 成功或失败 / 命令拒绝）与 `<synthetic>` assistant 文本，转换为结构化的 `command_receipt` 事件
- **新增 WS 协议事件 `command_receipt`**：daemon → client，携带命令名、状态（`success` / `failed` / `unavailable`）与可选消息
- **Web cleanContent 对齐 iOS**：补 `<local-command-caveat>...</local-command-caveat>` 整段删除（与 iOS `sanitizeUserMessage` 一致）
- **Web 新增命令回执卡片**：类似现有 `tool_call` 卡片，渲染 `command_receipt`，显示 `/compact ✓ 已压缩`、`/compact ✗ Not enough messages`、`/model 不可用` 等可读反馈

## Capabilities

### New Capabilities
- `command-execution-feedback`: local command 执行反馈的端到端呈现——daemon 过滤 isMeta meta 噪音、解析 local command 执行状态转 `command_receipt`、web 回执卡片渲染、cleanContent 补 `local-command-caveat` 处理

### Modified Capabilities
- `stream-protocol`: 新增 `command_receipt` 事件类型（daemon → client，携带命令名、状态、消息），用于回传 local command 的结构化执行结果

## Impact

- **Daemon (`internal/adapter/claude.go`)**: `system` case 不再一律 `return nil`，解析 local command 相关 system 事件与 `<synthetic>` assistant 文本，产出 `command_receipt` 事件
- **Daemon (JSONL 读取路径)**: replay / watcher 读取 entry 时过滤 `isMeta:true` 的 user 消息，不转发给 web
- **Protocol (`internal/protocol/types.go`)**: 新增 `command_receipt` 事件类型与 `CommandReceipt` 结构（命令名、状态、消息）
- **Web (`web/src/views/SessionDetail.vue`)**: `cleanContent` 补 `local-command-caveat` 整段删除；`processEvent` 处理 `command_receipt`；消息流渲染回执卡片
- **Web (新增组件)**: `CommandReceiptCard.vue`，复用现有 `tool-card` 视觉语言展示命令回执
- **依赖**: 无新增
- **风险点**: local command 的 stream-json 反馈格式（system subtype / synthetic text 模式）需在 design 阶段精确枚举，避免漏判或误判（如把普通 agent 对话误判为命令回执）；`isMeta` 过滤要限定在 user entry，避免误伤其他消息
