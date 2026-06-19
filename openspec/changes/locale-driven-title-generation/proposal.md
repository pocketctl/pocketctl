## Why

当前标题生成仅根据用户消息语言判断（GLM system prompt: "Match the language of the user's message"）。用户英文 UI + 中文提问时，标题仍是中文。需要让标题语言跟随页面 locale 设置，保持 UI 体验一致。

## What Changes

- 前端 WebSocket 连接后上报当前 locale，locale 切换时重发
- Relay 在 ClientConnection 中存储用户 locale
- Relay 收到 generate_title_request 时，从 session owner 获取 locale 传递给 title.ts
- title.ts 的 GLM prompt 加入 locale 约束：优先按 UI 语言生成标题，仅在消息语言与 UI 语言相同时保留原语言

## Capabilities

### New Capabilities
- `locale-driven-title`: 前端上报 locale 到 relay，标题生成链路根据 locale 生成对应语言的标题

### Modified Capabilities
- `session-title-generation`: generateTitle 函数增加 locale 参数，prompt 优先使用 UI 语言而非仅依赖用户消息语言

## Impact

- `web/src/composables/useWebSocket.ts` — 新增 locale 上报逻辑
- `relay/src/router.ts` — ClientConnection 加 locale 字段；handle set_locale；generate_title_request 传 locale
- `relay/src/title.ts` — generateTitle 加 locale 参数；SYSTEM_PROMPT 修改
