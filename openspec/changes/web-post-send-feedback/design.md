## 根因（架构层 + 表层）

### 架构层：PTY 模式不发 running
web/daemon session 用 PTY 交互模式（manager.go:336）。daemon 把用户消息写进常驻 claude 的 PTY stdin（manager.go:940），但写 stdin 时只发 `user_text`（931）+ 设内部 `ps.Status=Running`（937），**不发 `session_status=running` 事件**。adapter 又只在 `result` 发 `Completed`（claude_jsonl.go:402）。

→ web 在整个模型处理期间收不到 running，`isExecuting` 始终 false，`turn-status-bar` 的「工作中●+计时」**从不显示**，只有 completed 时的「✓已完成」。对照 --resume 模式（manager.go:1094 发 running）bar 正常——这套 bar 本是为 --resume 设计的，PTY 路径漏了 running。

### 表层：sendMessage 纯事件驱动
- 不乐观 push 用户消息（回显等 relay 回传 user_text，~50–300ms）
- 不立即给反馈（bar 绑 isExecuting 等 running 事件）
- `startTurnTimer` 已调用（663），被 `v-if=isExecuting` 挡住，计时器白走

## 方案

### B：daemon 补发 running（补架构缺口）
manager.go PTY 写 stdin 分支（923-948）改造：
```
发 user_text（931，已有）
设 ps.Status=Running（937，已有）
【B 新增】发 session_status=running                 ← 补缺口
写 PTY stdin（940，已有）
  └─【B 新增】写失败 → 发 session_status=error + ps.Status=Error + return err
```
效果：running（B 发）→ agent_text 流式 → completed（adapter 已发）形成闭环，turn-bar 整段点亮；iOS 端同步受益。

### A：前端 awaitingStart（填往返延迟）
B 的 running 到达 web 需 ~100–300ms 往返。A 填这段：
- `awaitingStart` ref，`sendMessage` 置 true
- 清除：收 `session_status=running`/busy/waiting，或首个 `agent_text`（兜底）
- bar `v-if` 加 `awaitingStart`；`isExecuting || awaitingStart` 渲染工作中分支
- 会话切换 reset

### C：乐观回显用户消息
`sendMessage` push user_text 气泡，relay 回传 `isDuplicate` 去重（抄 `handleLocalCommand` 685 模式）。

### 失败检测：L1 + L2 同步
端到端失败覆盖，三层各管一段：

| 层 | 检测机制 | 覆盖的失败 | 落点 |
|---|---|---|---|
| **L1 传输层** | ws `onerror`/`onclose` + `send` 返回值 | web↔relay 断（断网、ws 关闭） | useWebSocket |
| **L2 应用层** | relay 对 user_message 回 ack/nack + 超时 | relay↔daemon 链路（daemon 离线） | router.ts + useWebSocket |
| **B 写 stdin** | daemon 写 stdin 失败发 error | claude 进程已退 | manager.go |

任一触发 → 移除乐观气泡 + 清 `awaitingStart` + 提示「发送失败」。

### bar 进入过渡
`.turn-status-bar { animation: fade-in 0.2s ease; }`（复用现有 `@keyframes fade-in`，可叠加 `translateY(4px)`）。

## 目标时序（B+A+C+L1/L2 实现后）
```
T0 sendMessage:
  乐观 push 用户气泡（C）+ awaitingStart=true（A）+ startTurnTimer
  ws.send(user_message, msg_id)        ← L1 立即知是否入队失败
  → 用户气泡 fade-in + bar ●工作中 0:00 立即出现

T1 relay 收到 → 转发 daemon → 回 ack   ← L2（daemon 离线则 nack；ack 超时回退）

T2 daemon 写 PTY stdin → 发 running（B） ← ~100–300ms
  web 收 running → awaitingStart 清除，isExecuting=true 接管

T3 agent_text 流式（blink-cursor）
T4 completed（adapter）→ bar ✓已完成
```

## 设计决策

- **为何 A+B 都要**：B 补架构缺口让 running→completed 闭环（整段反馈 + iOS 受益）；但 B 的 running 有 ~300ms 往返延迟，A 填这段即时反馈。互补，不冲突。
- **为何 L1+L2 同步而非递进**：L1 只覆盖 ws 断（web↔relay），覆盖不到「ws 连着但 daemon 离线」；L2 补 relay↔daemon 链路。同步上才能端到端覆盖主要失败点，不留「乐观气泡假成功」的窗口。
- **为何用瞬时 `awaitingStart` 而非置 `status='running'`**：`status` 是会话语义（事件权威驱动，replay/跨端依赖），独立 flag 避免污染。
- **为何不做 typing dots / 分阶段文案**：与 turn-bar 设计语言冲突；session_status 语义不足以支撑稳定分阶段。

## 边界与风险

- ~~running 卡住不回退~~：**已由 watchdogBusy 覆盖**（task 3 评估）。manager.go:492 在 PTY session 启动时起 watchdogBusy，监控 `StatusRunning`（行 530/555），JSONL 5min 无活动 → 强制回 idle + 通知 web。B 发的 running 同样受保护，无需额外超时代码。
- **连续消息**：每条都发 running，幂等无害。
- **L2 ack 语义边界**：ack 只到「relay 转发给 daemon」层（daemon 离线 relay 知道 → nack）；daemon 写 stdin 失败由 B 的 error 覆盖。ack 不保证 claude 真处理（那由后续 agent_text/completed 体现）。
- **多端一致性**：乐观气泡仅 origin 显示；relay 广播 user_text 给其他端。origin 不重复（relay 不回弹 origin 约定 + `isDuplicate` 双保险），需实测确认与 `local_command_log` 行为一致。

## 非目标
- typing dots 动画 / 分阶段文案 / 移动端单独动效设计

## 复用动效清单
| 动效 | 用途 | 来源 |
|---|---|---|
| fade-in 0.2s | 用户气泡乐观出现 / bar 进入 | MessageUser:18 / @keyframes fade-in |
| pulse-green 1.5s | bar ● 圆点 | status-dot.working |
| 计时器走秒 | bar 0:00→0:01 | turnElapsed |
| blink-cursor | 模型流式回复 | MessageAgent |
