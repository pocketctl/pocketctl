## Context

pocketctl daemon 通过 `claude -p --output-format stream-json` 驱动 agent。web 会话详情页发 slash command 后，执行反馈显示有多层缺口（见 proposal）。

实测 local command 在 stream-json 的反馈模式（跑 `/clear` `/context` `/compact` `/config` 枚举）：

| 命令 | 反馈形式 | 内容 |
|------|---------|------|
| `/clear` | assistant `model:"<synthetic>"` | `(no content)` |
| `/context` | assistant `model:"<synthetic>"` | `## Context Usage\n**Model:**...**Tokens:**...` |
| `/compact` | system `status:compacting` → system `compact_result:failed/success`(+`compact_error`) → assistant `<synthetic>` | "Not enough messages to compact." 或 summary |
| `/config`（不可用） | assistant `model:"<synthetic>"` | "/config isn't available in this environment." |

**关键洞察**：所有 local command 的反馈都是 **`model:"<synthetic>"` 的 assistant text**（synthetic = Claude Code 命令系统生成，非真实 LLM 输出）。`/compact` 额外用 `system` 事件携带结构化状态（`compact_result`）。当前 daemon adapter 的 `system` case 一律 `return nil`、`convertAssistant` 不区分 synthetic，于是反馈要么丢失、要么被当普通 agent_text 渲染成困惑的气泡/噪音。

另外，local command 执行时 Claude Code 向对话注入 `isMeta:true` 的 `<local-command-caveat>` user 消息（"DO NOT respond..."），daemon 不过滤 isMeta、web cleanContent 漏该标签，导致 "Caveat:..." 文本泄漏显示。

## Goals / Non-Goals

**Goals:**
- web 发 slash command 后，看到**清晰的执行回执**（命令名 + 状态 + 消息），而非空白或噪音
- 过滤 `isMeta:true` 的 meta 消息，web 不再显示 "Caveat:..." 噪音
- web cleanContent 对齐 iOS，正确处理 `local-command-caveat`
- 区分 local command 反馈（synthetic）与普通 agent 对话，前者渲染为回执卡片

**Non-Goals:**
- 不改自定义 commands/skills 的反馈（它们是普通 agent_text，正常显示，不转 receipt）
- 不做命令执行的进度条/流式（回执是命令完成后的终态卡片）
- 不改 iOS 端（iOS 已正确处理 caveat；本 change 只补 web + daemon 转发）

## Decisions

### D1. 反馈信号源：system local_command（--resume 主路径）+ assistant synthetic（单次）+ /compact system status
**选择**：local command 反馈按路径有两种格式，都转 command_receipt：
1. **system local_command**（`type:system, subtype:local_command, content:<local-command-stdout>...`）—— **--resume session 的真实格式**（web 发命令走 `SendMessage --resume`），也是 JSONL 持久化格式（replay）。`convertSystem`（实时）+ `ParseJSONLLine`（replay）处理。
2. **assistant synthetic**（`message.model:"<synthetic>"`）—— 单次 `claude -p`（CreateSession 初始命令）的格式。`convertAssistant` 处理。
3. **/compact system status**（`status:compacting`、`compact_result`）—— /compact 结构化状态，作补充（成功/失败 + error）。
**理由**：实测（session 1b4ab359）发现 --resume 路径反馈是 system local_command（JSONL 证实），**不是** assistant synthetic（单次才是）。初版只认 synthetic，漏 local_command → web 发命令（--resume）无回执。修后两格式都转 receipt。
**备选**：仅 synthetic → 漏 --resume 主路径；仅 text 模式匹配 → 脆弱。双格式覆盖最稳。

### D2. adapter 接收 prompt，自包含跟踪 pending command
**选择**：`NewClaudeAdapter` 接收 prompt（= SendMessage 的 content）；若 prompt 以 `/` 开头，adapter 记录 `pendingCmd`（命令名）。后续解析 synthetic/system 反馈时结合 pendingCmd 产出 command_receipt。
**理由**：daemon 在 `SendMessage` spawn `claude -p "<content>" --resume`，prompt 即用户发的命令，adapter 拿到 prompt 就能知道"这次 spawn 是为了执行哪个命令"。adapter 自包含，不污染 session manager 状态。
**备选**：session manager 跟踪 pending（ProcessState 字段）→ 跨 spawn 状态管理复杂；adapter 内聚更干净。

### D3. command_receipt 状态映射规则
**选择**：
- synthetic text 含 `"isn't available in this environment"` → `unavailable`
- `/compact` 且 `compact_result:"failed"` → `failed`（message 取 `compact_error`）
- `/compact` 且 `compact_result:"success"` → `success`
- 其他 synthetic text（/clear、/context 等）→ `success`（命令执行了，text 是输出/结果）
**理由**：覆盖实测的四种反馈形态。"isn't available" 是命令拒绝的稳定措辞；compact_result 是结构化字段，优先于 text 推断。

### D4. synthetic text 不再当普通 agent_text 转发
**选择**：adapter `convertAssistant` 检测 `model:"<synthetic>"` → 产出 `command_receipt` 事件（结合 pendingCmd + D3 状态），**不再**产出 `agent_text`。普通（非 synthetic）assistant text 仍走 `agent_text`。
**理由**：避免同一反馈既成 receipt 又成 agent_text 重复显示。synthetic 本就是命令系统输出，归入 receipt 语义正确。
**备选**：synthetic 仍发 agent_text + 加 synthetic flag，web 渲染卡片 → web 要从 text 推断状态，不如 daemon 结构化推断后给 receipt。

### D5. isMeta 过滤：仅 user entry，replay + 实时双路径
**选择**：replay（读 JSONL history）与实时（readOutput stream-json）路径上，过滤 `isMeta:true` 的 **user 类型** entry，不转发给 web。assistant/system 不受影响。
**理由**：isMeta 是 Claude Code 标记"非真实用户输入"的元消息（如 local-command-caveat），本就不该进对话流。限定 user 类型避免误伤 assistant/system。
**实现点**：stream-json 的 user 事件 + JSONL entry 都需检查 isMeta 字段（JSONL 已确认有 `isMeta:true`；stream-json 的 user 事件需确认是否携带——若不带，则 caveat 只在 JSONL，实时路径靠 D4 的 synthetic 转 receipt 已覆盖）。

### D6. command_receipt 事件结构
**选择**：
```
command_receipt {
  session_id, command (如 "/compact"), status ("success"|"failed"|"unavailable"), message
}
```
daemon → client，复用 `DaemonEvent`（新增字段 `Command`/`ReceiptStatus` 或独立 type）。

### D7. web cleanContent 补 local-command-caveat（对齐 iOS，补救）
**选择**：cleanContent 加 `<local-command-caveat>...</local-command-caveat>` 整段删除。
**理由**：即使 daemon 过滤 isMeta，web cleanContent 也应对齐 iOS（防御性，且 replay 历史 session 若含残留 caveat 也能清）。

### D8. web CommandReceiptCard 组件（复用 tool-card 视觉）
**选择**：新增组件，复用现有 `.tool-card` 视觉语言（图标 + 命令名 + 状态 + 可展开消息），渲染 command_receipt。状态图标：success ✓ / failed ✗ / unavailable ⊘。

## Risks / Trade-offs

- **[synthetic 标识依赖]** `model:"<synthetic>"` 是 Claude Code 内部约定，版本间可能变 → 标注为已知依赖；若变，反馈退化为普通 agent_text（不致错，只是没卡片）。
- **[状态推断漏判]** "isn't available" 等模式匹配可能漏新措辞 → 优先用结构化字段（compact_result），text 模式作兜底；未识别的 synthetic 默认 success（保守）。
- **[isMeta 边界]** 误过滤非 user 的 isMeta → D5 限定 user 类型，单测覆盖。
- **[非 local command 的 slash command]** 自定义 commands/skills 的反馈是普通 agent_text（非 synthetic），不转 receipt，正常显示——符合预期，但用户可能期望所有 / 命令都有卡片 → Non-Goal，后续可扩展。

## Migration Plan

纯增量：
- daemon adapter 解析 synthetic/system 转 command_receipt（新逻辑）+ isMeta 过滤
- WS 新增 command_receipt 事件（老 web 不识别则忽略，向后兼容）
- web 新增回执卡片 + cleanContent 补丁
无破坏性变更，daemon/web 分别部署。

## Open Questions

1. **stream-json 的 user 事件是否携带 isMeta**：JSONL 确认有，但实时 stream-json 的 user 事件需实测确认。若不带，实时路径靠 D4（synthetic→receipt）已覆盖反馈，isMeta 过滤主要服务 replay。
2. **`/clear` 的 "(no content)" 如何显示**：回执 message 为空时，卡片显示命令名 + success 状态即可（不强制 message）。
3. **command_receipt 的 command 名**：取 pendingCmd（D2）。若用户发 "/cmd arg"，command 取 "/cmd"（去掉参数）。
