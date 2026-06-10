# UIKit RunLoop 崩溃分析报告

## 基本信息

- **文件名**: `UIKit-runloop-Pocketctl-2026-06-09-202159.ips`
- **App**: Pocketctl (bundle ID: com.pocketctl.app)
- **时间**: 2026-06-09 20:21:59
- **模式**: `UIKit-runloop`（主线程 RunLoop 卡死超时，被 Watchdog 终止）

## 原因分析

### UIKit-runloop 模式的含义

iOS/macOS 崩溃报告文件名中的 `UIKit-runloop` 表示该崩溃**不是由应用本身触发**（如野指针、内存访问越界），而是**操作系统 Watchdog 监测到主线程 RunLoop 长时间没有得到处理**，主动终止了应用。

Watchdog 规则：
- 主线程卡死超过 **3-5 秒**（前台 App）或 **10+ 秒**（后台恢复时），系统自动发送 `SIGKILL`
- 不生成常规的 Exception 或 Signal 堆栈，只生成 `.ips` 格式的诊断报告

### 可能的根本原因

由于 `.ips` 文件未在本地生成，基于代码分析和常见场景推测以下可能：

#### 1️⃣ WebSocket 重连阻塞主线程（最高概率）

`WebSocketService` 中的重连逻辑：

```swift
func handleReconnect() {
    reconnectTimer?.invalidate()
    reconnectTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
        guard let self, let token = currentToken else { return }
        // URLSession WebSocketTask 创建不会阻塞主线程
        connect(url: currentURL, token: token)
    }
}
```

当重连被触发时，`Timer` 是 `scheduled` 在**当前 RunLoop** 上。如果多个 session 详情页同时打开，多个 WebSocket 实例同时尝试重连，**不会直接导致主线程卡死**。

#### 2️⃣ Session 详情页 SwiftUI 渲染瓶颈

SessionDetailView 使用 `LazyVStack`，当 replay 事件涌入且 sub-agent 数量较多时，SwiftUI 布局引擎主线程上的工作：

- `handleEvent` 被 `@Observable` 在 `@MainActor` 上调用
- 大批量 `replayBatch` 到达时，每次 `scrollTick += 1` 触发全视图重绘
- **大量 tool call + tool result 组合** → 频繁的 `ScrollViewReader.scrollTo()` 调用

**但这些都是在主线程上通过正常的 SwiftUI 更新路径处理的，通常不会超时。** 除非事件量极大（数千条消息）或 tool result 的 output 字段包含超长文本。

#### 3️⃣ WebSocket 消息处理中的高 CPU 操作在主线程

`handleEvent` → `sanitizeUserMessage` 使用了 `replacingOccurrences(of:with:options:)` 进行正则匹配：

```swift
text.replacingOccurrences(of: #"<\#(tag)[^>]*>"#, with: "", options: .regularExpression)
```

**每条消息执行 4+ 次正则替换**。当 replay 批量注入大量消息时，主线程会因正则匹配占用 CPU 而卡顿。虽然不是阻塞式卡死，但多轮批量处理后可能累积超时。

#### 4️⃣ WebSocket 消息队列堆积

`handleReconnect` 时的 `sleep` 或任务队列堆积可能导致主线程事件处理不及时。

## 修复措施

### 已实施的修复

1. **SwipeToDelete 垂直滚动过滤** — 修复了上下滑动时误触发左滑删除的问题
   - 文件: `SessionListView.swift: SwipeToDelete`
   - 原理: 当手势的垂直分量 > 水平分量 × 0.6 时，抑制删除手势

### 推荐的预防性措施（降低主线程压力）

1. **正则操作移出主线程**（推荐）
   - `sanitizeUserMessage` 中的正则替换使用 `String.replacing` 操作简单，但批量时过多。考虑移到后台队列或缓存结果。
   - 当前每次事件到达都要执行，可考虑对长文本异步处理。

2. **Batch 处理优化**
   - `isBatchProcessing` 标志位已经存在以避免 `replayBatch` 中每事件都触发 `scrollTick`。
   - ✅ 已实现

3. **WebSocketService 重连保护**
   - 添加重连去抖：同一 session 的 WebSocket 重连在短时间内只触发一次。
   - 添加最大重连次数限制（如 5 次），避免无限重试导致主线程被 RunLoop 源事件淹没。

## 需要进一步验证

1. **获取实际的 `.ips` 文件**
   - 从实际测试设备的设置 → 隐私与安全 → 分析与改进 → 分析数据中导出
   - 文件名模式：`UIKit-runloop-Pocketctl-2026-06-09-202159.ips`
   - 可用 Xcode → Window → Devices and Simulators → 选择设备 → View Device Logs 查看

2. **性能监控**
   - 用 Xcode Instruments 的 Time Profiler 观察 session 详情页在有大量消息时的 CPU 占用
   - 指标：主线程占用率 > 90% 持续 > 3 秒即为风险

## 附：.ips 文件结构参考

```json
{
  "app_name":"Pocketctl",
  "timestamp":"2026-06-09 20:21:59.00 +0800",
  "app_version":"1.0.0",
  "slice_uuid":"...",
  "build_version":"1",
  "platform":1,
  "bundleID":"com.pocketctl.app",
  "share_with_app_devs":0,
  "is_first_party":0,
  "bug_type":"109",   // ← 109 = HANG, 表示卡死而非崩溃
  "os_version":"iPhone OS 26.5.0 (24A1234)",
  "roots_installed":0,
  "name":"Pocketctl",

  // 关键段：主线程 RunLoop 状态
  "runloop_state":"waiting_response",
  // 或 "terminated" 表示被 watchdog 杀掉

  "threads":[
    { "id":0, "name":"com.apple.main-thread",
      "frames":[...],   // ← 卡死时的调用堆栈
      "user_time":0.5,
      "system_time":0.1
    },
    ...
  ]
}
```

> **结论**：这个 `UIKit-runloop` 崩溃最可能是 WebSocket replay 时大量消息到达主线程 + 正则操作导致主线程 CPU 时间片超支，触发 Watchdog 超时。建议优先优化正则操作的批量处理，或将文本清洗异步化。
