## 1. daemon 补发 running（B）
- [x] manager.go PTY 写 stdin 分支（937 后）发 `session_status=running`
- [x] 写 stdin 失败（940 err）回退：发 `session_status=error` + `ps.Status=Error`
- [x] 评估 running 超时保护：已由 watchdogBusy 覆盖（manager.go:492 启动 / 512 实现，监控 StatusRunning + JSONL 5min 无活动→回 idle 通知 web），无需额外代码
- [ ] 验证 running→agent_text→completed 闭环；连续消息幂等
- [x] iOS 端确认：已消费 session_status running（SessionDetailViewModel.isExecuting = ["running","busy"]），B 自动生效，零改动

## 2. 乐观回显用户消息（C）
- [x] `sendMessage` 乐观 push user_text 气泡（nextId('u')）
- [x] 验证 isDuplicate 去重：processEvent user_text 分支已用 isDuplicate（乐观气泡 content 命中即跳过），测试无回归
- [x] handleLocalCommand 路径未改，测试无回归

## 3. awaitingStart 瞬时状态（A）
- [x] 新增 `awaitingStart` ref，`sendMessage` 置 true
- [x] `onEvent('session_status')` running/busy/waiting → false
- [x] `onEvent('agent_text')` 首个文本 → false（兜底）
- [x] `watch(sessionId)` reset 为 false
- [x] turn-bar `v-if` 加 `awaitingStart` + 工作中分支渲染

## 4. 失败检测 L1（前端 send 回调）
- [x] `useWebSocket.send` 返回 boolean + 捕获 ws.send 异常
- [x] 评估：复用现有 connected/isDisconnected + send 返回值覆盖同步失败；onclose 不触发回退（断线≠失败，避免误伤已成功消息），端到端由 L2 ack 处理
- [x] `sendMessage` 失败 → 回退乐观气泡 + 清 awaitingStart + 提示

## 5. 失败检测 L2（relay ack）
- [x] web `user_message` 带 `msg_id`
- [x] relay 收到：daemon 在线 → 转发 + 回 ack；离线 → 回 nack
- [x] web ack 超时（如 3s）→ 回退
- [x] router.ts 实现 ack/nack 路由

## 6. bar 进入过渡
- [x] `.turn-status-bar` 加 bar-in 0.2s（fade-in + translateY，新 @keyframes bar-in）

## 7. 验证
- [ ] 本地 docker：发送 → 气泡+bar 立即出现 → running 到达无缝 → completed 闭环
- [ ] 三种失败回退：断网（L1）/ daemon 离线（L2 nack）/ claude 退出（B error）
- [ ] 跨端：其他 web / iOS 实例正常收 user_text + running
- [ ] PTY 交互模式 + --resume 模式分别验证（--resume 不受 B 影响，仍正常）
