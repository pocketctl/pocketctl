## Why

web 客户端会话消息区，用户提交消息后到模型响应之间、乃至整个模型处理期间，底部都缺少「正在处理」反馈。根因有二层：

1. **架构层缺口（深层）**：web session 用 PTY 交互模式（manager.go:336），daemon 把用户消息写进常驻 claude 的 PTY stdin（manager.go:940），但写 stdin 时**只发 `user_text` + 设内部 `ps.Status=Running`，不发 `session_status=running` 事件**（manager.go:923-948）。adapter 又只在 `result`（一轮结束）发 `Completed`（claude_jsonl.go:402）。结果是 PTY 模式下整个处理期间 web 收不到 running，`turn-status-bar` 的「工作中●」分支（依赖 `isExecuting`）**从不显示**——这套 bar 机制本是给 --resume 模式（manager.go:1094 发 running）设计的，PTY 路径漏了 running 信号。
2. **前端纯事件驱动（表层）**：`sendMessage` 不乐观 push 用户消息（回显等 relay 回传 `user_text`）、不立即给反馈；`startTurnTimer()` 已调用却被 bar 的 `v-if="isExecuting"` 挡住，计时器白走。

## What Changes

- **B（daemon 补架构缺口）**：PTY 写 stdin 时补发 `session_status=running`（manager.go:937 后）；写 stdin 失败时回退发 `session_status=error`。让现有 turn-bar 的 running→completed 闭环在 web 模式正常工作，**iOS 端同步受益**（同样消费 session_status）。
- **A（前端填往返延迟）**：新增瞬时 `awaitingStart`，`sendMessage` 置 true，首个 `session_status=running`/`agent_text` 清除。覆盖 B 的 running 到达 web 前的 ~100–300ms 往返。
- **C（乐观回显）**：`sendMessage` 立即 push 用户气泡，relay 回传由现有 `isDuplicate` 去重（抄 `handleLocalCommand` 685 先例）。
- **失败检测 L1 + L2（同步实现）**：L1 前端 `send` 错误回调（ws `onerror`/`onclose` + send 返回值），L2 relay 对 `user_message` 回 ack/nack。乐观反馈在 L1 失败、L2 nack、或 ack 超时、或 B 写 stdin error 时回退——三层各管一段，端到端覆盖。
- **bar 进入过渡**：`.turn-status-bar` 补 `fade-in + translateY` 0.2s。

## Capabilities

### New Capabilities
- `web-post-send-feedback`：web 提交消息后给出即时反馈（乐观回显 + 即时 turn-bar），并补全 PTY 模式的 running 状态信号与端到端失败回退，覆盖到模型首个响应事件到达前。

### Modified Capabilities
- `stream-protocol`（隐含）：PTY session 在写 stdin 时补发 `session_status=running`、写 stdin 失败发 `error`——补全既有 session_status 事件在 web 模式的发送时机（不改事件 schema）。

## Impact

- `internal/session/manager.go` — PTY 写 stdin 分支补发 running；写 stdin 失败回退 error；评估 running 超时保护。
- `web/src/views/SessionDetail.vue` — `awaitingStart` + 乐观 push + turn-bar `v-if`/过渡 + 失败回退。
- `web/src/composables/useWebSocket.ts` — `send` 返回值/错误回调（L1）+ ack 超时（L2）。
- `relay/src/router.ts`（或 `server.ts`）— `user_message` ack/nack（L2）。
- 复用现有动效：`MessageUser` 的 `fade-in`、`status-dot.working` 的 `pulse-green`、`turnElapsed`、`MessageAgent` 的 `blink-cursor`——不新增动效资源。
