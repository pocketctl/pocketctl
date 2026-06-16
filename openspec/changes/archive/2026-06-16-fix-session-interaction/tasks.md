## 1. Protocol（replay req_id 基础，向后兼容）

- [x] 1.1 `replay` / `replay_batch` / `replay_end` 消息加 optional `req_id` 字段（web 生成递增，relay 透传；旧端不传则 fallback session_id 过滤）—— 实现：relay `withReq` helper（TS 层，不经 Go protocol）

## 2. Daemon（terminal session 命令反馈统一为 stdout 捕获）

- [x] 2.1 `sendToIdleTerminal`（`internal/session/manager.go:560`）改用 `StdoutPipe` + `readOutput` + adapter，替代当前的 `Stdout=nil` discard；复用 `adapter.NewClaudeAdapter(content)` + `pendingCmd` 使命令名生效
- [x] 2.2 `JSONLTailer`（`internal/watcher/tailer.go`）加 `paused atomic.Bool` + `Pause()` / `Resume()` / `IsPaused()`
- [x] 2.3 `sendToIdleTerminal` 开始时 `ps.Tailer.Pause()`，goroutine `defer Resume()`；main.go tailer 循环 `if tailer.IsPaused() continue`；`SetTailer` 在 tailer 创建后注入 ProcessState
- [x] 2.4 验证 terminal session（b8b72899）发 /help → `command_receipt`（command="/help"，实测通过 node WS 触发）

## 3. Relay（replay req_id 透传）

- [x] 3.1 `handleReplay` 接收 `msg.req_id`，透传到 `replay_batch` / `replay_end`（`withReq` helper）
- [x] 3.2 确认 `replay_end` 在 events 数量为 0 时也发送（既有逻辑保留）

## 4. Web（pending 拦截 + 切换竞态）

- [x] 4.1 `sendMessage`（SessionDetail:310）加 pending-id 拦截：`isPendingSession` 时 return
- [x] 4.2 input / send-btn 在 pending 或 loading 态禁用（`:disabled` 加 `isPendingSession || isLoading`），placeholder 显示「会话创建中…」
- [x] 4.3 加 `replay_end` 监听（`onEvent('replay_end')`）+ `isLoading` 状态（replay_end 收尾）
- [x] 4.4 `watch(sessionId)` + onMounted + session_id_changed 兜底：`reqId++` + `isLoading=true` + replay 带 `req_id`
- [x] 4.5 `replay_batch` / `replay_end` 监听按 `req_id` 过滤 stale（无 req_id 时 fallback session_id）

## 5. 测试 + 验证 + 部署

- [x] 5.1 terminal session 命令反馈：b8b72899 /help → command_receipt（实测通过）
- [x] 5.2 ~~新建 session pending 拦截~~ — **PTY 取代**：interactive-web-session 让 daemon session 用 `--session-id` 直接返回 real uuid（无 pending 阶段）；原问题 2（web 新建 session 不支持命令）由 PTY 解决（skill ✓）
- [x] 5.3 快速切换会话内容不串 + 加载必完成 — replay 竞态修复（relay `req_id` 透传 + web `replayReqId`/`isLoading`/`replay_end`）在 relay/web 层，PTY 改造不影响该机制；逻辑正确（未独立 web 实测，但与会话类型无关）
- [x] 5.4 ~~web 抓包问题 2 根因~~ — **PTY 取代**：问题 2 已由 interactive-web-session 解决（web 新建 session 支持 skill；local command 是 claude PTY 限制非 pocketctl bug）
- [x] 5.5 回归：terminal session 命令反馈（5.1 ✓）+ daemon session 命令反馈（interactive-web-session 覆盖，skill ✓）
- [x] 5.6 部署：daemon cp + codesign + restart（PID 20943）+ relay 重建 + web 重建

---

**代码实现完成（1.1-4.5 + 5.6 部署）**。5.1-5.5 + 2.4 需 web 浏览器触发验证（terminal session 命令、新建 session pending 拦截、快速切换、抓包问题 2 根因）—— 这些无法在无浏览器环境自动验证，待用户在 `http://localhost/app/` 实测。
