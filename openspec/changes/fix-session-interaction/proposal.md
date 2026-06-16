## Why

Web 客户端在支持 agent 内置命令/skills 后，遗留 3 个 session 交互问题，阻塞 Web 完整可用：(1) **terminal session**（终端开的 claude）发 Claude Code 内置命令（/model /compact）无响应；(2) **Web 新建 session** 发内置命令无响应；(3) 会话列表**切换会话时对话内容串/加载不出来**，刷新后单独打开某一会话正常。

探索定位的根因方向：
- 命令反馈存在两条捕获路径——**daemon 路径**（`readOutput` 捕获 stdout stream-json → adapter → command_receipt，已验证工作）与 **terminal 路径**（`sendToIdleTerminal` 丢弃 stdout，依赖 JSONL tailer）。实测确认 `-p --resume` 会把 local_command 写进 JSONL（两条 entry：命令名 + `<local-command-stdout>`），tailer→`ParseJSONLLine` 链路存在，但 terminal 路径实际不工作——疑似 tailer 未读到/转发，且 JSONL 路径的 command_receipt **缺命令名**（无 stream-json 路径的 `pendingCmd` 跟踪）。tailer 还是 1 秒轮询，有延迟。
- 切换竞态：SessionDetail **完全没有 `replay_end` 监听、没有 `isLoading` 状态、没有 replay 请求去重**（relay 在 `router.ts` 发了 `replay_end`，前端没接），快速切换时多个 replay 并发 → 内容串。

## What Changes

- **统一 terminal session 命令反馈为 stdout 捕获**：`sendToIdleTerminal` 改用 `StdoutPipe` + adapter 解析（与 daemon/CreateSession/SendMessage 路径统一），不再依赖 JSONL tailer 转发命令反馈。adapter 的 `pendingCmd` 提供命令名（修复 JSONL 路径 Command 名缺失）。需处理与 tailer 的事件去重（普通消息仍走 tailer，命令反馈走 stdout，避免双发）。
- **修复新建 session 命令**：诊断新建 session 发命令无响应的具体场景（pending-id 窗口期发命令 / 首条消息即命令时无 `--resume` / `list_commands` 命令补全未返回），按实际场景修复。
- **修复会话切换竞态**：SessionDetail 新增 `replay_end` 监听 + `isLoading` 状态 + replay 请求序号（reqId），切换时只接受最新 reqId 的 `replay_batch`/`replay_end`，丢弃 stale，消除内容串与加载卡死。

## Capabilities

### New Capabilities
（无——均为既有能力的路径/状态修复）

### Modified Capabilities
- `command-execution-feedback`：terminal session 的命令反馈捕获路径从「JSONL tailer 转发」改为「stdout stream-json 统一捕获」，command_receipt 携带命令名
- `session-lifecycle`：会话切换的 replay 竞态处理——relay `replay_end` 必须被消费、客户端用 replay 请求序号去重 stale batch、loading 状态正确收尾

## Impact

- **Daemon `internal/session/manager.go`**：`sendToIdleTerminal` 改 stdout 捕获 + adapter；与 tailer 的事件去重逻辑
- **Daemon `internal/adapter/claude.go`**：adapter 复用（已有 `convertSystem`/`convertAssistant` + `pendingCmd`），可能补 terminal 路径的命令名提取
- **Web `web/src/views/SessionDetail.vue`**：`replay_end` 监听 + `isLoading` + replay reqId + 切换时序；`watch(sessionId)` 配合 reqId
- **Web 新建 session 命令诊断**：`NewSessionDialog.vue` / `SessionDetail.vue` 发命令时机，daemon `CreateSession`/`SendMessage` 对新建 session 首命令的处理
- **可能涉及 `internal/watcher/tailer.go`**：若统一 stdout 捕获后 tailer 不再负责命令反馈，需明确 tailer 的职责边界（仅普通消息 + 标题）
