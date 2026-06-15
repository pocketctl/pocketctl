# Tasks

> 实现顺序：协议类型 → adapter 反馈识别/转换 → isMeta 过滤 → web 协议接入 → web cleanContent + 回执卡片 → 测试 → 验收。

## 1. Protocol：command_receipt 事件与字段

- [x] 1.1 `internal/protocol/types.go`：`DaemonEvent` 新增 `command_receipt` 所需字段（`Command`、`ReceiptStatus`、`Message`），JSON tag 与前端约定
- [x] 1.2 `internal/adapter/claude.go`：`ClaudeMessage` 新增 `Model` 字段（识别 `<synthetic>`）；`ClaudeStreamEvent` 新增 system 的 `CompactResult` / `CompactError` / `Status` 字段

## 2. Adapter：识别 local command 反馈并转 command_receipt

- [x] 2.1 `NewClaudeAdapter` 改签名接收 `prompt`；若 prompt 以 `/` 开头，提取命令名（`/` 后首个 token）存为 `pendingCmd`
- [x] 2.2 更新所有 `NewClaudeAdapter()` 调用点（`SendMessage`、`CreateSession` 的 readOutput）传入 prompt
- [x] 2.3 `convertAssistant`：检测 `message.model == "<synthetic>"` 的 text —— 不再产出 `agent_text`，改为标记为命令反馈（结合 pendingCmd）
- [x] 2.4 新增 `convertSystem`（替代 `system` case 的 `return nil`）：解析 `compact_result`（success/failed）+ `compact_error`，记录 compact 状态
- [x] 2.5 实现 command_receipt 产出逻辑（design D3 状态映射）：synthetic text 含 "isn't available" → unavailable；compact_result:failed → failed(+error)；compact_result:success → success；其他 synthetic → success
- [x] 2.6 命令名输出为 `/<pendingCmd>`（如 `/compact`），无 pendingCmd 时 fallback 从 synthetic text 推断或省略

## 3. Daemon：isMeta 过滤

- [x] 3.1 实时路径（readOutput / stream-json user 事件）：过滤 `isMeta:true` 的 user entry，不转发
- [x] 3.2 replay 路径（JSONL 读取 / watcher-tailer）：过滤 `isMeta:true` 的 user entry
- [x] 3.3 确认边界：仅 user 类型过滤；assistant/system 的 isMeta 不受影响（单测覆盖）
- [x] 3.4 实测确认 stream-json 的 user 事件是否携带 isMeta（design Open Question 1）——若不带，实时路径靠 §2 的 receipt 覆盖，isMeta 过滤主要服务 replay

## 4. Web：协议接入

- [x] 4.1 `web/src/composables/useWebSocket.ts`：`DaemonEvent` 加 `command_receipt` 字段（command/receipt_status/message）；新增 `CommandReceipt` TS 类型
- [x] 4.2 `SessionDetail.vue`：`processEvent` 处理 `command_receipt`，push 为独立消息项（type: 'command_receipt'）

## 5. Web：cleanContent 对齐 + 回执卡片

- [x] 5.1 `SessionDetail.vue` 的 `cleanContent` 加 `<local-command-caveat>...</local-command-caveat>` 整段删除（对齐 iOS `sanitizeUserMessage`）
- [x] 5.2 新增 `web/src/components/CommandReceiptCard.vue`：复用现有 `.tool-card` 视觉语言，渲染命令名 + 状态图标（success ✓ / failed ✗ / unavailable ⊘）+ 可选消息
- [x] 5.3 `SessionDetail.vue` 模板：`command_receipt` 类型消息渲染为 `<CommandReceiptCard>`（而非普通气泡）

## 6. 测试

- [x] 6.1 adapter 单测：synthetic 识别 + command_receipt 转换（`/model` → unavailable、`/compact` compact_result failed → failed、`/context` → success）
- [x] 6.2 adapter 单测：普通（非 synthetic）assistant text 仍产出 `agent_text`，不转 receipt
- [x] 6.3 adapter 单测：pending command 提取（`/compact arg` → `compact` → command "/compact"）
- [x] 6.4 daemon 单测：isMeta 过滤（user isMeta 过滤、assistant/system 不过滤）
- [x] 6.5 web 单测：`cleanContent` 删除 local-command-caveat 整段（不残留 "Caveat:..." 文本）
- [x] 6.6 web 单测：`CommandReceiptCard` 三状态渲染（success/failed/unavailable 图标 + 消息）

## 7. 验收与收尾

- [x] 7.1 逐条对照 `specs/command-execution-feedback/spec.md` 与 `specs/stream-protocol/spec.md` 的 scenario 手测：发 `/model` 看到 unavailable 卡片、`/compact` 看到 success/failed 卡片、刷新无 "Caveat:..." 噪音
- [x] 7.2 `openspec validate add-command-execution-feedback --strict` 通过
- [x] 7.3 本地部署验证：daemon 重启（adapter 改动）+ web rebuild（cleanContent + 卡片），在 web 会话发 local command 确认回执
