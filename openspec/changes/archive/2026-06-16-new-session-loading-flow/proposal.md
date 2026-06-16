## Why

Web 客户端新建会话存在三个问题：(1) 创建后立即跳转到的 URL 是临时 `pending-xxx` ID，会话详情页永远卡在 "Pending" 状态；(2) 缺少设计稿要求的 loading（"正在创建…"/"正在连接主机…"）和失败提示；(3) 当前 `send()` 不带 daemon_id，多主机用户会创建到错误机器，且 15s 超时后不清理已启动的 claude 子进程，造成 token 烧费和资源泄漏。

真实 session_id 由 claude 子进程的 stdout 产出（不可控的首行延迟），Daemon 无法同步返回。因此采用异步事件方案：复用系统已有的 `session_id_changed` 事件，前端在收到真实 ID 后才跳转，既还原设计稿的 loading→成功/失败体验，又不阻塞 Daemon 命令处理主循环。

## What Changes

- **Web 新增 loading 状态机**：新建会话弹窗按钮三态（IDLE → SUBMITTING "正在创建…" → CONNECTING "正在连接主机…" → SUCCESS 跳转 / FAILED 错误 banner），复用设计稿的 `.is-loading` / `.btn-loading` spinner / `.modal-error.visible` 样式
- **Web 延迟跳转**：`session_created`(pending) 不再跳转，只切 CONNECTING 态；收到 `session_id_changed`(real) 才 `router.replace` 到真实 ID
- **Web 失败提示**：新增 `.modal-error` 红色 banner，覆盖无 CLI / cwd 无效 / 启动失败 / 超时 / 主机离线五种场景
- **SessionDetail 兜底**：监听 `session_id_changed`，当 URL 仍是 pending 时 `router.replace` 到真实 ID（覆盖刷新竞态）
- **send() 带 daemon_id**：Relay 用精确 daemon 而非"第一个同用户在线 daemon"选主机
- **超时清理**：前端超时发 `abort_create`，Daemon kill claude 子进程并清理 pending session（修复 token 泄漏）
- **离线失败信号**：daemon 中途离线时，Relay 向发起方发 `session_create_failed`
- **Daemon 失败原因码**：`CreateSession` 启动失败改发 `session_create_failed`（带 `no_cli` / `bad_cwd` / `start_fail` 原因码），前端按码查文案表

## Capabilities

### New Capabilities
- `session-create-flow`: 新建会话的完整前端 loading 状态机和失败处理，还原设计稿 dashboard.html / session-detail.html 的交互

### Modified Capabilities
- `session-lifecycle`: session_create 接口要求带 daemon_id 精确路由；新增 abort_create / session_create_failed 消息类型；daemon 离线时清理 pending 创建请求

## Impact

- **Web (`web/src/components/NewSessionDialog.vue`)**: 重写 startSession 为状态机；send 带 daemon_id；监听 session_id_changed；超时发 abort_create；loading/error UI
- **Web (`web/src/views/SessionDetail.vue`)**: 新增 session_id_changed 监听做兜底 router.replace
- **Web (设计稿 CSS)**: 引入 `.is-loading` / `.btn-loading` spinner / `.modal-error` banner 类名体系
- **Relay (`relay/src/router.ts`)**: session_create 用 msg.daemon_id 选 daemon（校验同用户）；session_id_changed 主动补发 originClient；daemon 离线发 session_create_failed；新增 abort_create 转发
- **Daemon (`cmd/pocketctl/main.go`)**: 新增 abort_create case；CreateSession 失败改发 session_create_failed
- **Daemon (`internal/session/manager.go`)**: 新增 AbortSession(id) 方法
- **Protocol (`internal/protocol/types.go`)**: 新增 abort_create / session_create_failed 消息类型
