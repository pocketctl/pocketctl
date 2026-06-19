## Context

标题生成链路：daemon 检测首条对话 → 发 `generate_title_request` 给 relay → title.ts 调 GLM-4.6 → 推送 `session_title_update` 给前端。当前 prompt 仅根据用户消息语言判断标题语言，无法感知页面 UI locale。

Relay 的 `ClientConnection` 结构已有 `userId` 字段，但缺少 `locale`。Session 与 userId 已有关联（通过 `upsertSession` 传入）。需要增加前端 → relay 的 locale 上报通道和 relay → title.ts 的传递链路。

## Goals / Non-Goals

**Goals:**
- 前端 WebSocket 连接后上报 locale，locale 切换时实时同步到 relay
- Relay 标题生成时根据 session owner locale 选择 GLM 输出语言

**Non-Goals:**
- 不改变 daemon 的标题触发逻辑
- 不改变 DB schema（locale 仅存内存，重启后前端会重新上报）
- 不处理「同一 session 被不同 locale 的用户看到」的场景（取 session owner 的 locale）

## Decisions

**1. Locale 传递方式：前端 WebSocket 上报 `set_locale` 消息，relay 存内存**

为什么不放 session 创建参数中？—— 创建 session 的消息是 daemon 发 relay，daemon 不知道前端 locale。前端直接上报给 relay 最直接。

**2. Locale 来源：session owner 的 locale**

收到 `generate_title_request` 时，通过 session → userId → ClientConnection.locale 查找。如果找不到 owner locale（如 daemon 独立运行），默认回退到当前 prompt 行为（根据用户消息语言判断）。

**3. Prompt 策略：UI 语言优先，消息语言保留**

```
新 SYSTEM_PROMPT:
"Generate a concise session title. The user's UI language is {locale}.
 - If the user message is already in {locale}, use that language for the title.
 - If the user message is in a different language, generate the title in {locale}."
```

保持智能策略（不强制转换），用户体验更好。

**4. title.ts 接口兼容**

`generateTitle(userMsg, asstMsg, locale?)` — locale 可选参数，不传时行为与当前完全一致（向后兼容）。

## Risks / Trade-offs

- [Session owner locale 可能不存在] → 默认回退到当前行为（仅根据消息语言）
- [Relay 重启后 locale 丢失] → 前端重连后会重新上报 `set_locale`，无影响
- [多客户端场景] → 只取 session owner 的 locale，不处理 viewer 的语言差异
