## Context

Web 客户端在支持 agent 内置命令/skills 后遗留 3 个 session 交互问题。探索 + 实测定位的根因：

**问题 1（terminal session 命令无响应）**——实测确认三重故障：
- `sendToIdleTerminal` 用 `claude -p "cmd" --resume` 且 `Stdout=nil`，stdout 里的 `assistant <synthetic>` 命令反馈被直接丢弃
- 命令反馈本应 fallback 到 JSONL tailer，但实测往 `b8b72899.jsonl` 写了 13 行 local_command entry 后，daemon/relay **零反应**（tailer 没转发）
- 即便 tailer 工作，`parseAssistantJSONL` 把 synthetic 当普通 text → `agent_text`（不像 adapter `convertAssistant` 会识别 `model=="<synthetic>"` 转 command_receipt）

**问题 2（新建 session 命令无响应）**——daemon 侧实测正常：全新 session 无论首条 `claude -p "/help"`（无 --resume）还是后续 `--resume`，stdout 都有 `assistant <synthetic>` → adapter → command_receipt 链路通畅。根因在 web 侧：`sendMessage`（SessionDetail:310）只检查 `isDisconnected`，**没有 pending session_id 拦截**——新建 session 在 `pending-xxx → real-id` 窗口期发命令会 `--resume pending-xxx` 失败。

**问题 3（切换内容串）**——grep 确认 SessionDetail **完全没有 `replay_end` 监听、没有 `isLoading`、没有 replay 去重**（relay 在 router.ts:450/466/474 发了 replay_end，前端没接）。快速切换时多个 replay 并发，messages 在空/填充间闪烁 → 串。单独打开（单 replay）正常。

## Goals / Non-Goals

**Goals**
- terminal session 内置命令（/model /compact /clear 等）在 Web 收到 command_receipt 回执
- 新建 session 任意时刻发命令都不会因 pending-id 失败
- 会话快速切换对话内容不串、加载必完成

**Non-Goals**
- 不改 claude CLI 本身的行为（命令产物格式是 claude 决定的）
- 不重写 JSONL tailer（它仍承担终端直接交互 + 历史回放 + 标题提取）
- 不改 command_receipt 协议结构（已有，复用）

## Decisions

### D1: terminal session 命令反馈统一为 stdout 捕获（弃用 tailer 转发命令）

`sendToIdleTerminal` 改用 `StdoutPipe` + `readOutput` + adapter，与 daemon `CreateSession`/`SendMessage` 路径完全统一：

```
sendToIdleTerminal（修复后）
  spawn claude -p "cmd" --resume + StdoutPipe
  → readOutput → adapter
     ├─ convertAssistant: model=="<synthetic>" → command_receipt（pendingCmd 带命令名）
     └─ convertSystem: subtype=="local_command" → command_receipt
```

一招解决三重故障：不再 discard stdout（故障1）、不依赖 tailer（故障2）、复用 adapter 已正确的 synthetic 识别（故障3），且 adapter 的 `pendingCmd` 顺带修复命令名（JSONL 路径传空的问题）。

**为何不修 tailer 路径**：替代方案是「修 tailer 转发 + 修 parseAssistantJSONL 识 synthetic」。但 tailer 为何没转发尚未定位（可能是文件路径/goroutine 生命周期），修两处不如统一一处；且 adapter.convertAssistant 已验证正确，复用零风险。

### D2: sendToIdleTerminal 与 tailer 的去重 → 期间暂停 tailer

统一 stdout 后，同一事件有 stdout（adapter）+ JSONL（tailer 1s 后读到）双源。去重方案：

- **采用**：`sendToIdleTerminal` 开始时暂停该 session 的 tailer（tailer.Run 检查 paused 标志，paused 时丢弃新行），`cmd.Wait()` 完成后恢复。局部、简单、不波及 relay。
- **替代（未采用）**：relay 转发层按 event_hash 去重（insertEvent 已算 hash，但当前转发不 dedup）。更稳健但改 relay 转发逻辑、影响所有事件流，风险面大。

**tailer 职责边界**：注册时读历史（replay）+ 标题提取 + 用户终端直接交互（不经 sendToIdleTerminal）的事件转发。sendToIdleTerminal 期间（web 触发）的事件由 stdout adapter 负责。

### D3: 新建 session 命令的 pending 拦截

`sendMessage` 加 pending-id 拦截，配合 `new-session-loading-flow` 的 loading 状态机：

```ts
if (sessionId.value.startsWith('pending-')) {
  showToast('会话正在创建，请稍候')  // 或 input :disabled="isLoading"
  return
}
```

input 在 loading（SUBMITTING/CONNECTING）态禁用，从 UI 层杜绝 pending 窗口发命令。

**Open Question**：pending 窗口是疑点（daemon 侧实测正常）。design 标注为 web 抓包验证项——若抓包发现 `user_message` 的 session_id 已是 real 但仍无 command_receipt，则根因另在（如 command_receipt 的 session_id 时序过滤误杀），需补查。

### D4: 切换竞态 → replay_end + isLoading + replay reqId

三层防御：

1. **replay_end 监听**（必须）：web 收 replay_end 收尾 loading。relay 已发，前端补监听。
2. **isLoading 状态**（必须）：切换时 true，对应 reqId 的 replay_end 时 false。UI 显示加载态。
3. **replay reqId**（推荐）：replay 消息带 web 生成的递增 req_id，relay 透传到 replay_batch/replay_end，web 按 req_id 过滤 stale（sessionId 过滤已部分覆盖，reqId 防同 session 快速来回切换的残留 batch）。

```ts
const replayReqId = ref(0), isLoading = ref(false)
watch(sessionId, (newId) => {
  messages.value = []; replayReqId.value++; isLoading.value = true
  send({ type:'replay', session_id: newId, last_seq: 0, req_id: replayReqId.value })
})
onEvent('replay_batch', m => { if (m.req_id !== replayReqId.value) return; ... })
onEvent('replay_end', m => { if (m.req_id !== replayReqId.value) return; isLoading.value = false })
```

**protocol 改**：replay/replay_batch/replay_end 加 optional `req_id` 字段（向后兼容，旧客户端不传则不过滤）。

## Risks / Trade-offs

- **[D2 暂停 tailer 期间终端交互事件丢失]** → 窗口是单次 `claude -p --resume` 执行期（通常几秒到几十秒），且用户此时正在 Web 发消息、同时用终端直接交互的概率低。可接受；若需根治再上 event_hash。
- **[D3 pending 拦截误伤]** → 若 session_id_changed 延迟，用户被多拦一瞬。loading 状态机 + toast 提示缓解。
- **[D4 reqId protocol 改]** → optional 字段，旧 relay/daemon 不受影响；但需 relay + web 同步部署才生效（reqId 过滤）。
- **[问题 2 根因未完全实定]** → daemon 正常、疑 web pending 窗口。若 web 抓包推翻 pending 假设，D3 需调整（可能要查 command_receipt 的 session_id 过滤时序）。

## Migration Plan

1. **daemon**：改 `sendToIdleTerminal`（stdout 捕获 + adapter + tailer pause/resume）；`ws/client` 无需改。
2. **relay**：replay/replay_batch/replay_end 透传 req_id（可选，先部署 replay_end 已够用）。
3. **web**：SessionDetail 加 replay_end 监听 + isLoading + reqId 过滤；sendMessage 加 pending 拦截 + input loading 禁用。
4. **部署顺序**：daemon + relay + web 可独立部署（req_id optional 向后兼容）。问题 1 需 daemon 重启（含 codesign，见 macOS Sequoia 约束）。

## Open Questions

- **问题 2 的 web 抓包验证**：新建 session 立即发 /help，devtools WS 看 `user_message` 的 session_id（pending vs real）+ 是否有 `command_receipt` 回。若非 pending 窗口，需查 `command_receipt` 监听（SessionDetail:508）的 `session_id !== sessionId.value` 过滤是否误杀（pending→real 切换瞬间）。
- **tailer 为何没转发**（D1 绕过，但留疑）：统一 stdout 后此问题降级为「终端交互是否正常」的验证项，可在实现后回归测试。
