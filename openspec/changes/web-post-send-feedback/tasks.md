## 1. daemon 补发 running（B）
- [ ] manager.go PTY 写 stdin 分支（937 后）发 `session_status=running`
- [ ] 写 stdin 失败（940 err）回退：发 `session_status=error` + `ps.Status=Error`
- [ ] 评估 running 超时保护（claude 卡死回退），定方案
- [ ] 验证 running→agent_text→completed 闭环；连续消息幂等
- [ ] iOS 端确认 running 反馈同步生效

## 2. 乐观回显用户消息（C）
- [ ] `sendMessage` 乐观 push user_text 气泡（nextId('u')）
- [ ] 验证 relay 回传 `isDuplicate` 正确去重
- [ ] `handleLocalCommand` 路径不受影响

## 3. awaitingStart 瞬时状态（A）
- [ ] 新增 `awaitingStart` ref，`sendMessage` 置 true
- [ ] `onEvent('session_status')` running/busy/waiting → false
- [ ] `onEvent('agent_text')` 首个文本 → false（兜底）
- [ ] `watch(sessionId)` reset 为 false
- [ ] turn-bar `v-if` 加 `awaitingStart` + 工作中分支渲染

## 4. 失败检测 L1（前端 send 回调）
- [ ] `useWebSocket.send` 返回 boolean + 捕获 ws.send 异常
- [ ] 暴露 ws `onerror`/`onclose` 失败信号给 SessionDetail
- [ ] `sendMessage` 失败 → 回退乐观气泡 + 清 awaitingStart + 提示

## 5. 失败检测 L2（relay ack）
- [ ] web `user_message` 带 `msg_id`
- [ ] relay 收到：daemon 在线 → 转发 + 回 ack；离线 → 回 nack
- [ ] web ack 超时（如 3s）→ 回退
- [ ] router.ts/server.ts 实现 ack/nack 路由

## 6. bar 进入过渡
- [ ] `.turn-status-bar` 加 fade-in / translateY 0.2s（复用 `@keyframes fade-in`）

## 7. 验证
- [ ] 本地 docker：发送 → 气泡+bar 立即出现 → running 到达无缝 → completed 闭环
- [ ] 三种失败回退：断网（L1）/ daemon 离线（L2 nack）/ claude 退出（B error）
- [ ] 跨端：其他 web / iOS 实例正常收 user_text + running
- [ ] PTY 交互模式 + --resume 模式分别验证（--resume 不受 B 影响，仍正常）
