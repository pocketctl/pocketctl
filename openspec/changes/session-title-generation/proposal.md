## Why

Session 默认显示名称为 "Terminal Session" 或 session ID 前缀，用户在 iOS 端无法快速区分多个 session。当前标题提取逻辑仅取第一条用户消息原文并截断，质量参差不齐。需要利用 LLM 生成简洁、准确的标题，提升 session 列表的可读性和辨识度。

## What Changes

- **默认名称统一**: 新建 session 时，title 设为 `Terminal Session-{sessionID后8位}`，替代当前的 `Terminal Session` 或纯 ID 前缀
- **LLM 标题生成**: Relay Server 调用智谱 GLM-4.6 API，根据 session 的首条用户消息 + 首条助手回复生成简短标题
- **只更新一次**: 标题从默认值更新为 LLM 生成值后，永远不再变更
- **方案 B 触发时机**: 等待首条 assistant 回复完成后再触发生成，确保上下文完整
- **降级策略**: GLM 调用超时(3s)或失败时，fallback 到用户消息原文截断(前15字)
- **新增 WebSocket 事件**: `generate_title_request` — Daemon 向 Relay 发送待生成内容
- **三层防重保证**: Go Daemon (titleGenerated flag) + Relay (检查非默认标题) + DB (WHERE title LIKE 'Terminal Session-%')

## Capabilities

### New Capabilities
- `session-title-generation`: LLM 驱动的 session 标题自动生成，包含 GLM-4.6 API 集成、prompt 工程、降级策略和一次性更新保证

### Modified Capabilities
- `session-lifecycle`: session 创建时的默认名称格式变更，标题更新事件流扩展
- `watcher-session-id-tracking`: JSONL 监控逻辑扩展，需同时提取首条 user msg 和首条 assistant msg
- `relay-routing`: 新增 `generate_title_request` 事件处理，标题条件更新逻辑

## Impact

- **Relay Server**: 新增 `title.ts` 模块(GLM API 调用)，修改 `router.ts`(事件处理) 和 `db.ts`(条件更新)，新增环境变量 `ZHIPU_API_KEY`
- **Go Daemon**: 修改 `manager.go`(titleGenerated flag)、`tailer.go`(双消息提取)、`claude_jsonl.go`(提取 assistant 回复)、`main.go`(触发逻辑)、`types.go`(新事件类型)
- **iOS**: 修改 `Session.swift` 的 `displayTitle` 计算属性
- **依赖**: 无新 npm 依赖(GLM API 兼容 OpenAI 格式，用原生 fetch)
- **成本**: 每个新建 session 一次 GLM-4.6 调用，约 ¥0.001/session
